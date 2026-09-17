// WS9-2 2e (D-WS9-157 / D-WS9-159 / D-WS9-161) — which controls Plan Review
// renders, per plan state. Pure; no React, no network.
//
// WHY THIS FILE EXISTS AT ALL: app/plan/[id].tsx is outside the test runner's
// glob, so every branch in it has historically been unguarded. That is exactly
// how the composted state shipped with the D-WS9-090 guard applied to the
// action bar ONLY, leaving the name editor, the date editor, the Cook This Week
// pill, Add Meals and every row-level mutation live on a soft-deleted plan.
// Following the lib/plans/planLifecycleActions.ts precedent, the branch
// decisions live here where they can be pinned, and the screen consumes the
// result rather than re-deriving booleans inline.
//
// ⚠️ THE SCREEN MUST READ THESE FLAGS, NOT RE-DERIVE THEM. A test that pins
// this table only guards the screen for as long as the screen is the table's
// consumer. If you find yourself writing `isComposted ? … : …` in the JSX,
// add a flag here instead.

/**
 * The three states Plan Review can render CONTENT in. The load/error gates
 * are not here: they return early from the screen with no plan to describe,
 * so they have no surface to decide.
 *
 * lane-pfc Part C.3 — the "draft" state (an unsaved wizard candidate reached
 * with `?draftId=`) is GONE: D-WS9-191 §4.7 ruled the unsaved-draft state
 * out of existence (a plan is only reviewed after it is saved; the chooser
 * card owns save / activate), the screen deletion that followed left nothing
 * that could route here with a draftId, and app/plan/[id].tsx no longer
 * carries the branch. A table state the screen can never reach is the same
 * trap as a flag hard-coded false — so it is removed rather than left
 * "for later".
 *
 * ⚠️ There is deliberately no "past" state. PlanDetail.status exists on the
 * wire but the screen has never read it, so a past plan renders as a live one
 * (logged as BUG-090 — NOT this block's to fix).
 */
export type PlanReviewState = "composted" | "liveInactive" | "liveThisWeek";

export function planReviewState(opts: {
  /** GET /plans/:id returned a non-null compostedAt — soft-deleted. */
  isComposted: boolean;
  /** Server-resolved this-week winner. */
  isActiveThisWeek: boolean;
}): PlanReviewState {
  // Composted wins over active-this-week: compost does not clear
  // isActiveThisWeek optimistically, and a just-composted active plan must
  // not render the live surface.
  if (opts.isComposted) return "composted";
  return opts.isActiveThisWeek ? "liveThisWeek" : "liveInactive";
}

/** How the sage header band presents the plan's identity. */
export type PlanReviewHeaderBand =
  /** Name / dates / meal count as PLAIN TEXT — read-only, not tappable. */
  | "staticMeta"
  /** The editable meta strip: inline name editor + date-range editor. */
  | "editors";

export interface PlanReviewSurface {
  headerBand: PlanReviewHeaderBand;
  /** The Cook This Week chip (inactive) / This Week's Plan badge (active). */
  showThisWeekSlot: boolean;
  /** Composted notice + the standalone "Use again" — the user's only way back. */
  showCompostedBar: boolean;
  /** The five-cell action panel (D-WS9-157). Live states only. */
  showActionPanel: boolean;
  /** Breakfast / Lunch defaults collapsibles. */
  showMealDefaults: boolean;
  /**
   * PlanReviewMealRow.readOnly — hides Cook Now + the four edit actions and
   * makes row taps / day pills no-ops (inert; the draft guard is gone).
   */
  rowsReadOnly: boolean;
}

const SURFACES: Record<PlanReviewState, PlanReviewSurface> = {
  // D-WS9-159 — GENUINELY read-only. Compost is a soft-delete and the row's
  // whole graph is intact, so the plan stays reachable by direct navigation and
  // must NOT 404 — reporting a user's own intact data as nonexistent is worse
  // than showing it. The meals stay VISIBLE BUT INERT so the user can see what
  // was in the plan and decide whether to bring it back; "Use again" is the
  // only way back and must survive.
  composted: {
    headerBand: "staticMeta",
    showThisWeekSlot: false,
    showCompostedBar: true,
    showActionPanel: false,
    showMealDefaults: false,
    rowsReadOnly: true,
  },
  liveInactive: {
    headerBand: "editors",
    showThisWeekSlot: true,
    showCompostedBar: false,
    showActionPanel: true,
    showMealDefaults: true,
    rowsReadOnly: false,
  },
  liveThisWeek: {
    headerBand: "editors",
    showThisWeekSlot: true,
    showCompostedBar: false,
    showActionPanel: true,
    showMealDefaults: true,
    rowsReadOnly: false,
  },
};

export function planReviewSurface(state: PlanReviewState): PlanReviewSurface {
  return SURFACES[state];
}
