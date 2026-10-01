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
// "error" is WHOLE-SCREEN and exclusive — see the note on `isError` below.
export type HomeSection =
  | "error"
  | "leadLoading"
  | "arc"
  | "thisWeek"
  | "makeLane"
  | "rail";

export function homeSectionOrder(opts: {
  /** firstPlanCreatedAt == null (and payload loaded). */
  isFirstRun: boolean;
  /** heroModel.kind !== "empty" — there is a today/plan to show. */
  hasActivePlan: boolean;
  /** the Featured-plans rail has at least one card. */
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
  /**
   * Sept 29 design review, item 14 — GET /home FAILED (or was aborted by the
   * client-side timeout in useHomePayload). Optional (absent ⇒ false) so every
   * pre-existing caller and test keeps its exact behaviour.
   *
   * ⚠️ ERROR IS NOT EMPTY, and before this the two were INDISTINGUISHABLE — but
   * not in the way the review assumed. On a failed load React Query reports
   * isLoading false and data undefined, so isFirstRun is false, deriveHeroModel
   * collapses to "empty" and hasActivePlan is false. The order that came back was
   * ["makeLane"] — not the new-account screen (a genuine first run renders the
   * teaching arc) but something STRICTLY EMPTIER than either real state: no lead
   * slot at all, no arc, no explanation, and a silent implicit claim that the
   * user has no plan this week.
   *
   * That is a WRONG statement, not a missing one, which is the same diagnosis
   * isLoading carries above — and it is why error PRE-EMPTS everything,
   * including the make lane. The make lane would still function (it needs no
   * payload), but half a screen beside "we couldn't reach Kiwi" reads as a
   * partial success. One state, one claim.
   */
  isError?: boolean;
}): HomeSection[] {
  // ⚠️ FIRST, AND EXCLUSIVE. Error outranks loading because a settled failure is
  // knowledge and "still loading" is not; a request that errors is not pending.
  if (opts.isError) return ["error"];

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
