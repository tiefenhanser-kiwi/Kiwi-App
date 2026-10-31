// IMPORT-2 (D-WS9-384) — the REAL app wiring (src/app.ts): import-url is in
// ROUTE_SCOPED_JSON_PATHS, so a page past the 100 KB default parser reaches the
// route, whose own parser runs after requireAuth. Removing the app.ts line turns
// the 401 below into a 413.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

import app from "../../app";

describe("IMPORT-2 — the real app lets a page through to the route", () => {
  let origin = "";
  let server: Server;
  before(async () => {
    server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => new Promise<void>((r) => server.close(() => r())));

  it("a 300 KB body with no credentials reaches requireAuth (401), not the 100 KB default parser (413)", async () => {
    const res = await fetch(`${origin}/api/recipes/import-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/r", html: "x".repeat(300_000) }),
    });
    assert.equal(res.status, 401);
  });
});
