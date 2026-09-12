// D-WS9-231 — the reset-password / verify-email WEB FALLBACK pages.
//
// Drives the REAL app wiring (src/app.ts) the way cacheControl.test.ts does,
// so what is asserted is the production mount: the pages answer at the ROOT
// of the host (the exact paths sendEmail.ts::buildAppLink mints), as HTML,
// with no-store, and WITHOUT the /api auth gate in front of them. A page that
// 401s is a reset link nobody can open on a laptop — the case D-WS9-231 was
// ruled for.
//
// The token-less "invalid state without a request" rule is asserted on the
// markup and the inline script: the server renders the same document either
// way (the token never reaches the server on the GET), so the guard is that
// the script bails to the invalid state before any fetch when no token is in
// location.search.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import app from "../../app";
import {
  LINK_INVALID_TEXT,
  RESET_CONFIRM_ENDPOINT,
  RESET_SUCCESS_TEXT,
} from "../../pages/resetPassword";
import { VERIFY_CHANGE_ENDPOINT, VERIFY_SUCCESS_TEXT } from "../../pages/verifyEmail";

interface Harness {
  origin: string;
  close: () => Promise<void>;
}

function listen(): Promise<Harness> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
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

describe("D-WS9-231 — web fallback pages at the host root", () => {
  let harness: Harness;

  before(async () => {
    harness = await listen();
  });
  after(async () => {
    await harness.close();
  });

  for (const [path, endpoint, successText] of [
    ["/reset-password", RESET_CONFIRM_ENDPOINT, RESET_SUCCESS_TEXT],
    ["/verify-email", VERIFY_CHANGE_ENDPOINT, VERIFY_SUCCESS_TEXT],
  ] as const) {
    describe(`GET ${path}`, () => {
      it("answers 200 text/html with Cache-Control: no-store", async () => {
        const res = await fetch(`${harness.origin}${path}?token=abc`);
        assert.equal(res.status, 200);
        assert.match(
          res.headers.get("content-type") ?? "",
          /^text\/html/,
          "the page must be served as HTML, not JSON",
        );
        assert.equal(
          res.headers.get("cache-control"),
          "no-store",
          "a page whose URL carries a one-time token must not be cacheable",
        );
      });

      it("is NOT behind the API auth gate — no Authorization header, still 200", async () => {
        const res = await fetch(`${harness.origin}${path}`);
        assert.equal(
          res.status,
          200,
          "the emailed link is opened in a browser with no session — a 401 here is a link nobody can use",
        );
      });

      it("posts to the mounted /api endpoint and carries both outcome texts", async () => {
        const html = await (await fetch(`${harness.origin}${path}`)).text();
        assert.ok(
          html.includes(`fetch("${endpoint}"`),
          `page must POST to the /api-prefixed endpoint ${endpoint}`,
        );
        assert.ok(html.includes(successText), "success text missing");
        assert.ok(html.includes(LINK_INVALID_TEXT), "invalid/expired text missing");
      });

      it("a missing token renders the invalid state before any request", async () => {
        const html = await (await fetch(`${harness.origin}${path}`)).text();
        // The bail-out must precede the fetch in the inline script.
        const bail = html.indexOf("if (!token)");
        const call = html.indexOf("fetch(");
        assert.ok(bail !== -1, "script must check for a missing token");
        assert.ok(call !== -1, "script must contain the confirm request");
        assert.ok(
          bail < call,
          "the missing-token check must run before the request is issued",
        );
      });

      it("carries the kiwi:// deep link as the secondary 'open in app' path", async () => {
        const html = await (await fetch(`${harness.origin}${path}`)).text();
        assert.ok(
          html.includes(`"kiwi:/${path}?token="`),
          "the D-WS9-231 'same URL, app enhancement' anchor is missing",
        );
      });
    });
  }

  it("the /api prefix still answers JSON with no-store (pages did not displace it)", async () => {
    const res = await fetch(`${harness.origin}/api/healthz`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("the page paths do not exist under /api", async () => {
    const res = await fetch(`${harness.origin}/api/reset-password`);
    assert.equal(res.status, 404);
  });
});
