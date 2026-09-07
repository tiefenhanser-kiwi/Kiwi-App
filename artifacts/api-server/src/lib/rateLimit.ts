// Tiny in-memory token-bucket rate limiter, keyed by IP. Sufficient as a
// cost-abuse guardrail on the public LLM endpoint until proper auth is wired.

import type { Request, Response, NextFunction } from "express";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface Options {
  capacity: number; // max tokens (= burst)
  refillPerSec: number; // tokens added per second
  windowMs?: number; // bucket TTL
  // Custom key extractor. Default = IP-based. Authenticated routes pass
  // a userId-based extractor so the bucket survives IP rotation and isn't
  // shared across users behind one NAT.
  keyFn?: (req: Request) => string;
}

const STORE = new Map<string, Bucket>();

// Test-only: clear the module-global bucket store so a test file whose cases
// share an IP+path bucket (the default key) can isolate each case. Never called
// in production — the store is meant to persist across requests there.
export function __clearRateLimitStoreForTests(): void {
  STORE.clear();
}

function clientIp(req: Request): string {
  // BUG-223 — `req.ip` is the address Express DERIVES from the app's
  // `trust proxy` setting, which app.ts drives from TRUST_PROXY_HOPS and which
  // DEFAULTS TO 0. At 0, Express ignores `x-forwarded-for` entirely and req.ip
  // is the socket peer — measured byte-identical to the previous line, so this
  // is a no-op until a deploy vouches for a hop count.
  //
  // This is NOT "start trusting x-forwarded-for". The header is still refused
  // for every hop the deploy has not named, because any caller can spoof it to
  // rotate identities and walk around the bucket — the original reasoning here
  // was correct and is preserved. The only thing that moved is that the number
  // of trusted hops became configuration instead of a hard-coded zero, because
  // behind a proxy the raw peer address collapses to one value for everyone.
  //
  // Fallbacks are ordered so a missing req.ip (no Express app in the chain)
  // degrades to the old behaviour rather than to a single shared "unknown".
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function rateLimit(opts: Options) {
  const { capacity, refillPerSec, windowMs = 10 * 60 * 1000, keyFn } = opts;

  return (req: Request, res: Response, next: NextFunction): void => {
    const id = keyFn ? keyFn(req) : clientIp(req);
    const key = `${req.method}:${req.path}:${id}`;
    const now = Date.now();

    // Light-touch eviction
    if (STORE.size > 5000) {
      for (const [k, b] of STORE) {
        if (now - b.updatedAt > windowMs) STORE.delete(k);
      }
    }

    const existing = STORE.get(key);
    let tokens = existing?.tokens ?? capacity;
    if (existing) {
      const dt = (now - existing.updatedAt) / 1000;
      tokens = Math.min(capacity, tokens + dt * refillPerSec);
    }

    if (tokens < 1) {
      const retryAfter = Math.ceil((1 - tokens) / refillPerSec);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Too many requests, slow down." });
      return;
    }

    tokens -= 1;
    STORE.set(key, { tokens, updatedAt: now });
    next();
  };
}
