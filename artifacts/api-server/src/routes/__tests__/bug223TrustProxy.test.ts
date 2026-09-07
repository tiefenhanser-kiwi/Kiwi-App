// BUG-223 — the limiter key must follow the app's declared trust-proxy hop
// count, and MUST NOT follow a spoofed header when no hops are vouched for.
//
// Guarded in BOTH directions, because the dangerous failure here is not the
// bug — it is a careless fix. Trusting `x-forwarded-for` unconditionally would
// re-open the identity-rotation hole the original code deliberately closed, and
// a test that only checks "the key now follows XFF" would happily pass on that
// broken fix.
//
// The key is observed behaviourally: with capacity 1 and no refill, a second
// request 429s if and only if it landed in the SAME bucket as the first.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { rateLimit, __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { parseTrustProxyHops } from "../../app";

async function spinUp(hops: number) {
  const app: Express = express();
  app.set("trust proxy", hops);
  app.get("/probe", rateLimit({ capacity: 1, refillPerSec: 0 }), (_req, res) => {
    res.json({ ok: true });
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    hit: (xff: string) =>
      fetch(`http://127.0.0.1:${port}/probe`, {
        headers: { "x-forwarded-for": xff },
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("BUG-223 — the limiter key follows declared hops, not a spoofed header", () => {
  beforeEach(() => __clearRateLimitStoreForTests());

  it("hops=0 (the default): a spoofed x-forwarded-for does NOT change the key", async () => {
    const h = await spinUp(0);
    try {
      const first = await h.hit("9.9.9.9");
      assert.equal(first.status, 200, "first request should pass");

      // Same socket, a brand-new spoofed identity. If the header could move the
      // key, this would get a fresh bucket and 200 — which is precisely the
      // identity-rotation bypass that must stay closed.
      const second = await h.hit("1.2.3.4");
      assert.equal(
        second.status,
        429,
        "a spoofed x-forwarded-for bought a fresh bucket at hops=0 — the limiter is trusting an untrusted header",
      );
    } finally {
      await h.close();
    }
  });

  it("hops=1: the key comes from the last hop, so distinct clients get distinct buckets", async () => {
    const h = await spinUp(1);
    try {
      const first = await h.hit("9.9.9.9");
      assert.equal(first.status, 200, "first client should pass");

      const sameClient = await h.hit("9.9.9.9");
      assert.equal(
        sameClient.status,
        429,
        "the same client should share a bucket",
      );

      // A different client behind the same trusted proxy must not be punished
      // for the first one — this is the beta-lockout half of BUG-223.
      const otherClient = await h.hit("5.6.7.8");
      assert.equal(
        otherClient.status,
        200,
        "a different client shares the first one's bucket — the key is still collapsing to the proxy address",
      );
    } finally {
      await h.close();
    }
  });

  it("hops=1 reads the LAST entry in the chain, not the client-controlled left end", async () => {
    const h = await spinUp(1);
    try {
      // Everything left of the final hop is caller-supplied and must not move
      // the key when only one hop is vouched for.
      assert.equal((await h.hit("evil-1, evil-2, 7.7.7.7")).status, 200);
      assert.equal(
        (await h.hit("totally-different, 7.7.7.7")).status,
        429,
        "the caller-controlled prefix changed the key — only the trusted hop may decide it",
      );
    } finally {
      await h.close();
    }
  });

  it("TRUST_PROXY_HOPS parses safely and defaults to 0", () => {
    assert.equal(parseTrustProxyHops(undefined), 0, "unset → trust nothing");
    assert.equal(parseTrustProxyHops(""), 0, "empty → trust nothing");
    assert.equal(parseTrustProxyHops("   "), 0, "blank → trust nothing");
    assert.equal(parseTrustProxyHops("0"), 0);
    assert.equal(parseTrustProxyHops("1"), 1, "Cloud Run's value");
    assert.equal(parseTrustProxyHops("2"), 2);
    // A typo in a deploy variable must never silently widen who we trust.
    assert.equal(parseTrustProxyHops("true"), 0, "'true' must NOT mean trust-all");
    assert.equal(parseTrustProxyHops("abc"), 0);
    assert.equal(parseTrustProxyHops("-1"), 0);
    assert.equal(parseTrustProxyHops("1.5"), 0);
  });
});
