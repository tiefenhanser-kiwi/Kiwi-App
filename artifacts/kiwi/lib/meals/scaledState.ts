// Plan-Gen Arc · Block 4a piece 2 (retires D-WS7-214) — the single "this meal is
// being made at a different size than it was authored for" signal.
//
// Both the scaled step-text treatment and the bakeware advisory hang off THIS
// one predicate, so the two surfaces can never disagree about whether a meal is
// scaled. Deliberately an HONEST advisory, never a computed pan size: a
// confidently-wrong "use an 8×8 pan" is a trust failure, whereas "this was
// scaled — double-check your dish size" is always true and never wrong.
//
// Server work (Block 4a piece 1) makes this meaningful: a catalog meal forked
// into a 2-person household now carries servingsDefault=2 with the authored
// anchor preserved at 4, so effectiveServings (2) ≠ authoredServingsDefault (4)
// and this returns true. The visible banner that renders off this signal is a
// UI-block follow-up (this block ships no screens); the predicate + copy are the
// reusable, tested foundation both surfaces will import.

/**
 * True when the meal is being rendered at a serving count different from the
 * one its recipe/step-text/bakeware were authored against — i.e. it has been
 * scaled and the authored physical instructions (pan size, "spread evenly in
 * the dish") may no longer fit.
 *
 * `effectiveServings` is the plan-resolved (or stepper-displayed) target;
 * `authoredServingsDefault` is the immutable authored anchor (the render
 * denominator). Returns false when the anchor is absent/degenerate (legacy rows
 * with a null anchor, or a non-positive value) — with no trustworthy anchor we
 * make no scaled claim rather than a false one.
 */
export function isScaledFromAuthored(
  effectiveServings: number,
  authoredServingsDefault: number | null | undefined,
): boolean {
  if (authoredServingsDefault == null || authoredServingsDefault <= 0) {
    return false;
  }
  return effectiveServings !== authoredServingsDefault;
}

/**
 * The honest bakeware advisory copy (NOT a computed pan size). Shown when
 * {@link isScaledFromAuthored} is true. Kept here so the wording lives with the
 * predicate that gates it.
 */
export const SCALED_BAKEWARE_ADVISORY =
  "This meal has been scaled from its original servings — double-check your pan or dish size before you start.";
