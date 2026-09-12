// BUG-257 — POST /me/email/verify-change must be rate limited.
//
// It is a token-spending POST with the same posture as its sibling
// /auth/password-reset/confirm (authLimiter, 10/min), and it was the one such
// route with no limiter in front of it. Drives the LIVE router with the
// PRODUCTION limiter (capacity 10, ~1/6 s refill), keyed on the socket peer.
//
// Every request carries a token that fails the schema (too short), so each
// stops at the 400 before any token verification or DB read — the assertion
// is only that the limiter runs FIRST, which is the property under test.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createMeRouter } from "../me";

const prisma = {} as unknown as never;

async function spinUp() {
  const app: Express = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const post = (baseUrl: string) =>
  fetch(`${baseUrl}/me/email/verify-change`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "short" }),
  });

describe("BUG-257 — verify-change is metered", () => {
  beforeEach(() => __clearRateLimitStoreForTests());

  it("returns 429 on the 11th request in a burst", async () => {
    const h = await spinUp();
    try {
      for (let i = 1; i <= 10; i++) {
        const res = await post(h.baseUrl);
        // Non-vacuity: the first ten must get THROUGH the limiter to the
        // handler's own 400. If they 429'd, the test would pass for the
        // wrong reason.
        assert.equal(res.status, 400, `request ${i} should reach the handler`);
      }
      const eleventh = await post(h.baseUrl);
      assert.equal(
        eleventh.status,
        429,
        "eleventh request must be rate limited — an unmetered verify-change is BUG-257",
      );
      assert.ok(eleventh.headers.get("retry-after"), "429 must carry Retry-After");
    } finally {
      await h.close();
    }
  });
});
