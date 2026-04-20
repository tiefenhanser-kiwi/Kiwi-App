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
}

const STORE = new Map<string, Bucket>();

function clientIp(req: Request): string {
  // Only trust the TCP peer address — never `x-forwarded-for`, which any
  // attacker can spoof to rotate identities and bypass the bucket. On a
  // proxied host this collapses to a global limit, which is the safe default
  // until the app explicitly configures `trust proxy` against known hops.
  return req.socket.remoteAddress || "unknown";
}

export function rateLimit(opts: Options) {
  const { capacity, refillPerSec, windowMs = 10 * 60 * 1000 } = opts;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.method}:${req.path}:${clientIp(req)}`;
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
