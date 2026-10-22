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

// Row 13 · Block 1 — exported (was module-private) so the guest lane's per-IP
// cap reads the SAME address this limiter keys on. A second derivation would
// be a second definition of "who is this", and the two would drift.
export function clientIp(req: Request): string {
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

/**
 * SEC-2 #1 — THE ROUTE A REQUEST MATCHED, NOT THE PATH IT TYPED.
 *
 * The bucket used to be keyed on `req.path`, the raw string the caller sent.
 * Express routing is case-insensitive and non-strict about a trailing slash, so
 * `/auth/LOGIN`, `/auth/Login` and `/auth/login/` all reach the login handler —
 * and each got a FRESH bucket. SEC-1 measured it: ten 401s, two 429s, then a
 * 401 for every case variant. Every limiter in the API was walkable that way,
 * and a route with an `:id` gave each id its own bucket on top.
 *
 * `req.route.path` is the pattern Express matched (`/auth/login`,
 * `/plans/:id/recalc`), identical for every spelling that reaches the handler.
 * It is set whenever the limiter runs as route middleware, which is every mount
 * today. The fallback (a limiter mounted with `use`) normalises the raw path the
 * way Express matches it: lower-cased, repeated slashes collapsed, trailing
 * slash stripped.
 */
export function routeKey(req: Request): string {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath === "string") return `${req.baseUrl}${routePath}`;
  const raw = `${req.baseUrl}${req.path}`.toLowerCase().replace(/\/{2,}/g, "/");
  return raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
}

// SEC-2b — the limiter's clock, swappable so a test can move a 15-minute
// window forward without waiting for it. Production never touches it.
let clock: () => number = () => Date.now();
export function __setRateLimitClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

export interface BucketVerdict {
  ok: boolean;
  /** Seconds until one token is back. Meaningful only when `ok` is false. */
  retryAfter: number;
}

/**
 * The bucket arithmetic on its own, for a caller that must decide WHEN to spend
 * a token (the per-email login limiter spends one only on a failed attempt).
 * `check` never spends; `consume` always does.
 */
export function createBucket(opts: {
  capacity: number;
  refillPerSec: number;
  windowMs?: number;
}) {
  const { capacity, refillPerSec, windowMs = 10 * 60 * 1000 } = opts;

  function current(key: string, now: number): number {
    // Light-touch eviction
    if (STORE.size > 5000) {
      for (const [k, b] of STORE) {
        if (now - b.updatedAt > windowMs) STORE.delete(k);
      }
    }
    const existing = STORE.get(key);
    if (!existing) return capacity;
    const dt = (now - existing.updatedAt) / 1000;
    return Math.min(capacity, existing.tokens + dt * refillPerSec);
  }

  return {
    check(key: string): BucketVerdict {
      const tokens = current(key, clock());
      return tokens < 1
        ? { ok: false, retryAfter: Math.ceil((1 - tokens) / refillPerSec) }
        : { ok: true, retryAfter: 0 };
    },
    consume(key: string): void {
      const now = clock();
      STORE.set(key, { tokens: current(key, now) - 1, updatedAt: now });
    },
  };
}

export function tooManyRequests(res: Response, retryAfter: number): void {
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({ error: "Too many requests, slow down." });
}

export function rateLimit(opts: Options) {
  const { keyFn } = opts;
  const bucket = createBucket(opts);

  return (req: Request, res: Response, next: NextFunction): void => {
    const id = keyFn ? keyFn(req) : clientIp(req);
    const key = `${req.method}:${routeKey(req)}:${id}`;

    const verdict = bucket.check(key);
    if (!verdict.ok) {
      tooManyRequests(res, verdict.retryAfter);
      return;
    }

    bucket.consume(key);
    next();
  };
}

/**
 * SEC-2 #1 — the normalised email a per-account limit is keyed on. Lower-cased
 * and trimmed, exactly as the auth routes normalise it before the user lookup,
 * so one account is one bucket however its address is typed. `null` for a body
 * with no usable email: the route's own 400 answers that, not the limiter.
 */
export function emailKey(req: Request): string | null {
  const raw = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email === "" ? null : email;
}

type BucketOptions = { capacity: number; refillPerSec: number; windowMs?: number };

/** Password-reset REQUESTS per email: 10 a minute, 30 a day (each is a mail to a real inbox). */
export const EMAIL_PER_MINUTE: BucketOptions = { capacity: 10, refillPerSec: 10 / 60 };
export const EMAIL_PER_DAY: BucketOptions = {
  capacity: 30,
  refillPerSec: 30 / 86_400,
  // The daily bucket must outlive the eviction sweep's idle window, or a
  // crowded store would hand an attacker a fresh day after ten quiet minutes.
  windowMs: 24 * 60 * 60 * 1000,
};

/**
 * SEC-2b — FAILED LOGINS per email: 10, refilling over 15 minutes, and NO
 * daily bucket. SEC-2 #1 also capped failures at 30 a day, and that cap was a
 * weapon: thirty wrong guesses from anywhere locked the real owner out of
 * their password sign-in for the rest of the day. A short window bounds the
 * guessing just as surely (about one guess per 90 s sustained) while an
 * attacker can only ever SLOW the owner down — the owner's wait is at most
 * the window, and a password reset clears it (clearPerEmailLimit).
 */
export const LOGIN_FAILURE_WINDOW: BucketOptions = {
  capacity: 10,
  refillPerSec: 10 / (15 * 60),
  windowMs: 15 * 60 * 1000,
};

/**
 * SEC-2 #1 — per-EMAIL limits, whatever the IP. The IP limiter alone is
 * walkable by anyone with more than one address (and on Cloud Run with
 * TRUST_PROXY_HOPS unset it is one global bucket); this one bounds the
 * attempts against a single account wherever they come from.
 *
 * `name` keys the buckets (so a reset can clear the LOGIN window by name);
 * every one of `windows` is checked on the way in.
 *
 * `"failures"` (login) spends a token only when the handler reports a failed
 * attempt (countFailedAttempt below). A correct password never counts against
 * its own account; guesses do. A blocked email is refused BEFORE the password
 * is checked, right and wrong alike, so the 429 is no oracle.
 *
 * `"all"` (password-reset request) spends on every call: each one is an email
 * sent to a real inbox.
 */
export function perEmailLimit(opts: {
  name: string;
  count: "all" | "failures";
  windows: BucketOptions[];
}) {
  const buckets = opts.windows.map((w) => createBucket(w));

  return (req: Request, res: Response, next: NextFunction): void => {
    const email = emailKey(req);
    if (!email) {
      next();
      return;
    }
    const key = perEmailKey(opts.name, email);
    const blocked = buckets.map((b, i) => b.check(`${key}${i}`)).find((v) => !v.ok);
    if (blocked) {
      tooManyRequests(res, blocked.retryAfter);
      return;
    }
    const spend = () => buckets.forEach((b, i) => b.consume(`${key}${i}`));
    if (opts.count === "all") spend();
    else res.locals["countFailedAttempt"] = spend;
    next();
  };
}

function perEmailKey(name: string, email: string): string {
  return `email:${name}:${email.trim().toLowerCase()}:`;
}

/**
 * SEC-2b — forget every per-email bucket `name` holds for this address. A
 * completed password reset calls it for "login": the person just proved they
 * own the inbox, and whatever failures piled up before (theirs or a stranger's)
 * no longer stand between them and signing in.
 */
export function clearPerEmailLimit(name: string, email: string): void {
  const prefix = perEmailKey(name, email);
  for (const k of [...STORE.keys()]) if (k.startsWith(prefix)) STORE.delete(k);
}

/** The handler's half of `perEmailLimit("failures")`: call it on a failed attempt. */
export function countFailedAttempt(res: Response): void {
  const spend = res.locals["countFailedAttempt"];
  if (typeof spend === "function") spend();
}
