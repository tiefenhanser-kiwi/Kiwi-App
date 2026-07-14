// WS9 Block 3a — Home body section ORDER (ruled contract, D-WS9-025 + the
// this-week-module ruling which supersedes the mockup's bottom .secrow).
//
// The order is a ruled contract, not a loose layout choice. Two load-bearing
// rules the device tests pinned:
//   1. The state-specific LEAD — teaching arc (first-run) or the this-week
//      module (returning) — sits ABOVE the make-lane eyebrow.
//   2. The utility row (Grocery List · Prep & Cook) lives INSIDE the this-week
//      module, directly under the strip — its actions only mean anything in the
//      context of the plan above them, and R4 demotes grocery to a post-plan
//      tool. So there is NO standalone "utility" section: it is rendered as part
//      of "thisWeek", making it STRUCTURALLY IMPOSSIBLE to show without a plan
//      (G5 — nothing styled-but-dead). One condition (hasActivePlan), no second
//      boolean that could drift.
//
// The Home screen renders by mapping over this array, so the order lives in one
// tested place instead of raw JSX that can silently be reshuffled.

// "thisWeek" is a compound section: eyebrow + tonight strip + utility row.
export type HomeSection = "arc" | "thisWeek" | "makeLane" | "rail";

export function homeSectionOrder(opts: {
  /** firstPlanCreatedAt == null (and payload loaded). */
  isFirstRun: boolean;
  /** heroModel.kind !== "empty" — there is a today/plan to show. */
  hasActivePlan: boolean;
  /** the Tried & True rail has at least one card. */
  hasRail: boolean;
}): HomeSection[] {
  const sections: HomeSection[] = [];
  // LEAD slot — above the make-lane eyebrow. Arc and the this-week module are
  // mutually exclusive in production (a first plan stamps firstPlanCreatedAt, so
  // a user with a plan is never first-run); both conditions stay independent so
  // a legacy null-stamp row still surfaces its this-week module.
  if (opts.isFirstRun) sections.push("arc");
  if (opts.hasActivePlan) sections.push("thisWeek");
  sections.push("makeLane");
  if (opts.hasRail) sections.push("rail");
  return sections;
}
