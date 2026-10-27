// CLIENT-3 A (BUG-528) — Edit meal → Add dish → a saved dish, on a plan meal.
//
// Hans's server log: GET /me/dishes → GET /meals/:id → PATCH /plans/:id/items/:itemId
// (200) and no write of the dish anywhere. Two causes, both pinned here:
//   1. the sheet's row is a GET /me/dishes list item (no ingredients, no steps),
//      and the pick appended it as it was: an empty dish the save serializer drops;
//   2. "Just this time" writes only the per-plan override, which pairs dishes by
//      position with the meal's own, so a dish past the last one is dropped on read.
// The round trip below goes list row → full read → builder → save input → the
// override and the recipe PATCH body the screen sends.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PICK_DISH_ERROR_BODY,
  PICK_DISH_ERROR_TITLE,
  pickSavedDish,
  type PickSavedDishDeps,
} from "../pickSavedDish";
import {
  buildManualSaveMealInput,
  buildRecipeOverride,
  buildStepEditMealInput,
  buildUpdateMealInput,
  dishAddsPresent,
  dishDetailToBuilderDish,
  hydrateBuilderDishesFromMeal,
  pickSavedDishToBuilderDish,
  recipeEditsLine,
  serializeNewDishesForSave,
  stepEditsPresent,
  type BuilderDish,
} from "../../meal-builder-state";
import { savedDishFromListItem } from "../../dishes/savedDishFromListItem";
import type { DishDetail, DishListItem } from "../../api/dishes";
import type { MealDetail } from "../../api/meals";
import type { SavedDish } from "../../types";

function makeAlloc(): () => number {
  let i = 1;
  return () => i++;
}

function step(stepIndex: number, text: string, minutes = 5) {
  return {
    stepIndex,
    text,
    estimatedMinutes: minutes,
    phaseType: "cook",
    parallelGroup: null,
    requiresPreheat: false,
    requiresRest: false,
    requiresMarination: false,
    isTimingSensitive: false,
  };
}

function ing(name: string, quantity: number, unit: string) {
  return { name, quantity, unit, preparationNote: null, category: "Pantry", isOptional: false };
}

// The plan item's meal (the user's own copy): one dish, written for 4.
function planMeal(): MealDetail {
  return {
    id: "meal-fork",
    title: "Lemon Chicken",
    cuisine: "American",
    minutes: 30,
    servings: 4,
    authoredServingsDefault: 4,
    effectiveServings: 4,
    calories: 500,
    protein: 40,
    carbs: 20,
    fat: 20,
    tags: [],
    image: null,
    description: null,
    difficulty: "easy",
    mealType: "dinner",
    sourceType: "manual",
    isPublic: false,
    userId: "u1",
    notes: null,
    dishes: [
      {
        dishId: "dish-chicken",
        title: "Lemon chicken",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 30,
        difficulty: "easy",
        servings: 4,
        authoredServingsDefault: 4,
        ingredients: [ing("Chicken thighs", 2, "lb")],
        steps: [step(0, "Roast the chicken", 25)],
      },
    ],
    steps: [],
  };
}

// The saved dish as the sheet lists it (GET /me/dishes)…
const LIST_ROW: DishListItem = {
  id: "dish-rice",
  title: "Garlic rice",
  minutes: 20,
  servings: 2,
  difficulty: "easy",
  calories: 200,
  protein: 4,
  carbs: 40,
  fat: 2,
  tags: [],
  image: null,
  mealUseCount: 0,
};

// …and as GET /dishes/:id reads it: written for 2.
const DETAIL: DishDetail = {
  id: "dish-rice",
  title: "Garlic rice",
  description: null,
  image: null,
  difficulty: "easy",
  minutes: 20,
  servings: 2,
  calories: 200,
  protein: 4,
  carbs: 40,
  fat: 2,
  tags: [],
  sourceType: "manual",
  userId: "u1",
  ingredients: [ing("Rice", 1, "cup"), ing("Garlic", 3, "clove"), ing("Butter", 0.333, "tbsp")],
  steps: [{ ...step(0, "Toast the garlic in butter", 3), phaseType: "prep" }, step(1, "Simmer the rice", 17)],
};

function state(dishes: BuilderDish[]) {
  return {
    mealName: "Lemon Chicken",
    cuisineType: "American",
    difficulty: "easy" as const,
    estimatedTimeMinutes: "30",
    servingsDefault: 4,
    notes: "",
    dishes,
    sourceType: "manual" as const,
  };
}

function deps(over: Partial<PickSavedDishDeps> = {}) {
  const added: BuilderDish[] = [];
  const errors: [string, string][] = [];
  const fetched: string[] = [];
  const d: PickSavedDishDeps = {
    fetchDish: async (id) => {
      fetched.push(id);
      return DETAIL;
    },
    allocUid: makeAlloc(),
    targetServings: 4,
    onAdd: (b) => added.push(b),
    onError: (t, m) => errors.push([t, m]),
    ...over,
  };
  return { d, added, errors, fetched };
}

test("BUG-528 cause 1: the list row alone hydrates an empty dish the save drops", () => {
  const row = savedDishFromListItem(LIST_ROW);
  assert.deepEqual(row.ingredients, []);
  const empty = pickSavedDishToBuilderDish(row, makeAlloc());
  assert.equal(serializeNewDishesForSave([empty], "x").length, 0);
});

test("BUG-528 cause 2: the override cannot carry an added dish (it pairs by position)", () => {
  const loaded = planMeal();
  const dishes = [...hydrateBuilderDishesFromMeal(loaded, makeAlloc()), dishDetailToBuilderDish(DETAIL, makeAlloc(), 4)];
  const override = buildRecipeOverride(buildManualSaveMealInput(state(dishes)));
  // Two entries for a meal with one dish: the server's applyRecipeOverrideToDishes
  // maps the meal's dishes, so entry 1 has nothing to land on.
  assert.equal(override.dishes.length, 2);
  assert.equal(loaded.dishes.length, 1);
});

test("A: a list row is read in full (GET /dishes/:id) before it is appended", async () => {
  const { d, added, errors, fetched } = deps();
  const ok = await pickSavedDish(savedDishFromListItem(LIST_ROW), d);
  assert.equal(ok, true);
  assert.deepEqual(fetched, ["dish-rice"]);
  assert.deepEqual(errors, []);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, "Garlic rice");
  assert.deepEqual(added[0].steps.map((s) => [s.text, s.estimatedMinutes, s.phaseType]), [
    ["Toast the garlic in butter", "3", "prep"],
    ["Simmer the rice", "17", "cook"],
  ]);
});

test("A: the dish is scaled from its servings to the meal's (2 → 4 doubles), two decimals", async () => {
  const { d, added } = deps();
  await pickSavedDish(savedDishFromListItem(LIST_ROW), d);
  assert.deepEqual(added[0].ingredients.map((i) => [i.name, i.quantity, i.unit]), [
    ["Rice", "2", "cup"],
    ["Garlic", "6", "clove"],
    ["Butter", "0.67", "tbsp"],
  ]);
  const same = deps({ targetServings: 2 });
  await pickSavedDish(savedDishFromListItem(LIST_ROW), same.d);
  assert.equal(same.added[0].ingredients[2].quantity, "0.333");
  const none = deps({ targetServings: undefined });
  await pickSavedDish(savedDishFromListItem(LIST_ROW), none.d);
  assert.equal(none.added[0].ingredients[0].quantity, "1");
});

test("A: a read that fails says so and appends nothing", async () => {
  const { d, added, errors } = deps({
    fetchDish: async () => {
      throw new Error("network");
    },
  });
  const ok = await pickSavedDish(savedDishFromListItem(LIST_ROW), d);
  assert.equal(ok, false);
  assert.equal(added.length, 0);
  assert.deepEqual(errors, [[PICK_DISH_ERROR_TITLE, PICK_DISH_ERROR_BODY]]);
});

test("A: the sheet's Simple Dish (it carries its ingredient) is appended without a read", async () => {
  const simple: SavedDish = {
    id: "simple-dish-1",
    name: "Baguette",
    type: "side",
    ingredients: [{ quantity: 1, unit: "whole", name: "Baguette" }],
    caloriesPerServing: 0,
    proteinGPerServing: 0,
    carbsGPerServing: 0,
    fatGPerServing: 0,
    mealUseCount: 0,
  };
  const { d, added, fetched } = deps();
  assert.equal(await pickSavedDish(simple, d), true);
  assert.deepEqual(fetched, []);
  assert.deepEqual(added[0].ingredients.map((i) => i.name), ["Baguette"]);
});

test("A round trip, Just this time: the added dish rides the recipe PATCH, after the meal's own", async () => {
  const loaded = planMeal();
  const alloc = makeAlloc();
  const dishes = hydrateBuilderDishesFromMeal(loaded, alloc);
  const { d, added } = deps({ allocUid: alloc, targetServings: loaded.authoredServingsDefault });
  await pickSavedDish(savedDishFromListItem(LIST_ROW), d);
  const input = buildManualSaveMealInput(state([...dishes, ...added]));

  assert.equal(input.dishes.length, 2);
  assert.equal(stepEditsPresent(loaded, input), false);
  assert.equal(dishAddsPresent(loaded, input), true);

  const patch = buildUpdateMealInput(buildStepEditMealInput(loaded, input));
  assert.equal(patch.dishes?.length, 2);
  const [first, second] = patch.dishes ?? [];
  if (first?.kind !== "new" || second?.kind !== "new") throw new Error("expected new dishes");
  assert.equal(first.title, "Lemon chicken");
  assert.equal(first.positionIndex, 0);
  assert.equal(second.title, "Garlic rice");
  assert.equal(second.role, "side");
  assert.equal(second.positionIndex, 1);
  assert.deepEqual(second.ingredients.map((i) => [i.name, i.quantity, i.unit]), [
    ["Rice", 2, "cup"],
    ["Garlic", 6, "clove"],
    ["Butter", 0.67, "tbsp"],
  ]);
  assert.deepEqual(second.steps.map((s) => s.text), ["Toast the garlic in butter", "Simmer the rice"]);
  assert.equal("servingsDefault" in patch, false);

  // The override written first carries the same dish at the same position, so
  // once the PATCH lands the read pairs it with the new dish.
  const override = buildRecipeOverride(input);
  assert.deepEqual(override.dishes[1].ingredients.map((i) => i.name), ["Rice", "Garlic", "Butter"]);
});

test("A round trip, Apply always: the PATCH body carries the added dish as edited", async () => {
  const loaded = planMeal();
  const alloc = makeAlloc();
  const { d, added } = deps({ allocUid: alloc });
  await pickSavedDish(savedDishFromListItem(LIST_ROW), d);
  const input = buildManualSaveMealInput(state([...hydrateBuilderDishesFromMeal(loaded, alloc), ...added]));
  const body = buildUpdateMealInput(input);
  assert.deepEqual(body.dishes?.map((x) => (x.kind === "new" ? x.title : x.dishId)), ["Lemon chicken", "Garlic rice"]);
});

test("A: no dish added → no recipe write for it (an untouched plan edit stays override-only)", () => {
  const loaded = planMeal();
  const input = buildManualSaveMealInput(state(hydrateBuilderDishesFromMeal(loaded, makeAlloc())));
  assert.equal(dishAddsPresent(loaded, input), false);
  assert.equal(buildStepEditMealInput(loaded, input).dishes.length, 1);
});

test("A: the save prompt and the confirmation say what goes to the recipe", () => {
  assert.equal(recipeEditsLine({ stepEdits: false, dishAdds: false }, "are"), null);
  assert.equal(recipeEditsLine({ stepEdits: true, dishAdds: false }, "are"), "Step changes are saved to the recipe.");
  assert.equal(recipeEditsLine({ stepEdits: false, dishAdds: true }, "are"), "Added dishes are saved to the recipe.");
  assert.equal(
    recipeEditsLine({ stepEdits: true, dishAdds: true }, "were"),
    "Step changes and added dishes were saved to the recipe.",
  );
});
