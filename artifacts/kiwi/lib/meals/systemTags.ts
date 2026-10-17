// BOOK-1C2 — BUG-416: Meal.tags carries the system's own markers next to the
// tags a person would read, and every surface that rendered Meal.tags printed
// them: "thanksgiving-alternate" and "course-turkey" as chips on a meal's
// detail, "thanksgiving" as a pill on its card.
//
// The markers (dev, Oct 16 — 129 distinct tags over every live meal):
//   • `thanksgiving`, `thanksgiving-*` — the season's membership and roles
//     (THX-2G writes them: -alternate, -feast, -leftovers);
//   • `course-*` — the season's course chips (course-turkey, -potatoes,
//     -dessert, -cranberry …);
//   • `dev` — the dev seed's marker (prisma/seeds/devData.ts DEV_TAG), on 39
//     dev rows.
// They stay on the row (the Cookbook's season, course and shelf filters read
// them server-side); they are just never shown. One rule, here, for every
// surface: lib/meals/cardPills.ts and meal detail's tag chips.

const SYSTEM_TAGS = new Set(["thanksgiving", "dev"]);
const SYSTEM_TAG_PREFIXES = ["thanksgiving-", "course-"];

/** A tag the system writes for itself (case- and space-insensitive). */
export function isSystemTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return SYSTEM_TAGS.has(t) || SYSTEM_TAG_PREFIXES.some((p) => t.startsWith(p));
}

/** The tags a person should see, in their stored order. */
export function visibleMealTags(tags: readonly string[] | null | undefined): string[] {
  return (tags ?? []).filter((t) => !isSystemTag(t));
}
