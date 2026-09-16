// WS9 Redesign Arc Block 2a (D-WS9-245) — the two mix dials' UI rule, pinned
// as a pure function so the preferences screen, onboarding step 2 and the
// merged wizard share ONE implementation (they all render <MixDials>).
//
// "All on one dial forces None on the other." The server applies the same rule
// when it resolves the levels (applyAllForcesNone in
// artifacts/api-server/src/lib/wizardPreferences.ts) — the UI mirrors it so the
// user sees the state the server will act on, not a pair it will silently
// rewrite. The server's tie-break (both `all` → playlist wins) cannot arise
// through this helper: the dial the user just tapped is the one that keeps
// `all`, the other drops to `none`, so the two are never both `all` on the wire.

import type { DialLevel } from "@/lib/domain";

export interface DialState {
  playlistLevel: DialLevel;
  discoveryLevel: DialLevel;
}

/**
 * The next dial pair after the user sets `key` to `value`. Setting one dial to
 * "all" resets the OTHER to "none"; every other change touches one dial only.
 */
export function setDial(
  current: DialState,
  key: keyof DialState,
  value: DialLevel,
): DialState {
  const next: DialState = { ...current, [key]: value };
  if (value === "all") {
    const other: keyof DialState =
      key === "playlistLevel" ? "discoveryLevel" : "playlistLevel";
    next[other] = "none";
  }
  return next;
}
