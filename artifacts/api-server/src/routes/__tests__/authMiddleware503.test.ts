// FIX-3 / BUG-103 + BUG-395 — the session guard's fail-closed 503 is retryable.
//
// requireAuth reads the revocation epoch from the database on every
// authenticated request (BUG-234) and fails CLOSED when that read throws. Its
// 503 carried no Retry-After and no code, so the client could not tell "the
// database is waking" from "the server is broken" — unlike errorHandler.ts's
// cold-DB 503, which carries both. A signed-in cold start hits THIS 503 first.
//
// The probe is a real request through the real middleware, with a Prisma stub
// whose user lookup throws.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import express from "express";
import type { PrismaClient } from "@prisma/client";

import { signToken } from "../../lib/auth";
import { createRequireAuth } from "../../middleware/auth";

describe("FIX-3 — requireAuth's fail-closed 503", () => {
  let server: Server;
  let origin: string;
  let reached = false;

  before(async () => {
    const throwingPrisma = {
      user: {
        findUnique: async () => {
          throw new Error("Can't reach database server");
        },
      },
    } as unknown as PrismaClient;
    const app = express();
    app.get("/probe", createRequireAuth({ prisma: throwingPrisma }), (_req, res) => {
      reached = true;
      res.json({ ok: true });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("answers 503 with Retry-After and the db_unavailable code, and lets nothing through", async () => {
    const res = await fetch(`${origin}/probe`, {
      headers: { Authorization: `Bearer ${signToken("fix3-user")}` },
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "2");
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "db_unavailable");
    assert.equal(body.retryable, true);
    assert.equal(reached, false, "fail CLOSED: the handler must not run");
  });
});
