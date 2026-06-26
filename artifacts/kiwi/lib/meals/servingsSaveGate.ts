// WS7-8 BUG-003 B2.2 (PRD §10.6.1) — pure predicates for the plan-instance
// servings Save gate on Meal Detail.
//
// The in-plan stepper changes the DISPLAYED servings only; it no longer writes
// per tap. Persistence is an explicit "Save changes" affordance that appears
// ONLY when the plan instance is dirty. These predicates are the single source
// of truth shared by the screen (app/meal/[id].tsx) and its tests, so the
// tested logic is exactly the logic that runs.

/** Clamp a stepper target into the screen's [min, max] servings range. */
export function clampServings(next: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, next));
}

/**
 * Dirty = the displayed (stepped) value diverges from the server-resolved
 * (saved) effectiveServings. A clean instance has display === saved.
 */
export function isServingsDirty(
  displayServings: number,
  effectiveServings: number,
): boolean {
  return displayServings !== effectiveServings;
}

/**
 * The Save affordance is offered ONLY in a plan context (`canPersist`, i.e.
 * planId && planItemId present) AND only when the instance is dirty. The
 * library/canonical Meal Detail (no plan context → canPersist === false) never
 * shows Save and persists nothing — canonical Save is Sub-block 3.
 */
export function shouldShowSaveServings(
  canPersist: boolean,
  displayServings: number,
  effectiveServings: number,
): boolean {
  return canPersist && isServingsDirty(displayServings, effectiveServings);
}
