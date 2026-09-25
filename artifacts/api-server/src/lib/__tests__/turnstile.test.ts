// Row 13 "Test Kitchen" · Block 1 (D-WS9-262) — Cloudflare Turnstile.
//
//   unset            → pass through (the state the funnel is built in)
//   configured + bad → 403 bot_check_failed
//   verify timeout   → 403, FAIL CLOSED
//   transport error  → 403, FAIL CLOSED
//   a global IP      → no remoteip is sent
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import {
  verifyTurnstile,
  logTurnstileConfig,
  ENV_TURNSTILE_SECRET_KEY,
  TURNSTILE_VERIFY_URL,
  type TurnstileFetch,
} from "../turnstile";
import { createRequireTurnstile } from "../../middleware/turnstile";

const CONFIGURED = { [ENV_TURNSTILE_SECRET_KEY]: "0x-secret" };

function okFetch(success: boolean): TurnstileFetch {
  return async () => ({ ok: true, json: async () => ({ success }) });
}

describe("verifyTurnstile", () => {
  it("UNSET secret → passes through without calling Cloudflare at all", async () => {
    let called = 0;
    const verdict = await verifyTurnstile({
      token: undefined,
      env: {},
      fetchImpl: async () => {
        called++;
        return { ok: true, json: async () => ({ success: true }) };
      },
    });
    assert.deepEqual(verdict, { ok: true, disabled: true });
    assert.equal(called, 0, "an unconfigured check makes no outbound request");
  });

  it("configured: a good token passes, a rejected one does not", async () => {
    assert.deepEqual(
      await verifyTurnstile({ token: "t", env: CONFIGURED, fetchImpl: okFetch(true) }),
      { ok: true },
    );
    assert.deepEqual(
      await verifyTurnstile({ token: "t", env: CONFIGURED, fetchImpl: okFetch(false) }),
      { ok: false, reason: "rejected" },
    );
  });

  it("configured + NO token → missing_token, without an outbound call", async () => {
    let called = 0;
    const verdict = await verifyTurnstile({
      token: undefined,
      env: CONFIGURED,
      fetchImpl: async () => {
        called++;
        return { ok: true, json: async () => ({ success: true }) };
      },
    });
    assert.deepEqual(verdict, { ok: false, reason: "missing_token" });
    assert.equal(called, 0);
  });

  it("FAILS CLOSED on a timeout and on a transport error", async () => {
    // A verify call that never answers: the abort must produce a refusal, not
    // a hang and not a pass. This is the case that decides whether the bot
    // check is real when Cloudflare is slow.
    const hanging: TurnstileFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const timedOut = await verifyTurnstile({
      token: "t",
      env: CONFIGURED,
      fetchImpl: hanging,
      timeoutMs: 25,
    });
    assert.deepEqual(timedOut, { ok: false, reason: "timeout" });

    const threw = await verifyTurnstile({
      token: "t",
      env: CONFIGURED,
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    assert.deepEqual(threw, { ok: false, reason: "error" });

    const non200 = await verifyTurnstile({
      token: "t",
      env: CONFIGURED,
      fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    });
    assert.deepEqual(non200, { ok: false, reason: "error" });
  });

  it("does NOT send remoteip when the address is 'unknown'", async () => {
    // Behind Cloud Run with TRUST_PROXY_HOPS unset, every visitor shares one
    // address. Telling Cloudflare that is worse than telling it nothing.
    // Typed explicitly: tsc narrows a `let x = null` assigned only inside a
    // callback to `never` at the read site.
    let body: URLSearchParams | undefined;
    await verifyTurnstile({
      token: "t",
      remoteIp: "unknown",
      env: CONFIGURED,
      fetchImpl: async (url, init) => {
        assert.equal(url, TURNSTILE_VERIFY_URL);
        body = init.body;
        return { ok: true, json: async () => ({ success: true }) };
      },
    });
    assert.ok(body);
    assert.equal(body.get("remoteip"), null);
    assert.equal(body.get("response"), "t");
    assert.equal(body.get("secret"), "0x-secret");
  });

  it("the boot line names the state and never the key", () => {
    const infos: unknown[] = [];
    const warns: unknown[] = [];
    const log = {
      info: (obj: object, msg: string) => infos.push({ obj, msg }),
      warn: (obj: object, msg: string) => warns.push({ obj, msg }),
    } as never;

    assert.equal(logTurnstileConfig({}, log), false);
    assert.equal(warns.length, 1);

    assert.equal(logTurnstileConfig(CONFIGURED, log), true);
    const serialized = JSON.stringify(infos) + JSON.stringify(warns);
    assert.ok(!serialized.includes("0x-secret"), "TURNSTILE_SECRET_KEY leaked");
  });
});

describe("requireTurnstile (the middleware)", () => {
  async function spinUp(
    env: NodeJS.ProcessEnv,
    fetchImpl?: TurnstileFetch,
  ) {
    const app: Express = express();
    app.use(express.json());
    app.post(
      "/guest/session",
      createRequireTurnstile({ env, fetchImpl, timeoutMs: 25 }),
      (_req, res) => {
        res.status(201).json({ ok: true });
      },
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as { port: number };
    return {
      post: (body: unknown) =>
        fetch(`http://127.0.0.1:${port}/guest/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it("unset → 201; configured + bad token → 403 bot_check_failed", async () => {
    const open = await spinUp({});
    try {
      assert.equal((await open.post({})).status, 201);
    } finally {
      await open.close();
    }

    const closed = await spinUp(CONFIGURED, okFetch(false));
    try {
      const res = await closed.post({ turnstileToken: "bad" });
      assert.equal(res.status, 403);
      assert.equal(
        ((await res.json()) as { code: string }).code,
        "bot_check_failed",
      );
    } finally {
      await closed.close();
    }
  });

  it("a verify-endpoint timeout → 403, and the route body never runs", async () => {
    const hanging: TurnstileFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const h = await spinUp(CONFIGURED, hanging);
    try {
      const res = await h.post({ turnstileToken: "t" });
      assert.equal(res.status, 403, "fail closed, never open");
    } finally {
      await h.close();
    }
  });
});
