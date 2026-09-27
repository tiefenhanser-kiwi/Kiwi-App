// Row 9 (1.1) · OAuth Block 1 Part A — the RSA JWKS cache, shared.
//
// ── WHERE THIS CODE CAME FROM ────────────────────────────────────────────
//
// It is not new. Row 5 Block 1c wrote `GoogleJwksCache` in lib/googleOidc.ts
// to let the image-drain route verify the OIDC token Cloud Scheduler presents,
// and that class turned out to contain nothing Google-specific: it fetches a
// JWKS document through an INJECTED fetch, builds a `KeyObject` per RSA entry
// with Node's own `createPublicKey({ format: "jwk" })`, honours the endpoint's
// `cache-control: max-age`, and refetches once when asked for a `kid` it does
// not know. Apple publishes the same document shape at the same kind of URL.
//
// So the class MOVED here and googleOidc.ts now re-exports it under its old
// name. `internal.ts`, `guestSweep.test.ts`, `internalImageDrain.test.ts` and
// `googleOidc.test.ts` import exactly what they imported before; the drain's
// trust domain (a service-account token against an email allowlist) stays in
// googleOidc.ts, because it is a different question from "is this a person".
//
// ⚠️ THE FETCH IS A SEAM, NOT A CONVENIENCE. `pnpm test` runs with
// `--env-file=.env`, so a module that reached for `globalThis.fetch` by default
// would put Apple's and Google's live key endpoints one forgotten stub away
// from the hermetic suite. There is no default here: a caller must supply one.

import { createPublicKey, type KeyObject } from "node:crypto";

/** Structural, not `typeof fetch` — a test hands in four fields, not a Response. */
export type JwksFetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface JwksCacheDeps {
  fetch: JwksFetch;
  now?: () => number;
  jwksUrl?: string;
}

/** An hour, when the endpoint does not say. Both Apple and Google do say. */
const DEFAULT_CACHE_MS = 60 * 60 * 1000;
/** A floor, so a `max-age=0` cannot turn every verification into a fetch. */
const MIN_CACHE_MS = 60 * 1000;

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private expiresAt = 0;
  constructor(private readonly deps: JwksCacheDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async refresh(): Promise<boolean> {
    const url = this.deps.jwksUrl;
    if (!url) throw new Error("jwks_url_missing");
    const res = await this.deps.fetch(url);
    if (!res.ok) return false;
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, KeyObject>();
    for (const k of body.keys ?? []) {
      if (!k.kid || k.kty !== "RSA" || !k.n || !k.e) continue;
      try {
        next.set(k.kid, createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" }));
      } catch {
        /* a malformed entry is skipped, not fatal */
      }
    }
    const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
    const ttl = maxAge ? Math.max(MIN_CACHE_MS, Number(maxAge[1]) * 1000) : DEFAULT_CACHE_MS;
    this.keys = next;
    this.expiresAt = this.now() + ttl;
    return true;
  }

  // The key for `kid`, refetching once if the cache is stale or does not know
  // the id. `undefined` = the issuer does not (currently) publish that key.
  // Throws only when the JWKS endpoint itself is unreachable.
  async keyFor(kid: string): Promise<KeyObject | undefined> {
    if (this.now() < this.expiresAt && this.keys.has(kid)) return this.keys.get(kid);
    const fetched = await this.refresh();
    if (!fetched) throw new Error("jwks_unavailable");
    return this.keys.get(kid);
  }
}
