// BUG-220 — the 35 MB body parser on /recipes/import-image must run AFTER the
// auth check, so an anonymous caller cannot make the process buffer 35 MiB.
//
// The assertion is ORDER-SENSITIVE BY CONSTRUCTION and needs no memory
// measurement. Send a body that is over the parser's 35 MiB ceiling with no
// credentials:
//   • parser first  → body-parser rejects on size → 413
//   • auth first    → requireAuth rejects on headers → 401
// One status distinguishes the two orderings deterministically. The companion
// case (same oversized body, VALID token → 413) proves the parser is still
// mounted and still enforcing its ceiling, so a passing 401 can never mean
// "the parser was quietly removed".

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createRecipesRouter } from "../recipes";

// Comfortably over the route's "35mb" ceiling.
const OVERSIZED = JSON.stringify({ images: ["A".repeat(37 * 1024 * 1024)] });

async function spinUp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app: Express = express();
  // Deliberately NO global express.json() here — app.ts skips its default
  // parser for this exact path (ROUTE_SCOPED_JSON_PATHS), so the route-scoped
  // parser is the only one in play. Mirroring that is what makes this a test
  // of the route's own ordering.
  app.use(createRecipesRouter({ prisma: {} as never }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe("BUG-220 — import-image parses the body only after auth", () => {
  it("an oversized body with NO credentials is rejected by auth (401), not by the parser (413)", async () => {
    const h = await spinUp();
    try {
      const res = await fetch(`${h.baseUrl}/recipes/import-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: OVERSIZED,
      });
      assert.equal(
        res.status,
        401,
        `expected 401 (auth ran first). A 413 means the parser ran first and the process buffered ${OVERSIZED.length} bytes for an anonymous caller — BUG-220 has regressed.`,
      );
    } finally {
      await h.close();
    }
  });

  it("the same oversized body WITH a valid token still hits the 35 MiB ceiling (413)", async () => {
    const h = await spinUp();
    try {
      const res = await fetch(`${h.baseUrl}/recipes/import-image`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${signToken("bug220-test-user")}`,
        },
        body: OVERSIZED,
      });
      assert.equal(
        res.status,
        413,
        "expected 413 — the parser must still be mounted and still enforcing its ceiling for authenticated callers",
      );
    } finally {
      await h.close();
    }
  });
});
