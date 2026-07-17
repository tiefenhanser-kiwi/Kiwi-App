// Plan-Gen Arc · Block 2 · D-WS9-037 — the pre-generated meal store's tunable
// coverage threshold. NOT hardcoded inline at the call site: the compose seam
// resolves this once per request so the store-vs-live bias is a single knob.
//
// Design (per the Block 2 ruling): the composer is AI-driven — build-plans hands
// the AI a shortlist of shared-pool meals and the AI composes each candidate,
// picking a store meal per slot when one genuinely fits and inventing a fresh
// (live) meal otherwise. So the "per-slot coverage threshold" is expressed as
// the RETRIEVAL knobs that shape the shelf the AI chooses from:
//
//   shortlistSize  — how many pool meals to offer the AI. Larger = more store
//                    reach (more slots can plausibly be store-filled).
//   minMatchScore  — eligibility floor in [0,1]; a pool meal must score at least
//                    this against the user's prefs to make the shelf. 0 = offer
//                    everything that passes the hard filters (most aggressive).
//
// Aggressive / store-biased default: a generous shortlist and a zero floor, so a
// well-stocked store fills most slots. Graceful degrade is STRUCTURAL, not a
// special case — a thin/near-empty store simply yields a short (or empty) shelf,
// the AI has little/nothing to pick, and it invents live meals for the gap. The
// plan is always complete; only the store-vs-live MIX shifts. So Block 2 testing
// against a near-empty store produces live-fallback plans, never broken ones.
//
// Env overrides let a deploy retune without a code change; a future
// SystemSetting-backed override (like wizard.candidate_count) could layer on top
// of resolveStoreComposeConfig without touching call sites.

export interface StoreComposeConfig {
  /** Max shared-pool meals handed to the compose AI as the shortlist. */
  shortlistSize: number;
  /** Eligibility floor in [0,1]; pool meals scoring below this are not offered. */
  minMatchScore: number;
}

// Aggressive / store-biased defaults (D-WS9-037).
export const STORE_COMPOSE_DEFAULTS: StoreComposeConfig = {
  shortlistSize: 40,
  minMatchScore: 0,
};

const ENV_SHORTLIST_SIZE = "KIWI_STORE_SHORTLIST_SIZE";
const ENV_MIN_MATCH_SCORE = "KIWI_STORE_MIN_MATCH_SCORE";

function readNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve the store-compose threshold for this request. Reads env overrides at
 * call time (so tests can set process.env before invoking) and clamps to sane
 * bounds: shortlistSize to a non-negative integer, minMatchScore to [0,1].
 */
export function resolveStoreComposeConfig(): StoreComposeConfig {
  const shortlistSize = Math.max(
    0,
    Math.floor(
      readNumberEnv(ENV_SHORTLIST_SIZE, STORE_COMPOSE_DEFAULTS.shortlistSize),
    ),
  );
  const minMatchScoreRaw = readNumberEnv(
    ENV_MIN_MATCH_SCORE,
    STORE_COMPOSE_DEFAULTS.minMatchScore,
  );
  const minMatchScore = Math.min(1, Math.max(0, minMatchScoreRaw));
  return { shortlistSize, minMatchScore };
}
