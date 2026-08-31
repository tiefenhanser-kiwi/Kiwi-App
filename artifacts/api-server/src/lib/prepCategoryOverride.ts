// WS9 BUG-186 — prep-category override.
//
// BUG-186 moved 21 Ingredient rows to their correct grocery aisle ("if it's
// cheese it's in dairy", Hans, August 29). `Ingredient.category` is read by
// THREE independent places in the prep pipeline, not one:
//
//   1. assignPhase                (prepCombineEngine.ts) — which phase, or none
//   2. detectBlendComponents      (prepCombineEngine.ts) — `category !== "pantry"`
//                                  skips the row, and the 3+ threshold means
//                                  dropping one row can un-blend OTHERS
//   3. classifyPrepWorthy         (prepCombineEngine.ts) — switches on category;
//                                  `default: return "exclude"` for Dairy/Bakery/
//                                  Frozen/Canned/unknown
//
// So an aisle move silently rewires Prep Week. Overriding only the PHASE would
// leave (2) and (3) reading the new category and disagreeing with it — a
// hard-boiled egg would get a proteins phase and then be excluded by (3).
//
// This module instead overrides the CATEGORY TOKEN THE PREP PIPELINE SEES,
// resolved once in the loader (prepWeekAggregation.ts). The engine is unchanged
// and all three reads stay mutually consistent by construction: if the prep
// engine sees the token it saw before, its output is identical, full stop.
//
// THE RULINGS THIS TABLE ENCODES (Hans, August 31 2026):
//   • Eggs OUT — "you're not going to scramble or crack or mix an egg on Sunday
//     for a meal on Thursday." `large eggs` deliberately leaves Prep Week.
//   • Hard-boiled eggs IN — "hardboiling eggs is a good exception for something
//     you can do during prep… the user can be cutting onions while that
//     happens." The ONE egg exception.
//   • Cheese PRESERVED — "grating cheese as prep is fine."
//   • Tofu PRESERVED — pressing/marinating is real make-ahead prep.
//   • Dry pasta stays OUT — nothing new enters Prep Week from the aisle move.
//
// Keyed on the normalized ingredient NAME (the engine carries displayName).
// A canonical rename would silently unlink an entry, so
// prepCategoryOverride.test.ts asserts every key still resolves against a
// catalog-generated fixture.

import { normalizeIngredientName } from "./groceryNormalization";

/**
 * Normalized ingredient name → the category token the PREP pipeline should
 * see. Never affects `Ingredient.category` itself, and therefore never affects
 * the grocery aisle (CATEGORY_TO_SECTION reads the real column).
 */
export const PREP_CATEGORY_OVERRIDE: Record<string, string> = {
  // ── Cheese ×13: aisle moved Pantry → Dairy; prep pinned to Pantry so the
  // name-hint split (seasonings_dry / sauces_marinades), blend eligibility and
  // prep-worthy tier are all byte-identical to before.
  "parmigiano-reggiano": "Pantry",
  "pecorino romano": "Pantry",
  "queso fresco": "Pantry",
  paneer: "Pantry",
  "parmigiano-reggiano rind": "Pantry",
  "shaved parmigiano-reggiano": "Pantry",
  "grated pecorino romano": "Pantry",
  "parmigiano reggiano": "Pantry",
  "finely grated parmigiano-reggiano": "Pantry",
  fontina: "Pantry",
  "freshly grated parmigiano-reggiano": "Pantry",
  "gorgonzola dolce": "Pantry",
  "parmigiano-reggiano, finely grated": "Pantry",

  // ── Tofu ×3: aisle moved Protein → Dairy; prep pinned to Protein so the
  // proteins phase and the "uncertain" prep-worthy tier survive.
  "extra-firm tofu": "Protein",
  "firm tofu": "Protein",
  "silken tofu": "Protein",

  // ── Egg pasta ×4: aisle moved Dairy → Pantry. Pinned to Dairy so they stay
  // phase-less — the aisle fix must not ADD anything to Prep Week.
  "wide egg noodles": "Dairy",
  "fresh chow mein egg noodles": "Dairy",
  "fresh lo mein egg noodles": "Dairy",
  "egg noodles": "Dairy",

  // ── The one deliberate REMOVAL: large eggs leave Prep Week with the aisle
  // move (Protein → Dairy → no phase). This entry is a documented NO-OP — the
  // row's new category is already Dairy — recorded so the ruling is auditable
  // in the table rather than implied by an absence.
  "large eggs": "Dairy",

  // ── The one deliberate ADDITION: hard-boiled eggs do NOT move aisle (already
  // Dairy) but are pinned to Protein so they gain the proteins phase AND the
  // "uncertain" prep-worthy tier. Pinning the phase alone would not surface
  // them — classifyPrepWorthy's default branch excludes Dairy.
  "hard-boiled eggs": "Protein",
};

/**
 * The category the prep pipeline should use for this ingredient. Falls through
 * to the row's real `Ingredient.category` when no override exists, so every
 * un-listed row is unchanged by construction.
 */
export function resolvePrepCategory(name: string, category: string): string {
  return PREP_CATEGORY_OVERRIDE[normalizeIngredientName(name)] ?? category;
}
