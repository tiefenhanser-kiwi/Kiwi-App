// Plan-Gen Arc · Block 2 · D-WS9-037 / Block 4b-1 · D-WS9-075 — the pre-generated
// meal store's tunable retrieval knobs. NOT hardcoded inline at the call site: the
// compose seam resolves this once per request so the store-vs-live bias is a
// single knob.
//
// Design (per the Block 2 ruling): the composer is AI-driven — build-plans hands
// the AI a shortlist of shared-pool meals and the AI composes each candidate,
// picking a store meal per slot when one genuinely fits and inventing a fresh
// (live) meal otherwise. So the "coverage" lever is the shape of the shelf we hand
// the AI:
//
//   shortlistSize        — how many pool meals to offer the AI. With the Block
//                          4b-1 selection each shelf entry is a DISTINCT parent
//                          dish, so this is ~how many different dinners the AI can
//                          choose from.
//   cuisineQuotaFraction — when the user gave cuisines, the fraction of the shelf
//                          reserved for cuisine matches; the remainder backfills
//                          from the rest of the pool so a thin-cuisine user is
//                          never stranded (narrow, don't strand).
//
// Block 4b-1 removed `minMatchScore`: it was inert (floor 0 admitted everything)
// and the eligibility floor is now expressed by the hard filters (allergen /
// cuisine quota) plus rank-weighted sampling, not a score threshold.
//
// Env overrides let a deploy retune without a code change.

export interface StoreComposeConfig {
  /** Max shared-pool meals handed to the compose AI as the shortlist. */
  shortlistSize: number;
  /** Fraction [0,1] of the shelf reserved for cuisine matches when prefs exist. */
  cuisineQuotaFraction: number;
}

// Store-biased defaults (D-WS9-037 / D-WS9-075).
export const STORE_COMPOSE_DEFAULTS: StoreComposeConfig = {
  shortlistSize: 40,
  cuisineQuotaFraction: 0.7,
};

const ENV_SHORTLIST_SIZE = "KIWI_STORE_SHORTLIST_SIZE";
const ENV_CUISINE_QUOTA = "KIWI_STORE_CUISINE_QUOTA_FRACTION";

function readNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve the store-compose config for this request. Reads env overrides at call
 * time (so tests can set process.env before invoking) and clamps to sane bounds:
 * shortlistSize to a non-negative integer, cuisineQuotaFraction to [0,1].
 */
export function resolveStoreComposeConfig(): StoreComposeConfig {
  const shortlistSize = Math.max(
    0,
    Math.floor(
      readNumberEnv(ENV_SHORTLIST_SIZE, STORE_COMPOSE_DEFAULTS.shortlistSize),
    ),
  );
  const cuisineQuotaFraction = Math.min(
    1,
    Math.max(
      0,
      readNumberEnv(ENV_CUISINE_QUOTA, STORE_COMPOSE_DEFAULTS.cuisineQuotaFraction),
    ),
  );
  return { shortlistSize, cuisineQuotaFraction };
}
