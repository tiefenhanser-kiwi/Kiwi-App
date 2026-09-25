// Row 13 "Test Kitchen" · Block 1 (D-WS9-259) — POST /api/internal/guest/sweep.
//
// The same OIDC shape as the image drain, so the same four things are pinned:
// unconfigured → 404 for everyone (fail closed), no/bad token → 401 and
// NOTHING IS DELETED, JWKS down → 503 + Retry-After, a good token → 200 with
// the two counts. Plus the sweep's own rule: the two horizons are different
// predicates and they are reported separately.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import express, { type Express } from "express";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

import type { JwksFetch } from "../../lib/googleOidc";
import {
  createInternalRouter,
  ENV_GUEST_SWEEP_OIDC_AUDIENCE,
  ENV_GUEST_SWEEP_OIDC_EMAIL,
  GUEST_CLAIMED_SWEEP_DAYS,
  GUEST_UNCLAIMED_SWEEP_DAYS,
} from "../internal";

const AUD = "https://kiwi-api.test/api/internal/guest/sweep";
const SA = "kiwi-guest-sweep@kiwi-prod.iam.gserviceaccount.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };

function token(claims: Record<string, unknown> = {}) {
  return jwt.sign(
    {
      iss: "https://accounts.google.com",
      aud: AUD,
      email: SA,
      email_verified: true,
      ...claims,
    },
    privateKey,
    { algorithm: "RS256", keyid: "k1", expiresIn: "5m" },
  );
}

async function spinUp(
  opts: { env?: NodeJS.ProcessEnv; jwksDown?: boolean } = {},
) {
  const deletes: Array<Record<string, unknown>> = [];
  const prisma = {
    guestSession: {
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        deletes.push(where);
        // Distinguishable counts so the response cannot swap them unnoticed.
        return { count: "claimedAt" in where && where.claimedAt !== null ? 3 : 7 };
      },
    },
  };
  const jwksFetch: JwksFetch = async () => ({
    ok: !opts.jwksDown,
    status: opts.jwksDown ? 503 : 200,
    headers: { get: () => null },
    json: async () => ({
      keys: [
        { kty: "RSA", alg: "RS256", use: "sig", kid: "k1", n: jwk.n, e: jwk.e },
      ],
    }),
  });
  const app: Express = express();
  app.use(express.json());
  app.use(
    "/api",
    createInternalRouter({
      env:
        opts.env ?? {
          [ENV_GUEST_SWEEP_OIDC_EMAIL]: SA,
          [ENV_GUEST_SWEEP_OIDC_AUDIENCE]: AUD,
        },
      jwksFetch,
      drainDeps: async () => {
        throw new Error("the drain must not run");
      },
      prisma: prisma as never,
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    post: (auth?: string) =>
      fetch(`http://127.0.0.1:${port}/api/internal/guest/sweep`, {
        method: "POST",
        headers: auth ? { authorization: auth } : {},
      }),
    deletes: () => deletes,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("POST /api/internal/guest/sweep", () => {
  it("unconfigured (either var unset) → 404 for everyone, even a valid token", async () => {
    for (const env of [
      {},
      { [ENV_GUEST_SWEEP_OIDC_EMAIL]: SA },
      { [ENV_GUEST_SWEEP_OIDC_AUDIENCE]: AUD },
    ]) {
      const h = await spinUp({ env });
      try {
        assert.equal((await h.post(`Bearer ${token()}`)).status, 404);
        assert.equal(h.deletes().length, 0, "nothing is deleted");
      } finally {
        await h.close();
      }
    }
  });

  it("no / wrong-audience / wrong-email token → 401 and NOTHING is deleted", async () => {
    const h = await spinUp();
    try {
      assert.equal((await h.post()).status, 401);
      assert.equal((await h.post("Bearer nope")).status, 401);
      assert.equal(
        (await h.post(`Bearer ${token({ aud: "https://other.test/" })}`)).status,
        401,
      );
      assert.equal(
        (await h.post(`Bearer ${token({ email: "intruder@example.com" })}`))
          .status,
        401,
      );
      assert.equal(
        h.deletes().length,
        0,
        "a delete route that runs before it authorises is not a route, it is an incident",
      );
    } finally {
      await h.close();
    }
  });

  it("JWKS unreachable → 503 + Retry-After, not 401 and not a sweep", async () => {
    const h = await spinUp({ jwksDown: true });
    try {
      const res = await h.post(`Bearer ${token()}`);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "30");
      assert.equal(h.deletes().length, 0);
    } finally {
      await h.close();
    }
  });

  it("a good token → 200, two horizons, two separately-reported counts", async () => {
    const h = await spinUp();
    try {
      const res = await h.post(`Bearer ${token()}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        caller: string;
        unclaimedDeleted: number;
        claimedDeleted: number;
      };
      assert.equal(body.ok, true);
      assert.equal(body.caller, SA);
      // Not folded into a total: "unclaimed swept" IS the funnel's
      // abandonment number and a sum would lose it.
      assert.equal(body.unclaimedDeleted, 7);
      assert.equal(body.claimedDeleted, 3);

      const [unclaimed, claimed] = h.deletes();
      // The predicates read DIFFERENT columns, which is why they are two calls.
      assert.equal(unclaimed.claimedAt, null, "unclaimed sweep: claimedAt null");
      assert.ok("expiresAt" in unclaimed, "…and keyed on expiry");
      assert.ok("claimedAt" in claimed, "claimed sweep: keyed on the claim");
      assert.ok(!("expiresAt" in claimed), "…not on expiry");

      // The horizons are the ruled ones.
      const unclaimedCutoff = (unclaimed.expiresAt as { lt: Date }).lt.getTime();
      const claimedCutoff = (claimed.claimedAt as { lt: Date }).lt.getTime();
      const days = (ms: number) => Math.round((Date.now() - ms) / 86_400_000);
      assert.equal(days(unclaimedCutoff), GUEST_UNCLAIMED_SWEEP_DAYS);
      assert.equal(days(claimedCutoff), GUEST_CLAIMED_SWEEP_DAYS);
    } finally {
      await h.close();
    }
  });
});
