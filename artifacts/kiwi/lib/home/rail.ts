// WS9-2 2c (D-WS9-154) — Tried & True rail view-model.
//
// Replaces lib/home/triedTrue.ts. That module existed to flatten and de-dupe
// THREE separate per-badge queries; the server now returns one ordered list, so
// there is nothing left to merge. What remains is display mapping, which is what
// this file is: badge label and meta line, both pure, both copy.
//
// The emitted item shape is unchanged (id / occasion / title / image / meta) so
// TriedTrueCard is untouched.

import type { RailPlanItem } from "@/lib/api/home";

export interface TriedTrueItem {
  id: string;
  occasion: string;
  title: string;
  image: string | null;
  meta: string | null;
}

// Badge precedence, preserved from the retired TRIED_TRUE_BADGES order: Hosting
// leads, then Featured. A row carrying BOTH flags shows as Hosting, exactly as
// the old first-badge-wins dedupe did.
//
// A row with NEITHER flag still reaches the rail (railPosition is the membership
// test, not the flags) and keeps the "Top Rated" label the old top_rated bucket
// gave it. ⚠️ That label is not currently backed by anything: topRatedScore is
// null on every row and nothing computes it (recomputeAndPersistTopRated has no
// call site), so the old bucket was really useCount-ordered. Preserved as-is
// because 2c rules the ORDER, not the badge vocabulary — but it is a known
// overclaim, not an endorsement.
export const BADGE_HOSTING = "Hosting";
export const BADGE_FEATURED = "Featured";
export const BADGE_TOP_RATED = "Top Rated";

export function railBadge(row: {
  isFeatured: boolean;
  isHostingFeatured: boolean;
}): string {
  if (row.isHostingFeatured) return BADGE_HOSTING;
  if (row.isFeatured) return BADGE_FEATURED;
  return BADGE_TOP_RATED;
}

/**
 * The meta line under the title. `tags[0]`, EXCEPT when it just restates the
 * badge already shown on the pill above it.
 *
 * Live data made this obvious: three of the six rail cards rendered the literal
 * word "hosting" directly beneath a pill reading "Hosting". Comparison is
 * case-insensitive and trims, because tags are free-form lowercase strings
 * ("hosting") while badges are display-cased ("Hosting").
 */
export function railMeta(
  tags: readonly string[],
  badge: string,
): string | null {
  const first = tags[0]?.trim();
  if (!first) return null;
  if (first.toLowerCase() === badge.trim().toLowerCase()) return null;
  return first;
}

/**
 * Map the server's ordered rail rows to render items. Order is the server's —
 * railPosition ASC, createdAt DESC — and is NOT re-sorted here. Curation is a
 * data decision; re-sorting on the client would silently override it.
 */
export function buildRailItems(
  rows: readonly RailPlanItem[],
): TriedTrueItem[] {
  return rows.map((row) => {
    const occasion = railBadge(row);
    return {
      id: row.id,
      occasion,
      title: row.name,
      image: row.image,
      meta: railMeta(row.tags, occasion),
    };
  });
}
