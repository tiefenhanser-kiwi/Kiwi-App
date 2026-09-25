// BUG-223 — HOW MANY PROXY HOPS DO WE VOUCH FOR? CONFIGURATION, NOT A CONSTANT.
//
// Row 13 · Block 1 moved this function OUT of app.ts (where it was born and
// still runs) so a second reader can have it without importing app.ts, which
// builds the whole Express app as a side effect of being imported. app.ts
// re-exports it, so its existing call site and test are unchanged.
//
// ⚠️ DEFAULT 0 = TRUST NOTHING. On Cloud Run the correct value is 1 — exactly
// one hop, Google's front end — but it is UNSET and unmeasured today, which is
// why the guest per-IP cap (routes/guest.ts) is gated on this returning > 0.
//
// ⚠️ SET THE HOP COUNT, NEVER `true`. `true` trusts the whole chain and hands
// a spoofer back the very hole the original code closed.
export function parseTrustProxyHops(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return 0;
  const n = Number(raw);
  // Anything that is not a non-negative integer falls back to the safe value.
  // A typo in a deploy variable must not silently widen who we trust.
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}
