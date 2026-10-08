// Row 13 "Test Kitchen" · Block 2 Part D — the guest plan's view-model.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  guestPlanRowByKey,
  guestPlanRows,
  guestPlanSubline,
} from "../guestPlanModel";
import type { WizardExpandedPlan } from "../../api/wizard";

function dish(cal: number, failed?: boolean) {
  return {
    title: "Main",
    role: "main" as const,
    positionIndex: 0,
    ingredients: [{ name: "rice", quantity: 1, unit: "cup" }],
    macros: {
      caloriesPerServing: cal,
      proteinGPerServing: 10,
      carbsGPerServing: 20,
      fatGPerServing: 5,
      ...(failed ? { failed: true } : {}),
    },
  };
}

function plan(meals: unknown[]): WizardExpandedPlan {
  return {
    candidateId: "c1",
    title: "A comforting week",
    tags: ["cozy"],
    whyBullets: ["Uses one shopping trip"],
    meals: meals as WizardExpandedPlan["meals"],
  };
}

test("a catalog-composed slot is readable — sourceStoreMealId is the recipe bridge", () => {
  const rows = guestPlanRows(
    plan([
      {
        title: "Chicken Pho",
        description: "A quick weeknight pho",
        cuisineType: "vietnamese",
        estimatedTimeMinutes: 45,
        difficulty: "medium",
        servings: 4,
        dishes: [dish(430), dish(120)],
        sourceStoreMealId: "meal_abc",
      },
    ]),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Chicken Pho");
  assert.equal(rows[0].description, "A quick weeknight pho");
  assert.equal(rows[0].timeLabel, "45 min");
  assert.equal(rows[0].servings, 4);
  assert.equal(rows[0].recipeMealId, "meal_abc");
  assert.equal(rows[0].recipeReadable, true);
  // Per-serving calories are the SUM over the dishes — "a serving of this meal".
  assert.equal(rows[0].caloriesPerServing, 550);
});

test("🔴 a slot with NO sourceStoreMealId is not readable — there is nowhere to read it from", () => {
  // A live (AI-expanded) slot. Unreachable for a guest (their expand is
  // catalog-only and refuses otherwise), but the schema is shared with members'
  // drafts and the row must not offer a link it cannot follow.
  const rows = guestPlanRows(
    plan([
      {
        title: "Invented Thing",
        cuisineType: "american",
        estimatedTimeMinutes: 30,
        difficulty: "easy",
        servings: 2,
        dishes: [dish(300)],
      },
    ]),
  );
  assert.equal(rows[0].recipeMealId, null);
  assert.equal(rows[0].recipeReadable, false);
});

test("an empty-string id is not an id", () => {
  const rows = guestPlanRows(
    plan([
      {
        title: "X",
        cuisineType: "x",
        estimatedTimeMinutes: 10,
        difficulty: "easy",
        servings: 1,
        dishes: [dish(100)],
        sourceStoreMealId: "",
      },
    ]),
  );
  assert.equal(rows[0].recipeReadable, false);
});

test("a FAILED macro pass makes the whole calorie figure unknown, never understated", () => {
  const rows = guestPlanRows(
    plan([
      {
        title: "Y",
        cuisineType: "y",
        estimatedTimeMinutes: 20,
        difficulty: "easy",
        servings: 2,
        dishes: [dish(400), dish(100, true)],
        sourceStoreMealId: "m1",
      },
    ]),
  );
  assert.equal(rows[0].caloriesPerServing, null);
});

test("a null-macro dish does the same", () => {
  const rows = guestPlanRows(
    plan([
      {
        title: "Z",
        cuisineType: "z",
        estimatedTimeMinutes: 20,
        difficulty: "easy",
        servings: 2,
        dishes: [dish(400), { ...dish(0), macros: null }],
        sourceStoreMealId: "m1",
      },
    ]),
  );
  assert.equal(rows[0].caloriesPerServing, null);
});

test("a missing description is null, never an empty string (the row renders nothing)", () => {
  const rows = guestPlanRows(
    plan([
      {
        title: "No headnote",
        cuisineType: "a",
        estimatedTimeMinutes: 0,
        difficulty: "easy",
        servings: 1,
        dishes: [dish(100)],
        sourceStoreMealId: "m1",
      },
    ]),
  );
  assert.equal(rows[0].description, null);
  // 0 minutes is not a time label.
  assert.equal(rows[0].timeLabel, null);
});

test("keys are unique across same-titled slots", () => {
  const meal = {
    title: "Same",
    cuisineType: "a",
    estimatedTimeMinutes: 10,
    difficulty: "easy",
    servings: 1,
    dishes: [dish(100)],
    sourceStoreMealId: "m1",
  };
  const rows = guestPlanRows(plan([meal, meal]));
  assert.notEqual(rows[0].key, rows[1].key);
  assert.equal(guestPlanRowByKey(rows, rows[1].key)?.key, rows[1].key);
  assert.equal(guestPlanRowByKey(rows, "nope"), null);
  assert.equal(guestPlanRowByKey(rows, undefined), null);
});

test("the subline counts meals — the draft carries no plan duration", () => {
  const one = {
    title: "One",
    cuisineType: "a",
    estimatedTimeMinutes: 10,
    difficulty: "easy",
    servings: 1,
    dishes: [dish(100)],
  };
  assert.equal(guestPlanSubline(plan([one])), "1 meal");
  assert.equal(guestPlanSubline(plan([one, one, one])), "3 meals");
  assert.equal(guestPlanSubline(plan([])), "0 meals");
});

// ── Resub C4 (BUG-366) — the row thumbnail's sources ───────────────────────
// The draft carries no image (27e7eb5: sourceStoreMealId only), so the image
// comes from the opened candidate's wire meals (by slot) or the picked cards
// (by catalog id) — else null, the imageless row.

const SLOT_A = { title: "Pho", cuisineType: "x", estimatedTimeMinutes: 30, difficulty: "easy", servings: 2, dishes: [], sourceStoreMealId: "m_a" };
const SLOT_B = { ...SLOT_A, title: "Tacos", sourceStoreMealId: "m_b" };
function candidate(id: string, meals: { storeMealId?: string; imageUrl?: string }[]) {
  return {
    id,
    title: "t",
    tags: [],
    whyBullets: [],
    mealTitles: meals.map((_, i) => `m${i}`),
    meals: meals.map((m, i) => ({ title: `m${i}`, description: null, ...m })),
    dailyMacros: { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  };
}

test("C4 no sources → every row's imageUrl is null (the row renders as before)", () => {
  const rows = guestPlanRows(plan([SLOT_A, SLOT_B]));
  assert.deepEqual(rows.map((r) => r.imageUrl), [null, null]);
});

test("C4 the three-plan path: the opened candidate's meals[i].imageUrl, by slot", () => {
  const rows = guestPlanRows(plan([SLOT_A, SLOT_B]), {
    candidates: [
      candidate("other", [{ storeMealId: "m_a", imageUrl: "https://x/wrong.jpg" }]),
      candidate("c1", [{ storeMealId: "m_a", imageUrl: "https://x/a.jpg" }, { storeMealId: "m_b" }]),
    ],
  });
  assert.deepEqual(rows.map((r) => r.imageUrl), ["https://x/a.jpg", null]);
});

test("C4 🔴 a slot whose storeMealId is not this row's meal lends NO picture — a wrong image is worse than none", () => {
  const rows = guestPlanRows(plan([SLOT_A]), {
    candidates: [candidate("c1", [{ storeMealId: "m_zzz", imageUrl: "https://x/zzz.jpg" }])],
  });
  assert.equal(rows[0].imageUrl, null);
});

test("C4 the pick path: the picked cards' images, by sourceStoreMealId", () => {
  const rows = guestPlanRows(plan([SLOT_B, SLOT_A]), {
    pickedMealImages: { m_a: "https://x/a.jpg" },
  });
  assert.deepEqual(rows.map((r) => r.imageUrl), [null, "https://x/a.jpg"]);
});
