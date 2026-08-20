import type { Request, Response, NextFunction } from "express";

// BUG-104 (server half) — every /api response carries an explicit
// `Cache-Control: no-store`.
//
// Why this is needed even though nothing here is obviously cacheable:
// Express 5 sets `etag: weak` at init and no API route sets any
// Cache-Control at all, so authenticated per-user JSON ships with NO cache
// directive. RFC 9111 §4.2.2 lets a shared or private HTTP cache assign
// *heuristic* freshness to such a response — and the client is React Native
// `fetch`, which is backed by NSURLCache on iOS and OkHttp on Android. Those
// are real HTTP caches sitting under the app with no visibility from JS. A
// heuristically-fresh /api/home or /api/me can be replayed to a different
// signed-in user on the same device, or replayed after a mutation.
//
// (The stale-304 theory was refuted separately: Express computes the ETag
// from the CURRENT body before testing req.fresh, so a 304 is never served
// from stale content. Heuristic freshness in the platform cache is the live
// exposure, and `no-store` is the directive that closes it — `no-cache`
// would still permit storage.)
//
// Mounted on the /api router in app.ts, i.e. BEFORE any route handler runs.
// Routes that need a different directive simply call res.setHeader later and
// win by replacement — the wizard SSE stream does exactly that
// (`no-cache, no-transform`), and must keep doing so: `no-store` on a stream
// is harmless but `no-transform` is the part that stops proxies from
// buffering it.
export function noStore(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("Cache-Control", "no-store");
  next();
}
