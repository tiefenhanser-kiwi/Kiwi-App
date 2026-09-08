// BUG-222 — POST /plans/:id/generate-grocery-list must be rate limited.
//
// Drives the LIVE route. The limiter is exercised through the injected opts
// seam so the bucket can be drained deterministically instead of waiting on a
// real 5-minute refill; the KEY function and the mount point under test are the
// production ones either way.
//
// The stub prisma 404s the plan lookup, so every request stops at the first DB
// read: no AI call, no list generation, no write. That is fine for this guard —
// what is being asserted is that the limiter runs BEFORE any of that, which is
// exactly the property that makes it a cost ceiling.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createGroceryListsRouter } from "../groceryLists";
import { withSessionUser } from "./fixtures/sessionUserStub";

const prisma = {
  mealPlanInstance: { findFirst: async () => null },
} as unknown as never;

async function spinUp(capacity: number) {
  const app: Express = express();
  app.use(express.json());
  app.use(
    createGroceryListsRouter({
      prisma: withSessionUser(prisma) as never,
      generateLimiterOpts: { capacity, refillPerSec: 0 },
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const post = (baseUrl: string, token: string) =>
  fetch(`${baseUrl}/plans/11111111-1111-1111-1111-111111111111/generate-grocery-list`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
  });

describe("BUG-222 — the generate route is metered", () => {
  // The bucket store is module-global and its key is method:path:userId, which
  // is identical across these cases — so without this, case 2 inherits case 1's
  // drained bucket for the same user and fails for the wrong reason.
  beforeEach(() => __clearRateLimitStoreForTests());

  it("returns 429 once the bucket is empty", async () => {
    const h = await spinUp(2);
    try {
      const token = signToken("bug222-user-a");
      const first = await post(h.baseUrl, token);
      const second = await post(h.baseUrl, token);
      const third = await post(h.baseUrl, token);

      // Non-vacuity: the first two must get THROUGH the limiter and reach the
      // handler (404, plan not found). If they 429'd, the test would pass for
      // the wrong reason.
      assert.equal(first.status, 404, "first request should reach the handler");
      assert.equal(second.status, 404, "second request should reach the handler");
      assert.equal(
        third.status,
        429,
        "third request must be rate limited — an unmetered generate route is BUG-222",
      );
      assert.ok(third.headers.get("retry-after"), "429 must carry Retry-After");
    } finally {
      await h.close();
    }
  });

  it("buckets are per-user, so one caller cannot exhaust another's", async () => {
    // This is the property that makes the route immune to BUG-223's proxy
    // collapse: the key is userId, never the client address.
    const h = await spinUp(1);
    try {
      const a = signToken("bug222-user-a");
      const b = signToken("bug222-user-b");

      assert.equal((await post(h.baseUrl, a)).status, 404);
      assert.equal(
        (await post(h.baseUrl, a)).status,
        429,
        "user A's second call should be limited",
      );
      assert.equal(
        (await post(h.baseUrl, b)).status,
        404,
        "user B must have their own bucket — a shared key would 429 here",
      );
    } finally {
      await h.close();
    }
  });
});
