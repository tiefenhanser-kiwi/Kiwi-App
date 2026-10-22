// SEC-2 #9 — response headers, on the REAL app (app.ts), so the assertion is
// about what ships and not about a router mounted alone. SEC-1 measured every
// one of these absent and `X-Powered-By: Express` present.
//
// Neither request touches the database: /api/healthz answers from memory, and
// the pages are static strings.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Server } from "node:http";

import app from "../../app";

describe("SEC-2 #9 — helmet on the JSON API and a hash CSP on the pages", () => {
  let server: Server;
  let base = "";
  before(async () => {
    server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => new Promise<void>((r) => server.close(() => r())));

  it("an API response carries the JSON-API header set and no X-Powered-By", async () => {
    const res = await fetch(`${base}/api/healthz`);
    assert.equal(res.status, 200);
    const h = res.headers;
    assert.equal(h.get("x-powered-by"), null);
    assert.match(h.get("content-security-policy") ?? "", /^default-src 'none';/);
    assert.match(h.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(h.get("x-frame-options"), "DENY");
    assert.equal(h.get("x-content-type-options"), "nosniff");
    assert.equal(h.get("referrer-policy"), "no-referrer");
    assert.match(h.get("strict-transport-security") ?? "", /max-age=\d+/);
    // CORS is unchanged: the web app still reads the API cross-origin.
    const cors = await fetch(`${base}/api/healthz`, { headers: { origin: "https://app.example" } });
    assert.equal(cors.headers.get("access-control-allow-origin"), "*");
  });

  it("an unknown route's 404 does not name the framework either", async () => {
    const res = await fetch(`${base}/api/definitely-not-a-route`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  for (const path of ["/reset-password", "/verify-email", "/email/unsubscribe"]) {
    it(`${path} allows exactly its own inline script and style, by hash`, async () => {
      const res = await fetch(`${base}${path}?token=abc`);
      assert.equal(res.status, 200);
      const html = await res.text();
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.doesNotMatch(csp, /unsafe-inline/);
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /connect-src 'self'/);
      for (const tag of ["script", "style"] as const) {
        const body = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)?.[1];
        assert.ok(body !== undefined, `${path} has an inline ${tag}`);
        const hash = createHash("sha256").update(body!, "utf8").digest("base64");
        assert.ok(csp.includes(`${tag}-src 'sha256-${hash}'`), `${tag}-src carries the ${tag}'s hash`);
      }
      assert.equal(res.headers.get("x-powered-by"), null);
    });
  }
});
