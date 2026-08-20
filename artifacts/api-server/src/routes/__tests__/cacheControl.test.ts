// BUG-104 (server half) — every /api response must carry an explicit
// `Cache-Control: no-store`, and a route that needs a different directive
// must still be able to win by setting its own header later.
//
// These tests exercise the REAL app wiring (src/app.ts), not a hand-built
// express instance, so removing the `app.use("/api", noStore)` line is what
// makes them fail — not a re-implementation of the middleware in the test.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import express from "express";

import app from "../../app";
import { noStore } from "../../middleware/cacheControl";

interface Harness {
  origin: string;
  close: () => Promise<void>;
}

function listen(target: express.Express): Promise<Harness> {
  return new Promise((resolve) => {
    const server: Server = target.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

describe("BUG-104 — Cache-Control: no-store on the /api router", () => {
  let harness: Harness;

  before(async () => {
    harness = await listen(app);
  });
  after(async () => {
    await harness.close();
  });

  it("a JSON API response carries no-store (GET /api/healthz)", async () => {
    const res = await fetch(`${harness.origin}/api/healthz`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("cache-control"),
      "no-store",
      "an /api JSON response with no directive is eligible for RFC 9111 heuristic freshness in NSURLCache / OkHttp",
    );
  });

  it("an authenticated route's 401 also carries no-store (the middleware runs before requireAuth)", async () => {
    // GET /api/plans is auth-gated and 401s before touching the DB, so this
    // proves coverage of the authenticated surface without needing a database.
    const res = await fetch(`${harness.origin}/api/plans`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("the middleware is mounted on /api specifically, not globally on the app", async () => {
    // A path outside /api gets Express's 404 with no directive. Pins the mount
    // point so a future move to app.use(noStore) is a visible change.
    const res = await fetch(`${harness.origin}/not-api`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), null);
  });
});

describe("BUG-104 — a route may still override the directive (SSE contract)", () => {
  // The wizard SSE stream sets `Cache-Control: no-cache, no-transform` in its
  // own handler. That handler runs AFTER the middleware, so its setHeader
  // replaces no-store. This pins the ordering contract the SSE route depends
  // on — hitting the real SSE endpoint would need auth, a DB and a live model
  // call, so the contract is exercised against the same middleware instance.
  let harness: Harness;

  before(async () => {
    const probe = express();
    probe.use("/api", noStore);
    probe.get("/api/stream", (_req, res) => {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.write("data: {}\n\n");
      res.end();
    });
    harness = await listen(probe);
  });
  after(async () => {
    await harness.close();
  });

  it("a handler that sets its own Cache-Control wins over the middleware", async () => {
    const res = await fetch(`${harness.origin}/api/stream`);
    await res.text();
    assert.equal(
      res.headers.get("cache-control"),
      "no-cache, no-transform",
      "the SSE stream must keep no-transform — proxies buffering the stream is the failure it prevents",
    );
    assert.equal(res.headers.get("x-accel-buffering"), "no");
  });
});
