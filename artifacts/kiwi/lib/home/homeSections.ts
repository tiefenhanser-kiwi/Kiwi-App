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
// "leadLoading" is the placeholder that occupies the LEAD slot while GET /home
// is still in flight (WS9-2 2c Commit 2) — see the isLoading note below.
export type HomeSection = "leadLoading" | "arc" | "thisWeek" | "makeLane" | "rail";

export function homeSectionOrder(opts: {
  /** firstPlanCreatedAt == null (and payload loaded). */
  isFirstRun: boolean;
  /** heroModel.kind !== "empty" — there is a today/plan to show. */
  hasActivePlan: boolean;
  /** the Tried & True rail has at least one card. */
  hasRail: boolean;
  /**
   * WS9-2 2c Commit 2 — GET /home has not resolved yet, so we do NOT KNOW the
   * user's state. Optional (absent ⇒ false) so every pre-existing caller and
   * test keeps its exact behavior.
   *
   * This exists because "loading" and "genuinely has no plan" rendered
   * IDENTICALLY before this commit: deriveHeroModel(undefined) collapses to
   * `empty`, isFirstRun is false while the payload is undefined, and the rail
   * is empty — so the lead slot silently vanished and Home asserted "you have
   * no plan" for the whole request. That assertion is not merely absent
   * information, it is WRONG information, and on a cold start or a slow network
   * it is the first thing a returning user sees.
   *
   * While loading, the lead slot is held by a neutral placeholder instead of
   * collapsing. The make lane still renders (it is always available and makes
   * no claim about state); the rail's own late arrival is a layout pop, not a
   * false statement, and is deliberately left alone.
   */
  isLoading?: boolean;
}): HomeSection[] {
  const sections: HomeSection[] = [];
  // LEAD slot — above the make-lane eyebrow. Arc and the this-week module are
  // mutually exclusive in production (a first plan stamps firstPlanCreatedAt, so
  // a user with a plan is never first-run); both conditions stay independent so
  // a legacy null-stamp row still surfaces its this-week module.
  //
  // Loading PRE-EMPTS both: until the payload lands, isFirstRun and
  // hasActivePlan are both false-by-default rather than false-by-fact, so
  // branching on them would be branching on an unknown.
  if (opts.isLoading) {
    sections.push("leadLoading");
  } else {
    if (opts.isFirstRun) sections.push("arc");
    if (opts.hasActivePlan) sections.push("thisWeek");
  }
  sections.push("makeLane");
  if (opts.hasRail) sections.push("rail");
  return sections;
}
