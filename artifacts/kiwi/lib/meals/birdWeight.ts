// THX-4 (D-WS9-324) — the "Turkey: 14 lb" stepper's rules, kept out of
// app/meal/[id].tsx because app/** is outside the test glob (D-WS9-164).
//
// The server decides everything the stepper may offer: a meal read with a
// planItemId of a meal holding a turkey the cook may weigh carries birdKind, the
// range {min, max, step, default}, birdWeightLb (null = the default bird) and
// birdShownLb (the weight the bird's line shows now). Whole bird 8–20 lb,
// spatchcock 8–16, in ½-lb steps; the breast is not weighable. This file only
// reads those fields, steps inside the range, and words the weight.

import type { MealDetail } from "@/lib/api/meals";
import { defaultBirdLb, formatNeedGlyph, isFeastMeal } from "@/lib/format/quantity";

export interface BirdWeightRange {
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface BirdStepper {
  kind: string;
  range: BirdWeightRange;
  /** The weight the cook saved, or null (the default bird). */
  chosen: number | null;
  /** The weight the bird's line shows at the saved servings. */
  shown: number;
}

/** The stepper's facts from a meal read, or null when the read carries no bird. */
export function birdStepperOf(
  meal: Pick<MealDetail, "birdKind" | "birdWeightLb" | "birdWeightRange" | "birdShownLb">,
): BirdStepper | null {
  const { birdKind, birdWeightRange, birdShownLb } = meal;
  if (birdKind === undefined || birdWeightRange === undefined || birdShownLb === undefined) return null;
  if (!(birdWeightRange.step > 0) || !(birdWeightRange.min <= birdWeightRange.max)) return null;
  return { kind: birdKind, range: birdWeightRange, chosen: meal.birdWeightLb ?? null, shown: birdShownLb };
}

const EPS = 1e-9;

/**
 * The next weight one step up (+1) or down (−1), on the range's grid and inside
 * it. A value off the grid (the servings rule's 11¼ lb) goes to the next grid
 * point that way: 11¼ → 11½ up, 11 down. Above the range (28 lb at 20 servings)
 * a step down lands on the max.
 */
export function stepBirdWeight(current: number, dir: 1 | -1, range: BirdWeightRange): number {
  const { min, max, step } = range;
  const next =
    dir > 0 ? (Math.floor(current / step + EPS) + 1) * step : (Math.ceil(current / step - EPS) - 1) * step;
  return Math.min(max, Math.max(min, next));
}

/** True when a step that way moves the weight (the button is enabled). */
export function canStepBird(current: number, dir: 1 | -1, range: BirdWeightRange): boolean {
  return dir > 0 ? current < range.max - EPS : current > range.min + EPS;
}

/**
 * The weight the stepper shows: the one the cook has stepped to (saved or not),
 * else the default bird's. The default is the server's birdShownLb while the
 * screen still shows what the server was told (no weight saved, servings as
 * saved); otherwise it is computed the server's way (quantity.ts defaultBirdLb) —
 * after a Reset of a saved weight, or with the servings stepped and not saved.
 */
export function shownBirdLb(args: {
  stepper: BirdStepper;
  displayLb: number | null;
  meal: Pick<MealDetail, "dishes" | "tags" | "effectiveServings">;
  displayServings: number;
  servingsMultiplier: number;
}): number {
  const { stepper, displayLb, meal, displayServings, servingsMultiplier } = args;
  if (displayLb !== null) return displayLb;
  if (stepper.chosen === null && displayServings === meal.effectiveServings) return stepper.shown;
  return defaultBirdLb(meal.dishes, servingsMultiplier, isFeastMeal(meal.tags)) ?? stepper.shown;
}

/** True when the stepped weight differs from the saved one (Save shows). */
export function birdWeightDirty(displayLb: number | null, stepper: BirdStepper | null): boolean {
  return stepper !== null && displayLb !== stepper.chosen;
}

/** 14 → "14 lb", 14.5 → "14½ lb", 11.25 → "11¼ lb". */
export function birdWeightLabel(lb: number): string {
  return `${formatNeedGlyph(lb)} lb`;
}
