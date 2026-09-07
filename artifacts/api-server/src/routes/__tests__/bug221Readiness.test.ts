// BUG-221 — readiness must actually be able to fail, and liveness must not.
//
// Drives the LIVE handler from createHealthRouter with an injected prisma whose
// $queryRaw throws / hangs / succeeds. Nothing is restated: the statuses come
// out of the real route.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { createHealthRouter } from "../health";

async function spinUp(queryRaw: () => Promise<unknown>) {
  const app: Express = express();
  app.use(createHealthRouter({ prisma: { $queryRaw: queryRaw } as never }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("BUG-221 — liveness and readiness are separate gates", () => {
  it("readiness returns 503 when the database query throws", async () => {
    const h = await spinUp(async () => {
      throw new Error("Can't reach database server at `127.0.0.1:59999`");
    });
    try {
      const res = await fetch(`${h.baseUrl}/readyz`);
      assert.equal(
        res.status,
        503,
        "readiness must fail when the DB is unreachable — a gate that cannot fail is BUG-221",
      );
      const body = (await res.json()) as { status: string; code: string };
      assert.equal(body.status, "not_ready");
      assert.equal(body.code, "db_unavailable");
      assert.equal(res.headers.get("retry-after"), "2");
    } finally {
      await h.close();
    }
  });

  it("readiness returns 200 when the database answers", async () => {
    // Non-vacuity: proves the 503 above came from the failure, not from a
    // route that always 503s.
    const h = await spinUp(async () => [{ "?column?": 1 }]);
    try {
      const res = await fetch(`${h.baseUrl}/readyz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string; latencyMs: number };
      assert.equal(body.status, "ready");
      assert.equal(typeof body.latencyMs, "number");
    } finally {
      await h.close();
    }
  });

  it("readiness fails closed when the query hangs past the timeout", async () => {
    const h = await spinUp(() => new Promise(() => {}));
    try {
      const started = Date.now();
      const res = await fetch(`${h.baseUrl}/readyz`);
      const elapsed = Date.now() - started;
      assert.equal(res.status, 503, "a hung query must answer, not hold the probe open");
      assert.ok(
        elapsed < 10_000,
        `readiness took ${elapsed}ms — the bound did not fire`,
      );
    } finally {
      await h.close();
    }
  });

  it("LIVENESS stays 200 even when the database is unreachable", async () => {
    // The other half of the ruling, and the one a careless fix breaks: a
    // liveness probe that fails on a DB blip restarts a healthy container.
    const h = await spinUp(async () => {
      throw new Error("db down");
    });
    try {
      const res = await fetch(`${h.baseUrl}/healthz`);
      assert.equal(
        res.status,
        200,
        "liveness must NOT depend on the database — see the note in health.ts",
      );
    } finally {
      await h.close();
    }
  });
});
