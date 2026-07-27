// Plan-Gen Arc · Block 4b-1 (D-WS9-075) — deterministic seeded sampling for the
// shortlist. Selection must vary per user (two users with identical prefs must NOT
// get the same 40) and rotate across a user's plans, yet be fully deterministic
// and reproducible (no Date.now/Math.random) so it's testable and a re-request
// with the same salt is stable. We seed a small PRNG from hash(userId + salt) and
// draw a rank-weighted sample without replacement.

/** FNV-1a 32-bit string hash → non-zero uint32 seed. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Ensure non-zero (mulberry32 tolerates 0 but keep it clean).
  return (h >>> 0) || 0x9e3779b9;
}

/** mulberry32 — tiny, well-distributed seedable PRNG in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience: build a PRNG seeded by a string. */
export function rngFromString(seed: string): () => number {
  return mulberry32(hashString(seed));
}

/**
 * Weighted sampling WITHOUT replacement (Efraimidis-Spirakis). For each item draw
 * key = rng()^(1/weight); the k largest keys win — items with larger weight are
 * proportionally more likely, but every positive-weight item retains a chance
 * (preserving reach into the tail). Deterministic for a given `rng`. Items with
 * weight <= 0 are skipped. Returns at most k items (fewer if the pool is smaller).
 */
export function weightedSampleWithoutReplacement<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  k: number,
  rng: () => number,
): T[] {
  if (k <= 0) return [];
  const keyed: { item: T; key: number }[] = [];
  for (const item of items) {
    const w = weightOf(item);
    if (w <= 0) continue;
    // rng() in [0,1); guard the 0 case so the key is well-defined.
    const u = rng() || Number.MIN_VALUE;
    keyed.push({ item, key: Math.pow(u, 1 / w) });
  }
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, k).map((e) => e.item);
}
