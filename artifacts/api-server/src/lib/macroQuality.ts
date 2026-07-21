// D-WS9-050 G1 + G2 — macro quality guards.
//
// G1 sanityMacroFlags: plausibility checks on an estimator per-serving result.
//   FLAG-AND-LOG only — never clamp. A dish that trips a flag is surfaced for
//   human review, not silently rewritten (a clamped-but-wrong number is worse
//   than a flagged-but-visible one).
//
// G2 dishGroundingStatus: what fraction of a dish's counted (non-optional)
//   ingredients carried a USDA ref, so catalog macro quality is measurable.
//   "grounded" = the estimate was computed with refs; "unmatched" = model-only.

export interface MacroPerServing {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

// Per-DISH per-serving thresholds. The estimator runs once per dish, so these
// bound a single dish's serving, not a whole multi-dish meal.
//   - 1500 kcal/serving: no single home dish serving realistically exceeds this
//     (a whole indulgent MEAL can, but this fires per dish) — matches the
//     ruling's "1,500 kcal/serving" example.
//   - Atwater consistency: 4·protein + 4·carbs + 9·fat should track calories.
//     ±40% is deliberately loose (fiber, alcohol, rounding, sugar alcohols all
//     legitimately drift it) — it only catches GROSS inconsistency, e.g. a steak
//     returning 3 g protein against 600 kcal.
//   - A single macro cannot imply more energy than the stated calories (with a
//     10% tolerance for rounding): 4·protein ≤ 1.1·cal, 9·fat ≤ 1.1·cal.
export const MACRO_SANITY = {
  maxCaloriesPerServing: 1500,
  atwaterTolerance: 0.4,
  singleMacroTolerance: 1.1,
} as const;

export function sanityMacroFlags(
  m: MacroPerServing,
  thresholds: typeof MACRO_SANITY = MACRO_SANITY,
): string[] {
  const flags: string[] = [];
  const cal = m.calories;
  if (cal > thresholds.maxCaloriesPerServing) {
    flags.push(`calories/serving ${cal} > ${thresholds.maxCaloriesPerServing} (implausible for one dish)`);
  }
  for (const [name, g, kcalPerG] of [
    ["protein", m.proteinG, 4],
    ["fat", m.fatG, 9],
  ] as const) {
    if (g * kcalPerG > cal * thresholds.singleMacroTolerance && cal > 0) {
      flags.push(`${name} ${g}g implies ${Math.round(g * kcalPerG)} kcal > stated ${cal} kcal`);
    }
  }
  const atwater = 4 * m.proteinG + 4 * m.carbsG + 9 * m.fatG;
  if (cal > 0 && Math.abs(atwater - cal) / cal > thresholds.atwaterTolerance) {
    flags.push(
      `Atwater ${Math.round(atwater)} kcal vs stated ${cal} kcal (>${Math.round(thresholds.atwaterTolerance * 100)}% off)`,
    );
  }
  return flags;
}

export interface GroundingStatus {
  grounded: number; // non-optional ingredients with a per-100g ref
  counted: number; // total non-optional ingredients
  ratio: number; // grounded / counted (1 when counted === 0 — nothing to ground)
  stamp: "grounded" | "partial" | "unmatched";
}

// A macro is "grounded" when >=80% of its counted ingredients carried a ref,
// "unmatched" when none did, "partial" in between. Optional ingredients are
// excluded because the estimator skips them in the math (aiPrompts.ts step 2).
export function dishGroundingStatus(
  ingredients: Array<{ isOptional?: boolean; nutritionRefPer100g?: unknown }>,
  groundedThreshold = 0.8,
): GroundingStatus {
  const counted = ingredients.filter((i) => i.isOptional !== true);
  const grounded = counted.filter((i) => i.nutritionRefPer100g != null).length;
  const ratio = counted.length === 0 ? 1 : grounded / counted.length;
  const stamp =
    ratio >= groundedThreshold ? "grounded" : grounded === 0 ? "unmatched" : "partial";
  return { grounded, counted: counted.length, ratio, stamp };
}
