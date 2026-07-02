// WS7-8b Block 4 (Block 1) — pure Prep the Week render-model tests.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPrepWeekModel,
  buildMealLabelLookup,
  type MealLabelLookup,
  type PlanItemForLabel,
} from "../prepWeekModel";
import type { PrepWeekResult } from "@/lib/api/cooking";

// Two destination mealIds (uuid, matching the result schema).
const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const M3 = "33333333-3333-4333-8333-333333333333";

// A faithful 4-phase result: seasonings/sauces empty, produce with one step that
// combines two meals, proteins with one skip-suggested step that feeds one meal.
function result(overrides: Partial<PrepWeekResult> = {}): PrepWeekResult {
  return {
    totalEstimatedMinutes: 45,
    phases: [
      { phase: "seasonings_dry", title: "Seasonings & dry", skippable: true, steps: [] },
      { phase: "sauces_marinades", title: "Sauces & marinades", skippable: true, steps: [] },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [
          {
            number: 1,
            stepKey: `produce#${M1}`,
            title: "Dice onions",
            instructions: "Dice 2 onions for the week.",
            estimatedMinutes: 6,
            contributesToMealIds: [M1, M2],
          },
        ],
      },
      {
        phase: "proteins",
        title: "Proteins",
        skippable: false,
        steps: [
          {
            number: 2,
            stepKey: `proteins#${M1}`,
            title: "Trim chicken",
            instructions: "Trim 2 lb chicken thighs.",
            estimatedMinutes: 10,
            contributesToMealIds: [M1],
            storageNote: "Airtight, 2 days max",
            skipSuggested: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

// A lookup mirroring what the screen builds from the plan detail.
const lookup: MealLabelLookup = (mealId) => {
  if (mealId === M1) return { name: "Chicken Fajitas", day: "Tuesday" };
  if (mealId === M2) return { name: "Veggie Risotto", day: null }; // name only
  return undefined; // M3 + anything else → unresolved
};

// ── Phase ordering + passthrough ─────────────────────────────────────────────

test("buildPrepWeekModel: preserves the 4 phases in fixed server order", () => {
  const vm = buildPrepWeekModel(result());
  assert.equal(vm.phases.length, 4);
  assert.deepEqual(
    vm.phases.map((p) => p.phase),
    ["seasonings_dry", "sauces_marinades", "produce", "proteins"],
  );
  // BUG-011: total is recomputed from KEPT steps (produce 6 min); the 10-min
  // proteins step is skipSuggested, so it is excluded — NOT the server's 45.
  assert.equal(vm.totalEstimatedMinutes, 6);
  // phase metadata passes through
  assert.equal(vm.phases[0].skippable, true);
  assert.equal(vm.phases[2].skippable, false);
  assert.equal(vm.phases[2].title, "Produce");
});

test("buildPrepWeekModel: step fields (stepKey/number/title/instructions/minutes) pass through", () => {
  const produceStep = buildPrepWeekModel(result()).phases[2].steps[0];
  assert.equal(produceStep.stepKey, `produce#${M1}`);
  assert.equal(produceStep.number, 1);
  assert.equal(produceStep.title, "Dice onions");
  assert.equal(produceStep.instructions, "Dice 2 onions for the week.");
  assert.equal(produceStep.estimatedMinutes, 6);
});

// ── Combine count ─────────────────────────────────────────────────────────────

test("buildPrepWeekModel: combinesCount = contributesToMealIds.length", () => {
  const vm = buildPrepWeekModel(result());
  assert.equal(vm.phases[2].steps[0].combinesCount, 2); // M1 + M2
  assert.equal(vm.phases[3].steps[0].combinesCount, 1); // M1 only
});

// ── Destination labels (Option 1 — display-only, injected lookup) ─────────────

test("buildPrepWeekModel: destinations map one row per mealId, composing name · day", () => {
  const dests = buildPrepWeekModel(result(), { mealLabel: lookup }).phases[2]
    .steps[0].destinations;
  assert.equal(dests.length, 2);
  // M1 resolves name + day → "Chicken Fajitas · Tuesday"
  assert.equal(dests[0].mealId, M1);
  assert.equal(dests[0].name, "Chicken Fajitas");
  assert.equal(dests[0].day, "Tuesday");
  assert.equal(dests[0].label, "Chicken Fajitas · Tuesday");
  // M2 resolves name only (no day) → just the name
  assert.equal(dests[1].mealId, M2);
  assert.equal(dests[1].day, null);
  assert.equal(dests[1].label, "Veggie Risotto");
});

test("buildPrepWeekModel: an unresolved mealId degrades to a stable generic label (no id leak)", () => {
  const r = result({
    phases: [
      { phase: "seasonings_dry", title: "S", skippable: true, steps: [] },
      { phase: "sauces_marinades", title: "M", skippable: true, steps: [] },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [
          {
            number: 1,
            stepKey: `produce#${M3}`,
            title: "Chop carrots",
            instructions: "Chop carrots.",
            estimatedMinutes: 4,
            contributesToMealIds: [M3],
          },
        ],
      },
      { phase: "proteins", title: "P", skippable: false, steps: [] },
    ],
  });
  const dest = buildPrepWeekModel(r, { mealLabel: lookup }).phases[2].steps[0]
    .destinations[0];
  assert.equal(dest.name, null);
  assert.equal(dest.day, null);
  assert.equal(dest.label, "A planned meal"); // never the raw uuid
});

test("buildPrepWeekModel: with no lookup at all, every destination uses the fallback label", () => {
  const dests = buildPrepWeekModel(result()).phases[2].steps[0].destinations;
  assert.deepEqual(
    dests.map((d) => d.label),
    ["A planned meal", "A planned meal"],
  );
});

// ── BUG-011: header/footer total = KEPT steps only ───────────────────────────

test("buildPrepWeekModel: totalEstimatedMinutes sums KEPT steps only (excludes skipSuggested)", () => {
  // produce 6 (kept) + proteins 10 (skipSuggested) → 6, not 16, and not the
  // server's passthrough 45.
  const vm = buildPrepWeekModel(result());
  assert.equal(vm.totalEstimatedMinutes, 6);
});

test("buildPrepWeekModel: a fully-demoted plan floors at 1 min (never 0)", () => {
  const r = result({
    phases: [
      { phase: "seasonings_dry", title: "S", skippable: true, steps: [] },
      { phase: "sauces_marinades", title: "M", skippable: true, steps: [] },
      { phase: "produce", title: "Produce", skippable: false, steps: [] },
      {
        phase: "proteins",
        title: "Proteins",
        skippable: false,
        steps: [
          {
            number: 1,
            stepKey: `proteins#${M1}`,
            title: "Temper the steak",
            instructions: "Pull the steak 30 min before cooking.",
            estimatedMinutes: 12,
            contributesToMealIds: [M1],
            skipSuggested: true,
          },
        ],
      },
    ],
  });
  assert.equal(buildPrepWeekModel(r).totalEstimatedMinutes, 1);
});

test("buildPrepWeekModel: with no demoted steps, total = plain sum of kept minutes", () => {
  const r = result({
    totalEstimatedMinutes: 999, // server value must be ignored
    phases: [
      { phase: "seasonings_dry", title: "S", skippable: true, steps: [] },
      { phase: "sauces_marinades", title: "M", skippable: true, steps: [] },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [
          {
            number: 1,
            stepKey: `produce#${M1}`,
            title: "Dice onions",
            instructions: "Dice onions.",
            estimatedMinutes: 6,
            contributesToMealIds: [M1],
          },
          {
            number: 2,
            stepKey: `produce#${M2}`,
            title: "Chop carrots",
            instructions: "Chop carrots.",
            estimatedMinutes: 4,
            contributesToMealIds: [M2],
          },
        ],
      },
      { phase: "proteins", title: "P", skippable: false, steps: [] },
    ],
  });
  assert.equal(buildPrepWeekModel(r).totalEstimatedMinutes, 10);
});

// ── skipSuggested passthrough ─────────────────────────────────────────────────

test("buildPrepWeekModel: skipSuggested passes through; defaults to false when absent", () => {
  const vm = buildPrepWeekModel(result());
  assert.equal(vm.phases[3].steps[0].skipSuggested, true); // explicitly set
  assert.equal(vm.phases[2].steps[0].skipSuggested, false); // absent → false
});

test("buildPrepWeekModel: storageNote passes through (and is undefined when absent)", () => {
  const vm = buildPrepWeekModel(result());
  assert.equal(vm.phases[3].steps[0].storageNote, "Airtight, 2 days max");
  assert.equal(vm.phases[2].steps[0].storageNote, undefined);
});

// ── Checked-set → done rollups ────────────────────────────────────────────────

test("buildPrepWeekModel: no checked set → nothing done", () => {
  const vm = buildPrepWeekModel(result());
  assert.equal(vm.phases[2].steps[0].done, false);
  assert.equal(vm.doneCount, 0);
  assert.equal(vm.totalCount, 2);
  assert.equal(vm.allDone, false);
});

test("buildPrepWeekModel: a checked stepKey marks its step done and rolls up the phase", () => {
  const checked = new Set([`produce#${M1}`]);
  const vm = buildPrepWeekModel(result(), { checkedStepKeys: checked });
  // the produce step is done; its phase is fully done (1/1)
  assert.equal(vm.phases[2].steps[0].done, true);
  assert.equal(vm.phases[2].doneCount, 1);
  assert.equal(vm.phases[2].totalCount, 1);
  assert.equal(vm.phases[2].allDone, true);
  // proteins step is NOT checked → its phase is not done
  assert.equal(vm.phases[3].steps[0].done, false);
  assert.equal(vm.phases[3].allDone, false);
  // week rollup: 1 of 2
  assert.equal(vm.doneCount, 1);
  assert.equal(vm.totalCount, 2);
  assert.equal(vm.allDone, false);
});

test("buildPrepWeekModel: all stepKeys checked → every phase and the week roll up done", () => {
  const checked = new Set([`produce#${M1}`, `proteins#${M1}`]);
  const vm = buildPrepWeekModel(result(), { checkedStepKeys: checked });
  assert.equal(vm.phases[2].allDone, true);
  assert.equal(vm.phases[3].allDone, true);
  assert.equal(vm.allDone, true);
  assert.equal(vm.doneCount, 2);
});

test("buildPrepWeekModel: an empty phase rolls up allDone vacuously true (0/0)", () => {
  const vm = buildPrepWeekModel(result());
  // seasonings_dry + sauces_marinades carry zero steps
  assert.equal(vm.phases[0].totalCount, 0);
  assert.equal(vm.phases[0].doneCount, 0);
  assert.equal(vm.phases[0].allDone, true);
});

test("buildPrepWeekModel: a checked key that matches no step does not inflate the rollup", () => {
  const checked = new Set(["produce#nonexistent-key"]);
  const vm = buildPrepWeekModel(result(), { checkedStepKeys: checked });
  assert.equal(vm.doneCount, 0);
  assert.equal(vm.allDone, false);
});

// ── buildMealLabelLookup (plan items → mealId labels) ─────────────────────────

function planItem(overrides: Partial<PlanItemForLabel> = {}): PlanItemForLabel {
  return {
    mealId: M1,
    assignedDayOfWeek: "Tuesday",
    meal: { title: "Chicken Fajitas" },
    ...overrides,
  };
}

test("buildMealLabelLookup: maps mealId → { name from meal.title, day from assignedDayOfWeek }", () => {
  const lk = buildMealLabelLookup([
    planItem({ mealId: M1, assignedDayOfWeek: "Tuesday", meal: { title: "Chicken Fajitas" } }),
    planItem({ mealId: M2, assignedDayOfWeek: "Wednesday", meal: { title: "Veggie Risotto" } }),
  ]);
  assert.deepEqual(lk(M1), { name: "Chicken Fajitas", day: "Tuesday" });
  assert.deepEqual(lk(M2), { name: "Veggie Risotto", day: "Wednesday" });
});

test("buildMealLabelLookup: a missing meal (null) yields a null name, not a throw", () => {
  const lk = buildMealLabelLookup([planItem({ mealId: M1, meal: null })]);
  assert.deepEqual(lk(M1), { name: null, day: "Tuesday" });
});

test("buildMealLabelLookup: a null assignedDayOfWeek yields a null day", () => {
  const lk = buildMealLabelLookup([
    planItem({ mealId: M1, assignedDayOfWeek: null, meal: { title: "Soup" } }),
  ]);
  assert.deepEqual(lk(M1), { name: "Soup", day: null });
});

test("buildMealLabelLookup: an unknown mealId returns undefined (composer falls back)", () => {
  const lk = buildMealLabelLookup([planItem({ mealId: M1 })]);
  assert.equal(lk(M3), undefined);
});

test("buildMealLabelLookup: multi-slot collapse — same meal on two days keeps the FIRST slot (D-WS7-182)", () => {
  const lk = buildMealLabelLookup([
    planItem({ mealId: M1, assignedDayOfWeek: "Tuesday", meal: { title: "Fajitas" } }),
    planItem({ mealId: M1, assignedDayOfWeek: "Friday", meal: { title: "Fajitas" } }),
  ]);
  // First slot wins — display-only limitation; server attribution unaffected.
  assert.deepEqual(lk(M1), { name: "Fajitas", day: "Tuesday" });
});

test("buildMealLabelLookup feeds buildPrepWeekModel end-to-end (lookup → destination labels)", () => {
  const lk = buildMealLabelLookup([
    planItem({ mealId: M1, assignedDayOfWeek: "Tuesday", meal: { title: "Chicken Fajitas" } }),
    planItem({ mealId: M2, assignedDayOfWeek: null, meal: { title: "Veggie Risotto" } }),
  ]);
  const dests = buildPrepWeekModel(result(), { mealLabel: lk }).phases[2].steps[0]
    .destinations;
  assert.equal(dests[0].label, "Chicken Fajitas · Tuesday");
  assert.equal(dests[1].label, "Veggie Risotto"); // day null → name only
});
