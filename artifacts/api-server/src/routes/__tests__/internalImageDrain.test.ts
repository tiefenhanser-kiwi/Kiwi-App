// Row 5 · Block 1c (D-WS9-248) — POST /api/internal/images/drain, driven
// through the live handler from createInternalRouter with every real
// dependency stubbed: the JWKS fetch serves a key generated here, the drain
// deps are an in-memory store + a stub OpenAI. Pinned: unconfigured → 404
// for everyone; no/bad token → 401 and the drain never runs; JWKS down →
// 503 + Retry-After; a good token → 200 with the tick's summary.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import express, { type Express } from "express";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

import type { JwksFetch } from "../../lib/googleOidc";
import type { ImageDrainDeps, ImageQueueStore } from "../../lib/images/imageQueue";
import { ImageStore } from "../../lib/images/imageStore";
import { createInternalRouter, ENV_IMAGE_DRAIN_OIDC_AUDIENCE, ENV_IMAGE_DRAIN_OIDC_EMAIL } from "../internal";

const AUD = "https://kiwi-api.test/api/internal/images/drain";
const SA = "kiwi-image-drain@kiwi-prod.iam.gserviceaccount.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };

function token(claims: Record<string, unknown> = {}) {
  return jwt.sign({ iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, ...claims }, privateKey, { algorithm: "RS256", keyid: "k1", expiresIn: "5m" });
}

async function spinUp(opts: { env?: NodeJS.ProcessEnv; jwksDown?: boolean } = {}) {
  let drains = 0;
  const store: ImageQueueStore = {
    claim: async () => ({ claimed: [], requeuedStuck: 0, failedOutIds: [], budget: { recentSends: 0, inFlight: 0, limit: 5 } }),
    loadSubjects: async () => [],
    markReady: async () => ({ forksStamped: 0 }),
    release: async () => "pending",
  };
  const drainDeps = async (): Promise<ImageDrainDeps> => {
    drains++;
    return { store, pipeline: { fetch: async () => { throw new Error("never"); }, generator: { apiKey: "sk" }, store: new ImageStore({ writer: { save: async () => {} }, bucket: "b" }) } };
  };
  const jwksFetch: JwksFetch = async () => ({
    ok: !opts.jwksDown,
    status: opts.jwksDown ? 503 : 200,
    headers: { get: () => null },
    json: async () => ({ keys: [{ kty: "RSA", alg: "RS256", use: "sig", kid: "k1", n: jwk.n, e: jwk.e }] }),
  });
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createInternalRouter({ env: opts.env ?? { [ENV_IMAGE_DRAIN_OIDC_EMAIL]: SA, [ENV_IMAGE_DRAIN_OIDC_AUDIENCE]: AUD }, jwksFetch, drainDeps, prisma: {} as never }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    post: (auth?: string) => fetch(`http://127.0.0.1:${port}/api/internal/images/drain`, { method: "POST", headers: auth ? { authorization: auth } : {} }),
    drains: () => drains,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("POST /api/internal/images/drain", () => {
  it("unconfigured (either var unset) → 404 for everyone, even a valid token", async () => {
    for (const env of [{}, { [ENV_IMAGE_DRAIN_OIDC_EMAIL]: SA }, { [ENV_IMAGE_DRAIN_OIDC_AUDIENCE]: AUD }]) {
      const h = await spinUp({ env });
      try {
        const res = await h.post(`Bearer ${token()}`);
        assert.equal(res.status, 404);
        assert.equal(h.drains(), 0);
      } finally {
        await h.close();
      }
    }
  });

  it("no token / a token for another audience / another email → 401, and the drain never runs", async () => {
    const h = await spinUp();
    try {
      assert.equal((await h.post()).status, 401);
      assert.equal((await h.post("Bearer nope")).status, 401);
      assert.equal((await h.post(`Bearer ${token({ aud: "https://other.test/" })}`)).status, 401);
      assert.equal((await h.post(`Bearer ${token({ email: "intruder@example.com" })}`)).status, 401);
      assert.equal((await h.post(`Basic abc`)).status, 401);
      assert.equal(h.drains(), 0);
    } finally {
      await h.close();
    }
  });

  it("JWKS unreachable → 503 + Retry-After (our problem, retryable), drain not run", async () => {
    const h = await spinUp({ jwksDown: true });
    try {
      const res = await h.post(`Bearer ${token()}`);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "30");
      assert.equal(h.drains(), 0);
    } finally {
      await h.close();
    }
  });

  it("a valid scheduler token → 200 with the tick summary and the caller's email", async () => {
    const h = await spinUp();
    try {
      const res = await h.post(`Bearer ${token()}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; caller: string; claimed: number; budget: { limit: number } };
      assert.equal(body.ok, true);
      assert.equal(body.caller, SA);
      assert.equal(body.claimed, 0);
      assert.equal(body.budget.limit, 5);
      assert.equal(h.drains(), 1);
    } finally {
      await h.close();
    }
  });
});
