// WS9 Redesign Arc Block 1 (D-WS9-237 / D-WS9-244 / D-WS9-245) — composition
// of the Pick screen's list. PURE: the route gathers the three sources and
// this decides how many of each, in what order. Kept out of the route so the
// dial arithmetic is unit-tested with literal expectations.
//
// The list of `size`, in order:
//   1. PINNED — meals the user NAMED in their text that title-matched a public
//      catalog meal (Tell Kiwi path). Always first; count against size.
//   2. PLAYLIST — the user's own declared go-to meals. Count = playlistLevel
//      resolved against size (none/omitted = 0 · some = ceil(size × 0.3) ·
//      mostly = ceil(size × 0.7) · all = every eligible playlist meal and
//      NOTHING from the shelf; `playlistOnly` ≡ all).
//   3. SHELF — the catalog shortlist for the remainder, re-ordered by the
//      discovery dial: omitted = the shelf's own order (today) · none =
//      familiar first, new-to-you fills · some / mostly / all = at least
//      ceil(remainder × 0.3 / 0.7 / 1.0) new-to-you meals when available,
//      then the rest by rank.
// All-forces-None is applied by the caller (applyAllForcesNone) before the
// levels reach here. Sort within a group is the source's own order (catalog
// rank for the shelf; the caller's order for playlist + pins).

import { levelToCount, type DiscoveryLevel, type PlaylistLevel } from "../wizardPreferences";

export interface ShelfComposeShelfRow {
  id: string;
  isNewToYou: boolean;
}

export interface ShelfComposeInput {
  /** The number of cards the client asked for (1..20, default 15). */
  size: number;
  /** Real ids, in the order they should appear. */
  pinnedIds: string[];
  /** The user's ELIGIBLE playlist meal ids (own meals; allergen + difficulty already applied), ordered. */
  playlistIds: string[];
  playlistLevel: PlaylistLevel;
  /** The catalog shortlist in its own (rank) order, with the new-to-you flag. Already excludes shown/playlist sources. */
  shelf: ShelfComposeShelfRow[];
  /** undefined = no reordering (today's behaviour). */
  discoveryLevel: DiscoveryLevel | undefined;
}

export interface ShelfComposedMeal {
  id: string;
  source: "playlist" | "shelf";
  isPinned: boolean;
}

export interface ShelfComposeResult {
  meals: ShelfComposedMeal[];
  /** How many shelf slots were asked for (0 when the playlist dial is `all`). */
  shelfRemainder: number;
  playlistCount: number;
  pinnedCount: number;
}

/**
 * The shelf slots the composition will need for the remainder, computed
 * BEFORE the shelf is retrieved so the route can ask the shortlist for exactly
 * that many (plus over-fetch for the discovery reorder). `all` on the playlist
 * dial → 0: nothing from the shelf.
 */
export function shelfRemainderFor(input: {
  size: number;
  pinnedCount: number;
  playlistEligibleCount: number;
  playlistLevel: PlaylistLevel;
}): { pinnedCount: number; playlistCount: number; shelfRemainder: number } {
  const pinnedCount = Math.min(input.pinnedCount, input.size);
  const room = input.size - pinnedCount;
  const playlistWanted =
    input.playlistLevel === "all"
      ? input.playlistEligibleCount
      : levelToCount(input.playlistLevel, input.size);
  const playlistCount = Math.min(playlistWanted, input.playlistEligibleCount, room);
  const shelfRemainder =
    input.playlistLevel === "all" ? 0 : Math.max(0, room - playlistCount);
  return { pinnedCount, playlistCount, shelfRemainder };
}

/**
 * Re-order the shelf rows by the discovery dial. Stable within each group so
 * the shelf's own rank order survives.
 */
export function orderShelfByDiscovery(
  rows: ShelfComposeShelfRow[],
  discoveryLevel: DiscoveryLevel | undefined,
  remainder: number,
): ShelfComposeShelfRow[] {
  if (discoveryLevel === undefined) return rows;
  const fresh = rows.filter((r) => r.isNewToYou);
  const familiar = rows.filter((r) => !r.isNewToYou);
  if (discoveryLevel === "none") return [...familiar, ...fresh];
  const target = levelToCount(discoveryLevel, remainder);
  const lead = fresh.slice(0, target);
  const taken = new Set(lead.map((r) => r.id));
  return [...lead, ...rows.filter((r) => !taken.has(r.id))];
}

export function composeShelf(input: ShelfComposeInput): ShelfComposeResult {
  const counts = shelfRemainderFor({
    size: input.size,
    pinnedCount: input.pinnedIds.length,
    playlistEligibleCount: input.playlistIds.length,
    playlistLevel: input.playlistLevel,
  });
  const pinnedSet = new Set(input.pinnedIds.slice(0, counts.pinnedCount));
  const meals: ShelfComposedMeal[] = [];
  for (const id of pinnedSet) {
    meals.push({ id, source: "shelf", isPinned: true });
  }
  for (const id of input.playlistIds.slice(0, counts.playlistCount)) {
    if (pinnedSet.has(id)) continue;
    meals.push({ id, source: "playlist", isPinned: false });
  }
  const ordered = orderShelfByDiscovery(
    input.shelf.filter((r) => !pinnedSet.has(r.id)),
    input.discoveryLevel,
    counts.shelfRemainder,
  );
  for (const row of ordered.slice(0, counts.shelfRemainder)) {
    meals.push({ id: row.id, source: "shelf", isPinned: false });
  }
  return {
    meals,
    shelfRemainder: counts.shelfRemainder,
    playlistCount: counts.playlistCount,
    pinnedCount: counts.pinnedCount,
  };
}
