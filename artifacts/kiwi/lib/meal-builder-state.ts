// WS7-6 Fix-Block 1 (Fix B) — pure-function helpers for the Meal Builder
// state. Extracted from app/meal-builder.tsx so the hydration + save
// serialization can be unit-tested directly (the per-dish step ownership
// fix is the load-bearing contract being pinned).
//
// Why a new file: the original meal-builder.tsx FLATTENED every dish's
// steps into one meal-level state at hydration, then RE-ATTACHED the
// whole flat array to dish[0] on save. Swapping dishes[1] left the old
// salad's steps stuck on dish[0]. The fix is per-dish step ownership in
// BuilderDish + matching hydration/save. Tests in this module's __tests__
// pin the swap-case and single-dish round-trip.
//
// These helpers are framework-agnostic (no React) — call sites pass in a
// uid allocator so the host module can keep its module-level counter.

import { isQuantityInvalid, parseQuantity } from "./quantity";
import { toServerDifficulty } from "./api/builder";
import type {
  MealDetail,
  SaveMealDish,
  SaveMealInput,
  UpdateMealInput,
} from "./api/meals";
import type { DraftDish } from "./builder/parsedDishToDraft";
import type { DraftMeal, RecipeOverride, SavedDish } from "./types";

export type Difficulty = "easy" | "medium" | "hard";

export interface BuilderIngredient {
  uid: number;
  quantity: string;
  unit: string;
  name: string;
}

export interface BuilderStep {
  uid: number;
  text: string;
  estimatedMinutes: string;
  isTimingSensitive?: boolean;
}

export interface BuilderDish {
  uid: number;
  name: string;
  ingredients: BuilderIngredient[];
  /** WS7-6 Fix-Block 1B (per-dish step ownership). Each dish owns its
   *  steps directly — matches the server's polymorphic
   *  (ownerType, ownerId) row model. The pre-fix builder flattened all
   *  dishes' steps into a single meal-level array at hydration and re-
   *  attached the whole array to dish[0] on save, so swapping dish[1]
   *  left stale steps on dish[0]. */
  steps: BuilderStep[];
}

export type UidAllocator = () => number;

// ── Factories (UI-side mutators reuse these) ─────────────────────────────

export function newIngredient(
  allocUid: UidAllocator,
  partial?: Partial<Omit<BuilderIngredient, "uid">>,
): BuilderIngredient {
  return {
    uid: allocUid(),
    quantity: partial?.quantity ?? "",
    unit: partial?.unit ?? "",
    name: partial?.name ?? "",
  };
}

export function newStep(
  allocUid: UidAllocator,
  partial?: Partial<Omit<BuilderStep, "uid">>,
): BuilderStep {
  return {
    uid: allocUid(),
    text: partial?.text ?? "",
    estimatedMinutes: partial?.estimatedMinutes ?? "",
    isTimingSensitive: partial?.isTimingSensitive,
  };
}

export function newDish(
  allocUid: UidAllocator,
  partial?: Partial<Omit<BuilderDish, "uid" | "ingredients" | "steps">> & {
    ingredients?: BuilderIngredient[];
    steps?: BuilderStep[];
  },
): BuilderDish {
  return {
    uid: allocUid(),
    name: partial?.name ?? "",
    ingredients: partial?.ingredients ?? [newIngredient(allocUid)],
    steps: partial?.steps ?? [],
  };
}

// ── Validation (WS7-6 Block 1F — save-disabled clarity) ─────────────────
//
// PRD §10.5.6: a meal needs a name, ≥1 ingredient, and ≥1 recipe step.
// Pre-F the screen-level predicate accepted ingredient-with-only-a-
// quantity (looser than the save serializer's name-filter, so a meal
// could pass `disabled=false` and still throw on tap) and never enforced
// the step requirement at all. F tightens the predicate to ingredient
// NAME (matching `serializeNewDishesForSave`'s filter) and adds the
// step requirement so a meal with no step text anywhere can't save.
//
// Single uniform walk over `dishes[].steps[]` covers both simple
// (1-dish) and composite (multi-dish) shapes — post-Fix-1B every step
// lives on its owning BuilderDish, so there is no meal-level steps
// surface to also check.

export interface ManualSaveValidation {
  /** No trimmed mealName. */
  nameMissing: boolean;
  /** No dish has any ingredient with a non-empty trimmed name. */
  ingredientMissing: boolean;
  /** No step anywhere has non-empty trimmed text. */
  stepMissing: boolean;
  /** A NAMED ingredient (one the serializer will keep) has a non-blank invalid
   *  quantity — unparseable or ≤ 0. Blank is allowed (defaults to 1 at save). */
  quantityInvalid: boolean;
}

export function validateManualSave(state: {
  mealName: string;
  dishes: BuilderDish[];
}): ManualSaveValidation {
  const nameMissing = state.mealName.trim().length === 0;
  const ingredientMissing = !state.dishes.some((d) =>
    d.ingredients.some((i) => i.name.trim().length > 0),
  );
  const stepMissing = !state.dishes.some((d) =>
    d.steps.some((st) => st.text.trim().length > 0),
  );
  // WS9 3f-2 FU3 — block save when a NAMED ingredient (the ones the serializer
  // keeps) has a non-blank invalid quantity. Blank stays allowed (→ 1).
  const quantityInvalid = state.dishes.some((d) =>
    d.ingredients.some(
      (i) => i.name.trim().length > 0 && isQuantityInvalid(i.quantity),
    ),
  );
  return { nameMissing, ingredientMissing, stepMissing, quantityInvalid };
}

// ── Hydration ────────────────────────────────────────────────────────────

/**
 * Map a server-side MealDetail into BuilderDish[], preserving per-dish
 * step ownership. The pre-fix code flattened all dishes' steps into a
 * single meal-level array; that was the root cause of the WS7-6 sub-dish-
 * swap bug.
 *
 * Legacy fallback: if every dish's steps array is empty AND the meal-
 * owned top-level `steps` array has rows (single-dish meals on older
 * data), drop those onto dish[0] so the steps still round-trip.
 */
export function hydrateBuilderDishesFromMeal(
  sourceMeal: MealDetail,
  allocUid: UidAllocator,
): BuilderDish[] {
  const allDishesHaveEmptySteps = sourceMeal.dishes.every(
    (d) => d.steps.length === 0,
  );
  const useLegacyMealLevelSteps =
    allDishesHaveEmptySteps && sourceMeal.steps.length > 0;

  return sourceMeal.dishes.map((d, i) => {
    const stepRows =
      useLegacyMealLevelSteps && i === 0 ? sourceMeal.steps : d.steps;
    return newDish(allocUid, {
      name: d.title,
      ingredients:
        d.ingredients.length > 0
          ? d.ingredients.map((ing) =>
              newIngredient(allocUid, {
                quantity: String(ing.quantity),
                unit: ing.unit,
                name: ing.name,
              }),
            )
          : [newIngredient(allocUid)],
      steps: stepRows.map((st) =>
        newStep(allocUid, {
          text: st.text,
          estimatedMinutes:
            st.estimatedMinutes && st.estimatedMinutes > 0
              ? String(st.estimatedMinutes)
              : "",
          isTimingSensitive: st.isTimingSensitive,
        }),
      ),
    });
  });
}

/**
 * Map a SavedDish (picked from DishChooserSheet) into a BuilderDish. The
 * picked dish must arrive in the builder fully hydrated — its own steps
 * AND ingredients — same as a server-hydrated existing dish. Mirrors
 * hydrateBuilderDishesFromMeal's per-dish mapping so the per-dish step
 * ownership from Fix-Block 1B carries through cleanly.
 *
 * WS7-6 Fix-Block 2 (B-2): the prior inline pick handler in
 * app/meal-builder.tsx mapped only name + ingredients and dropped
 * dish.steps unconditionally, so a saved dish with cooking steps arrived
 * with an empty steps section and round-tripped empty on save.
 */
export function pickSavedDishToBuilderDish(
  dish: SavedDish,
  allocUid: UidAllocator,
): BuilderDish {
  return newDish(allocUid, {
    name: dish.name,
    ingredients: dish.ingredients.map((ing) =>
      newIngredient(allocUid, {
        quantity: String(ing.quantity),
        unit: ing.unit,
        name: ing.name,
      }),
    ),
    steps: (dish.steps ?? []).map((st) =>
      newStep(allocUid, {
        text: st.text,
        estimatedMinutes:
          st.estimatedMinutes !== undefined && st.estimatedMinutes > 0
            ? String(st.estimatedMinutes)
            : "",
        isTimingSensitive: st.isTimingSensitive,
      }),
    ),
  });
}

/**
 * Map a single DraftDish (dish-side Ask Kiwi parse result) into a BuilderDish,
 * so the Meal Builder can APPEND a Kiwi-drafted dish to the meal under
 * construction in place — the same shape pickSavedDishToBuilderDish produces
 * for a saved-dish pick. WS7-6 G3-fix: this is what lets "Ask Kiwi" from the
 * Meal Builder's Add-a-dish sheet add the dish to THIS meal (and keep the user
 * on it) instead of saving a standalone dish and bouncing to Dish Detail.
 */
export function draftDishToBuilderDish(
  draft: DraftDish,
  allocUid: UidAllocator,
): BuilderDish {
  return newDish(allocUid, {
    name: draft.name,
    ingredients:
      draft.ingredients.length > 0
        ? draft.ingredients.map((ing) =>
            newIngredient(allocUid, {
              quantity: String(ing.quantity),
              unit: ing.unit,
              name: ing.name,
            }),
          )
        : [newIngredient(allocUid)],
    steps: draft.steps.map((st) =>
      newStep(allocUid, {
        text: st.text,
        estimatedMinutes:
          st.estimatedMinutes !== undefined && st.estimatedMinutes > 0
            ? String(st.estimatedMinutes)
            : "",
        isTimingSensitive: st.isTimingSensitive,
      }),
    ),
  });
}

/**
 * Map an imported DraftMeal into BuilderDish[]. Drafts carry a single
 * meal-level `steps[]` (the importer doesn't know about per-dish
 * ownership), so for a multi-dish draft all steps land on dish[0] — the
 * §10.5.4 "the meal IS the dish" collapse for the simple case naturally
 * extends to "the meal's steps live on its first dish" for drafts.
 */
export function hydrateBuilderDishesFromDraft(
  draftMeal: DraftMeal,
  allocUid: UidAllocator,
): BuilderDish[] {
  return draftMeal.dishes.map((d, i) =>
    newDish(allocUid, {
      name: d.name,
      ingredients:
        d.ingredients.length > 0
          ? d.ingredients.map((ing) =>
              newIngredient(allocUid, {
                quantity: String(ing.quantity),
                unit: ing.unit,
                name: ing.name,
              }),
            )
          : [newIngredient(allocUid)],
      steps:
        i === 0
          ? draftMeal.steps.map((st) =>
              newStep(allocUid, {
                text: st.text,
                estimatedMinutes:
                  st.estimatedMinutes !== undefined
                    ? String(st.estimatedMinutes)
                    : "",
                isTimingSensitive: st.isTimingSensitive,
              }),
            )
          : [],
    }),
  );
}

// ── Save serialization ──────────────────────────────────────────────────

/**
 * Build the dishes[] payload for POST /me/meals (and PATCH /me/meals/:id
 * via the same shape) from the builder's BuilderDish[]. Each dish emits
 * its OWN steps — NO collapse onto dish[0]. Filters out dishes that have
 * no non-empty ingredient names (matches the pre-fix behavior).
 *
 * Throws when no dish survives the ingredient filter — the caller
 * surfaces a friendly Alert.
 */
export function serializeNewDishesForSave(
  dishes: BuilderDish[],
  trimmedMealName: string,
): Extract<SaveMealDish, { kind: "new" }>[] {
  const newDishes: SaveMealDish[] = dishes.map((d, dishIdx) => {
    const cleanIngredients = d.ingredients
      .filter((i) => i.name.trim().length > 0)
      .map((i) => {
        const qty = parseQuantity(i.quantity);
        return {
          name: i.name.trim(),
          quantity: qty ?? 1,
          unit: i.unit.trim() || "unit",
        };
      });
    const cleanSteps = d.steps
      .filter((st) => st.text.trim().length > 0)
      .map((st) => {
        const min = parseInt(st.estimatedMinutes, 10);
        return {
          text: st.text.trim(),
          estimatedMinutes:
            Number.isFinite(min) && min > 0 ? min : undefined,
          isTimingSensitive: st.isTimingSensitive,
        };
      });
    return {
      kind: "new" as const,
      title:
        d.name.trim() ||
        (dishes.length === 1 ? trimmedMealName : `Dish ${dishIdx + 1}`),
      role: dishIdx === 0 ? "main" : "side",
      positionIndex: dishIdx,
      ingredients: cleanIngredients,
      steps: cleanSteps,
    };
  });
  return newDishes.filter(
    (d): d is Extract<SaveMealDish, { kind: "new" }> =>
      d.kind === "new" && d.ingredients.length > 0,
  );
}

// ── Top-level save payload builder ──────────────────────────────────────
// Used by the manual-mode save path so we can unit-test the full
// transformation (state → POST body). Combine-mode and validation
// branching stay in the screen — this helper only handles the manual
// flatten.

export interface ManualSaveSourceState {
  mealName: string;
  cuisineType: string;
  difficulty: Difficulty;
  estimatedTimeMinutes: string;
  servingsDefault: number;
  notes: string;
  dishes: BuilderDish[];
  sourceType: "manual" | "directed";
}

/**
 * Throws when there is no meal name, no surviving dish, or other
 * validation gates fail. The caller funnels the message into an Alert.
 */
export function buildManualSaveMealInput(
  state: ManualSaveSourceState,
): SaveMealInput {
  const trimmedName = state.mealName.trim();
  if (!trimmedName) {
    throw new Error("Add a meal name.");
  }
  const minutes = parseInt(state.estimatedTimeMinutes, 10);
  const baseMeta = {
    title: trimmedName,
    description: state.notes.trim() || undefined,
    cuisineType: state.cuisineType.trim() || undefined,
    servingsDefault: state.servingsDefault,
    estimatedTimeMinutes:
      Number.isFinite(minutes) && minutes > 0 ? minutes : undefined,
    difficulty: toServerDifficulty(state.difficulty),
    sourceType: state.sourceType,
  };
  const newDishes = serializeNewDishesForSave(state.dishes, trimmedName);
  if (newDishes.length === 0) {
    throw new Error("Add at least one dish with ingredients.");
  }
  return { ...baseMeta, dishes: newDishes };
}

// ── Edit-path PATCH body builder ─────────────────────────────────────────
// WS7-6 1F — translate the SaveMealInput's "new"-only dish shape into the
// PATCH /me/meals/:id wipe-and-recreate body. The builder doesn't track
// existing dish ids per row, so editing always re-creates the sub-graph
// (wipe-and-recreate is the server-side contract).
//
// WS7-8b BUG-002 — extracted from app/meal-builder.tsx so the corruption
// guard (servingsDefault is dropped from the edit PATCH) is unit-testable.
// Pure: a function of `input` only, no screen-state closure.
export function buildUpdateMealInput(input: SaveMealInput): UpdateMealInput {
  // WS7-8b BUG-002 — servingsDefault is intentionally NOT carried into the
  // PATCH body. Edit mode no longer authors servings (the stepper is
  // create-only): persisting a count that disagrees with the unscaled
  // ingredient amounts corrupts the canonical recipe. Servings is a
  // render-time concern on Meal Detail (servingsMultiplier).
  return {
    title: input.title,
    description: input.description ?? null,
    cuisineType: input.cuisineType ?? null,
    ...(input.estimatedTimeMinutes !== undefined
      ? { estimatedTimeMinutes: input.estimatedTimeMinutes }
      : {}),
    ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
    dishes: input.dishes,
  };
}

// ── Per-instance recipe override builder ────────────────────────────────
// WS7-7-A B5 — translate a save payload into a per-instance RecipeOverride
// (PRD §8.4.3) for the "just this time" path AND the apply-always instance
// write (D-WS7-141 Fix 1b). Maps each dish's ingredients in position order so
// the consolidator can re-resolve quantities for THIS plan only. "link" dishes
// (combine mode) carry no inline ingredients — they don't occur in an
// edit-from-plan recipe edit, but we emit an empty list defensively to keep
// dish-position alignment.
//
// WS7-7-A B5 follow-on — extracted from app/meal-builder.tsx so it can be the
// SINGLE source both save branches share (just-this-time and apply-always) and
// so the seed→serialize→override round-trip is unit-testable. Steps are
// intentionally omitted from the override (overrides are ingredient + title
// only; the read re-merges canonical steps) — see D-WS7-142.
export function buildRecipeOverride(input: SaveMealInput): RecipeOverride {
  return {
    titleOverride: input.title,
    dishes: input.dishes.map((d) => ({
      name: d.kind === "new" ? d.title : "Dish",
      ingredients:
        d.kind === "new"
          ? d.ingredients.map((ing) => ({
              name: ing.name,
              quantity: ing.quantity,
              unit: ing.unit,
            }))
          : [],
    })),
    createdAt: new Date().toISOString(),
  };
}
