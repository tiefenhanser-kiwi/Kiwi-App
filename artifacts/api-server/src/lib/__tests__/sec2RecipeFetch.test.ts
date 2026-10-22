// SEC-2 #2 — the recipe-import fetch. SEC-1 reached this server's own
// /api/healthz through `[::1]` and `[0:0:0:0:0:0:0:1]`, saw IPv4-mapped IPv6,
// CGNAT and the metadata hostname go unchecked, read the redirect target and
// upstream status back out of `internalError`, used open-vs-closed ports as a
// scanner, and left a dripping connection open after giving up at 30 s.
//
// Every case here runs against 127.0.0.1 listeners or fails before connecting.
// `allowLoopbackForTests` opens loopback and the port rule ONLY; everything
// else (DNS answers, size, time, redirects) runs the production checks.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import type dns from "node:dns";
import type { AddressInfo } from "node:net";

import { fetchRecipePage, isBlockedAddress, RecipeImportError } from "../recipeImport";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    assert.ok(err instanceof RecipeImportError, `expected RecipeImportError, got ${String(err)}`);
    return (err as RecipeImportError).code;
  }
}

/** A fake dns.lookup that answers `answers` for every name and counts calls. */
function fakeLookup(answers: string[]) {
  const seen: string[] = [];
  const fn = ((hostname: string, _opts: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => {
    seen.push(hostname);
    cb(null, answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  }) as unknown as typeof dns.lookup;
  return { fn, seen };
}

describe("SEC-2 #2 — isBlockedAddress", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "100.100.100.200", "100.127.255.255", "224.0.0.1", "239.255.255.250",
    "255.255.255.255", "198.18.0.1",
    "::", "::1", "0:0:0:0:0:0:0:1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe",
    "::ffff:8.8.8.8", "::127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "fc00::1", "fd12:3456::1", "fe80::1",
    "fe80::1%eth0", "fec0::1", "ff02::1", "2001:db8::1", "2002:7f00:1::1", "2001:0:4136:e378::1",
    "not-an-ip",
  ];
  const allowed = ["8.8.8.8", "93.184.216.34", "100.128.0.1", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"];

  for (const ip of blocked) it(`refuses ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
});

describe("SEC-2 #2 — refused before any connection (SEC-1's probe list)", () => {
  const refusals: Array<[string, string]> = [
    ["http://127.0.0.1/api/healthz", "blocked_host"],
    ["http://2130706433/", "blocked_host"],
    ["http://0x7f.1/", "blocked_host"],
    ["http://0177.0.0.1/", "blocked_host"],
    ["http://localhost/", "blocked_host"],
    ["http://localhost./", "blocked_host"],
    ["http://169.254.169.254/", "blocked_host"],
    ["http://10.0.0.1/", "blocked_host"],
    ["http://[::1]/api/healthz", "blocked_host"],
    ["http://[::ffff:127.0.0.1]/", "blocked_host"],
    ["http://[::ffff:7f00:1]/", "blocked_host"],
    ["http://[::]/", "blocked_host"],
    ["http://[0:0:0:0:0:0:0:1]/", "blocked_host"],
    ["http://metadata.google.internal/computeMetadata/v1/", "blocked_host"],
    ["http://[::ffff:a9fe:a9fe]/computeMetadata/v1/", "blocked_host"],
    ["http://100.100.100.200/", "blocked_host"],
    ["http://example.com:8080/", "blocked_host"],
    ["http://example.com:3100/", "blocked_host"],
    ["https://example.com:22/", "blocked_host"],
    ["http://user:pass@example.com/", "invalid_url"],
    ["file:///C:/Windows/win.ini", "invalid_url"],
    ["gopher://127.0.0.1:3100/", "invalid_url"],
    ["data:text/html,hi", "invalid_url"],
    ["not a url", "invalid_url"],
  ];
  for (const [url, want] of refusals) {
    it(`${url} → ${want}`, async () => {
      // A lookup that would hand back a public address: if any of these reached
      // DNS it would mean the URL itself was not checked.
      const { fn, seen } = fakeLookup(["93.184.216.34"]);
      assert.equal(await code(fetchRecipePage(url, { dnsLookup: fn })), want);
      assert.deepEqual(seen, []);
    });
  }

  it("a name that RESOLVES to a private address is refused", async () => {
    const { fn, seen } = fakeLookup(["10.1.2.3"]);
    assert.equal(await code(fetchRecipePage("http://innocent.example/", { dnsLookup: fn })), "blocked_host");
    assert.deepEqual(seen, ["innocent.example"]);
  });

  it("a record set mixing a public and a private address is refused, not filtered", async () => {
    const { fn } = fakeLookup(["93.184.216.34", "127.0.0.1"]);
    assert.equal(await code(fetchRecipePage("http://mixed.example/", { dnsLookup: fn })), "blocked_host");
  });

  it("a name that resolves to IPv4-mapped IPv6 metadata is refused", async () => {
    const { fn } = fakeLookup(["::ffff:169.254.169.254"]);
    assert.equal(await code(fetchRecipePage("http://sneaky.example/", { dnsLookup: fn })), "blocked_host");
  });
});

describe("SEC-2 #2 — what reaches a (loopback) server", () => {
  let server: http.Server;
  let port = 0;
  let dripOpen = 0;
  const hostsSeen: string[] = [];

  before(async () => {
    server = http.createServer((q, s): void => {
      hostsSeen.push(String(q.headers.host));
      if (q.url === "/recipe") {
        s.writeHead(200, { "content-type": "text/html" });
        s.end("<html><body>soup</body></html>");
        return;
      }
      if (q.url === "/recipe-gz") {
        const body = zlib.gzipSync(Buffer.from("<html><body>gz soup</body></html>"));
        s.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        s.end(body);
        return;
      }
      if (q.url === "/redirect") {
        s.writeHead(302, { location: "http://169.254.169.254/computeMetadata/v1/" });
        s.end();
        return;
      }
      if (q.url === "/bomb") {
        // ~12 MB of spaces, ~12 KB on the wire — SEC-1's bomb.
        const body = zlib.gzipSync(Buffer.alloc(12 * 1024 * 1024, 0x20));
        s.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": body.length });
        s.end(body);
        return;
      }
      if (q.url === "/chunked-big") {
        s.writeHead(200, { "content-type": "text/html" });
        let sent = 0;
        const chunk = Buffer.alloc(1024 * 1024, 0x20);
        const push = (): void => {
          if (sent >= 8 || s.destroyed) {
            s.end();
            return;
          }
          sent++;
          s.write(chunk, push);
        };
        push();
        return;
      }
      if (q.url === "/drip") {
        dripOpen++;
        s.writeHead(200, { "content-type": "text/html" });
        s.write("<html>");
        const t = setInterval(() => s.write(" "), 200);
        q.on("close", () => {
          clearInterval(t);
          dripOpen--;
        });
        return;
      }
      s.writeHead(404);
      s.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("connects to the address the guard checked, keeping the original Host", async () => {
    const { fn, seen } = fakeLookup(["127.0.0.1"]);
    const { html } = await fetchRecipePage(`http://recipes.example:${port}/recipe`, {
      dnsLookup: fn,
      allowLoopbackForTests: true,
    });
    assert.match(html, /soup/);
    // ONE resolution — there is no second answer for a rebinding server to swap.
    assert.deepEqual(seen, ["recipes.example"]);
    assert.equal(hostsSeen.at(-1), `recipes.example:${port}`);
  });

  it("decodes a gzip page", async () => {
    const { html } = await fetchRecipePage(`http://127.0.0.1:${port}/recipe-gz`, { allowLoopbackForTests: true });
    assert.match(html, /gz soup/);
  });

  it("refuses a redirect without reading where it points", async () => {
    try {
      await fetchRecipePage(`http://127.0.0.1:${port}/redirect`, { allowLoopbackForTests: true });
      assert.fail("expected a refusal");
    } catch (err) {
      assert.equal((err as RecipeImportError).code, "redirected");
      assert.doesNotMatch((err as Error).message, /169\.254/);
    }
  });

  it("a gzip bomb stops at the decoded-byte cap", async () => {
    // The declared length is ~12 KB, far under the cap, so this verdict can
    // only come from counting DECODED bytes as they arrive.
    const t0 = Date.now();
    assert.equal(
      await code(fetchRecipePage(`http://127.0.0.1:${port}/bomb`, { allowLoopbackForTests: true, maxBodyBytes: 1024 * 1024 })),
      "fetch_too_large",
    );
    assert.ok(Date.now() - t0 < 5000);
  });

  it("an undeclared-length body stops at the cap", async () => {
    assert.equal(
      await code(fetchRecipePage(`http://127.0.0.1:${port}/chunked-big`, { allowLoopbackForTests: true })),
      "fetch_too_large",
    );
  });

  // A per-test timeout so a missing deadline fails here instead of hanging.
  it("a dripping body is cut off at the overall deadline, and the connection closes", { timeout: 6000 }, async () => {
    const t0 = Date.now();
    assert.equal(
      await code(
        fetchRecipePage(`http://127.0.0.1:${port}/drip`, {
          allowLoopbackForTests: true,
          deadlineMs: 1200,
          headersTimeoutMs: 1000,
        }),
      ),
      "fetch_timeout",
    );
    const took = Date.now() - t0;
    assert.ok(took >= 1100 && took < 3000, `took ${took} ms`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(dripOpen, 0, "the server-side connection must be closed");
  });

  it("without the test seam, a loopback listener is unreachable even on an allowed port", async () => {
    assert.equal(await code(fetchRecipePage(`http://127.0.0.1:80/recipe`)), "blocked_host");
  });
});
