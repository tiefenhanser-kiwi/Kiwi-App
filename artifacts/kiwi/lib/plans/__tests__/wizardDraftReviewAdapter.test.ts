// WS9 Block 3c (D-WS9-032, Option A) — tests for wizardExpandedPlanToReviewPlan.
// Pure function, no React. Pins the draft→ReviewPlan mapping that lets the
// shared Plan Review screen render an unsaved wizard draft: every meal is
// unscheduled, ids are synthetic display-only, per-serving macros sum across a
// meal's dishes (skipping failed/absent), and the daily average divides the
// all-dish total by meal count.

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  WizardExpandedPlan,
  WizardExpandEnrichedDish,
  WizardExpandEnrichedMeal,
} from "@/lib/api/wizard";

import { wizardExpandedPlanToReviewPlan } from "../wizardDraftReviewAdapter";

function dish(over: Partial<WizardExpandEnrichedDish> = {}): WizardExpandEnrichedDish {
  return {
    title: "Main",
    role: "main",
    positionIndex: 0,
    ingredients: [],
    steps: [],
    macros: {
      caloriesPerServing: 400,
      proteinGPerServing: 30,
      carbsGPerServing: 35,
      fatGPerServing: 15,
    },
    ...over,
  } as WizardExpandEnrichedDish;
}

function meal(over: Partial<WizardExpandEnrichedMeal> = {}): WizardExpandEnrichedMeal {
  return {
    title: "Test Meal",
    cuisineType: "Italian",
    estimatedTimeMinutes: 30,
    difficulty: "easy",
    servings: 4,
    dishes: [dish()],
    ...over,
  } as WizardExpandEnrichedMeal;
}

function plan(over: Partial<WizardExpandedPlan> = {}): WizardExpandedPlan {
  return {
    candidateId: "cand-1",
    title: "Cozy Comfort Week",
    tags: ["Comfort"],
    whyBullets: ["one-pot meals"],
    meals: [meal()],
    ...over,
  } as WizardExpandedPlan;
}

// Fixture: 1 meal, 1 main dish with macros {400/30/35/15}.
test("maps title→name and lands every meal in the unscheduled cluster", () => {
  const rp = wizardExpandedPlanToReviewPlan(plan());
  assert.equal(rp.name, "Cozy Comfort Week");
  assert.equal(rp.scheduledMeals.length, 0);
  assert.equal(rp.unscheduledMeals.length, 1);
  assert.equal(rp.unscheduledMeals[0].title, "Test Meal");
});

// Fixture: the single meal carries cuisineType "Italian", difficulty easy,
// 30 min, serves 4 — all present so the row's derived fields are asserted.
test("row carries cuisine, formatted metaLine, synthetic ids, and an unassigned day strip", () => {
  const rp = wizardExpandedPlanToReviewPlan(plan());
  const row = rp.unscheduledMeals[0];
  assert.equal(row.cuisine, "Italian");
  assert.equal(row.metaLine, "Easy · 30 min · serves 4");
  assert.equal(row.planItemId, "draft-item-0");
  assert.equal(row.mealId, "draft-meal-0");
  assert.equal(row.dayStrip.every((d) => !d.isAssigned), true);
});

// Fixture: one meal with TWO dishes carrying macros (main 400/30/35/15 + side
// 150/8/20/5) — the row's per-serving macros must be the SUM across dishes.
test("per-serving row macros sum across a meal's dishes", () => {
  const rp = wizardExpandedPlanToReviewPlan(
    plan({
      meals: [
        meal({
          dishes: [
            dish(),
            dish({
              title: "Side",
              role: "side",
              positionIndex: 1,
              macros: {
                caloriesPerServing: 150,
                proteinGPerServing: 8,
                carbsGPerServing: 20,
                fatGPerServing: 5,
              },
            }),
          ],
        }),
      ],
    }),
  );
  const row = rp.unscheduledMeals[0];
  assert.equal(row.caloriesPerServing, 550);
  assert.equal(row.proteinGPerServing, 38);
  assert.equal(row.carbsGPerServing, 55);
  assert.equal(row.fatGPerServing, 20);
});

// Fixture: one meal with a good dish (400 cal), a failed dish (macros.failed),
// and a null-macros dish — only the good dish counts.
test("skips dishes whose macros failed or are absent", () => {
  const rp = wizardExpandedPlanToReviewPlan(
    plan({
      meals: [
        meal({
          dishes: [
            dish(),
            dish({
              title: "Broken",
              positionIndex: 1,
              macros: {
                caloriesPerServing: 999,
                proteinGPerServing: 999,
                carbsGPerServing: 999,
                fatGPerServing: 999,
                failed: true,
              },
            }),
            dish({ title: "NoMacros", positionIndex: 2, macros: null }),
          ],
        }),
      ],
    }),
  );
  assert.equal(rp.unscheduledMeals[0].caloriesPerServing, 400);
});

// Fixture: TWO meals, each summing to 400 cal → total 800, divided by 2 meals.
test("daily average divides the all-dish total by meal count", () => {
  const rp = wizardExpandedPlanToReviewPlan(
    plan({ meals: [meal(), meal({ title: "Meal 2" })] }),
  );
  assert.equal(rp.macroDailyAverage.caloriesPerDay, 400);
  assert.equal(rp.macroDailyAverage.proteinGPerDay, 30);
  assert.equal(rp.macroDailyAverage.carbsGPerDay, 35);
  assert.equal(rp.macroDailyAverage.fatGPerDay, 15);
});

// Fixture: a plan with zero meals — daily averages must be null (not 0/NaN).
test("empty meals yields null daily averages", () => {
  const rp = wizardExpandedPlanToReviewPlan(plan({ meals: [] }));
  assert.equal(rp.macroDailyAverage.caloriesPerDay, null);
  assert.equal(rp.macroDailyAverage.proteinGPerDay, null);
  assert.equal(rp.unscheduledMeals.length, 0);
});

// Fixture: default plan — a draft must present as unsaved/inactive/undated so
// the screen's action bar shows the save options and no date range.
test("draft presents as unsaved: no id, inactive, undated, not prepped, no notes", () => {
  const rp = wizardExpandedPlanToReviewPlan(plan());
  assert.equal(rp.id, "");
  assert.equal(rp.isActiveThisWeek, false);
  assert.equal(rp.weekStartDate, undefined);
  assert.equal(rp.weekEndDate, undefined);
  assert.equal(rp.prepStatus, "not_prepped");
  assert.deepEqual(rp.optimizationNotes, []);
});

// ── WS9 BUG-163 — the draft carries the meal's headnote to the review screen ──
//
// ReviewPlanMealRow.description has existed since BUG-153 and the SAVED path
// fills it (reviewPlanAdapter). The wizard draft path did not: the mobile
// expand schema never declared `description`, so this adapter had nothing to
// read and the pre-save review screen showed no sub-text for a meal that would
// show one moments after saving. Server side was complete end to end; this is
// wire + adapter only.
test("BUG-163: a draft meal's description reaches the review row", () => {
  const rp = wizardExpandedPlanToReviewPlan(
    plan({
      meals: [
        meal({
          title: "Red Chile Beef Enchiladas",
          description: "Braised short rib rolled in corn tortillas under a dark chile sauce.",
        }),
      ],
    }),
  );
  assert.equal(
    rp.unscheduledMeals[0].description,
    "Braised short rib rolled in corn tortillas under a dark chile sauce.",
  );
});

test("BUG-163: a meal with no description leaves the row's sub-text undefined", () => {
  // BUG-153's contract: the row renders NOTHING rather than a placeholder, so
  // the writer gap stays visible on device instead of being papered over.
  const rp = wizardExpandedPlanToReviewPlan(plan({ meals: [meal()] }));
  assert.equal(rp.unscheduledMeals[0].description, undefined);
});
