// WS9 Redesign Arc Block 1 — D-WS7-213 half 1, deterministic day assignment.
// Literal expectations: a seafood meal lands day 1; the lowest-active meal of
// the least-perishable tier lands last; the start date is tomorrow (UTC); more
// meals than days leaves the extras unassigned; the persist helper writes
// assignedDayOfWeek + assignedDate on every item (nulls for the extras).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveThisWeekPlan } from "../planDates";
import {
  assignAndPersistPlanDays,
  assignedDateRange,
  assignPlanDays,
  DAY_NAMES,
  loadAssignableMeals,
  PERISHABILITY_BY_CATEGORY,
  perishabilityTierFor,
  tomorrowUtc,
  type AssignableMeal,
} from "../planDayAssignment";

const meal = (
  mealId: string,
  cats: string[],
  active: number | null,
  difficulty = "easy",
  total = 45,
): AssignableMeal => ({
  mealId,
  ingredientCategories: cats,
  activeTimeMinutes: active,
  estimatedTimeMinutes: total,
  difficulty,
});

// A fixed "now": Wednesday 2026-09-16 21:30 UTC → tomorrow is Thursday 17th.
const NOW = new Date("2026-09-16T21:30:00Z");

describe("the perishability table", () => {
  it("is the named inferCategory vocabulary, three tiers", () => {
    assert.deepEqual(PERISHABILITY_BY_CATEGORY, {
      Protein: 0,
      Produce: 0,
      Dairy: 1,
      Bakery: 2,
      Pantry: 2,
      Canned: 2,
      Frozen: 2,
      Snacks: 2,
      Household: 2,
    });
  });
  it("the most perishable ingredient governs the meal; unknown / none → stable", () => {
    assert.equal(perishabilityTierFor(["Pantry", "Canned", "Protein"]), 0);
    assert.equal(perishabilityTierFor(["Pantry", "Dairy"]), 1);
    assert.equal(perishabilityTierFor(["Pantry", "Frozen"]), 2);
    assert.equal(perishabilityTierFor(["Mystery"]), 2);
    assert.equal(perishabilityTierFor([]), 2);
  });
});

describe("assignPlanDays — order", () => {
  it("a seafood (Protein) meal lands day 1; the pantry meal lands last", () => {
    const out = assignPlanDays(
      [
        meal("chili", ["Canned", "Pantry"], 20),
        meal("salmon", ["Protein", "Produce"], 25),
        meal("mac", ["Dairy", "Pantry"], 15),
      ],
      { now: NOW },
    );
    const byId = Object.fromEntries(out.map((o) => [o.mealId, o]));
    assert.equal(byId.salmon.dayIndex, 0);
    assert.equal(byId.mac.dayIndex, 1);
    assert.equal(byId.chili.dayIndex, 2);
    assert.equal(byId.salmon.assignedDayOfWeek, "Thursday");
    assert.equal(byId.mac.assignedDayOfWeek, "Friday");
    assert.equal(byId.chili.assignedDayOfWeek, "Saturday");
  });

  it("within a tier, harder first so the lowest-active meal lands last", () => {
    const out = assignPlanDays(
      [
        meal("quick", ["Pantry"], 10),
        meal("slow", ["Pantry"], 60),
        meal("mid", ["Pantry"], 30),
      ],
      { now: NOW },
    );
    assert.deepEqual(
      out.map((o) => [o.mealId, o.dayIndex]),
      [
        ["quick", 2],
        ["slow", 0],
        ["mid", 1],
      ],
    );
  });

  it("a never-derived meal (null active) falls back to its stored total; difficulty breaks effort ties", () => {
    const out = assignPlanDays(
      [
        meal("a", ["Pantry"], null, "easy", 30),
        meal("b", ["Pantry"], 30, "fancy"),
        meal("c", ["Pantry"], 30, "medium"),
      ],
      { now: NOW },
    );
    assert.deepEqual(
      out.map((o) => [o.mealId, o.dayIndex]),
      [
        ["a", 2],
        ["b", 0],
        ["c", 1],
      ],
    );
  });

  it("full ties keep the given order", () => {
    const out = assignPlanDays(
      [meal("x", ["Produce"], 20), meal("y", ["Produce"], 20), meal("z", ["Produce"], 20)],
      { now: NOW },
    );
    assert.deepEqual(out.map((o) => o.dayIndex), [0, 1, 2]);
  });

  it("perishability outranks effort: a quick fish dinner is still day 1", () => {
    const out = assignPlanDays(
      [meal("beans", ["Canned"], 90, "fancy"), meal("fish", ["Protein"], 10)],
      { now: NOW },
    );
    assert.equal(out.find((o) => o.mealId === "fish")?.dayIndex, 0);
    assert.equal(out.find((o) => o.mealId === "beans")?.dayIndex, 1);
  });
});

describe("assignPlanDays — dates", () => {
  it("starts TOMORROW (UTC) by default and writes the UTC-midnight date + day name", () => {
    assert.equal(tomorrowUtc(NOW).toISOString(), "2026-09-17T00:00:00.000Z");
    const [only] = assignPlanDays([meal("m", ["Produce"], 20)], { now: NOW });
    assert.equal(only.assignedDate?.toISOString(), "2026-09-17T00:00:00.000Z");
    assert.equal(only.assignedDayOfWeek, "Thursday");
    assert.equal(DAY_NAMES[new Date("2026-09-17T00:00:00Z").getUTCDay()], "Thursday");
  });

  it("tomorrow crosses the UTC month boundary correctly", () => {
    const [only] = assignPlanDays([meal("m", ["Produce"], 20)], {
      now: new Date("2026-09-30T23:59:00Z"),
    });
    assert.equal(only.assignedDate?.toISOString(), "2026-10-01T00:00:00.000Z");
  });

  it("an explicit startDate is truncated to its UTC day and honoured", () => {
    const out = assignPlanDays(
      [meal("a", ["Produce"], 20), meal("b", ["Pantry"], 20)],
      { startDate: new Date("2026-09-20T15:45:00Z") },
    );
    assert.equal(out[0].assignedDate?.toISOString(), "2026-09-20T00:00:00.000Z");
    assert.equal(out[0].assignedDayOfWeek, "Sunday");
    assert.equal(out[1].assignedDate?.toISOString(), "2026-09-21T00:00:00.000Z");
    assert.equal(out[1].assignedDayOfWeek, "Monday");
  });

  it("a 7-day plan from tomorrow covers each weekday once", () => {
    const meals = Array.from({ length: 7 }, (_, i) => meal(`m${i}`, ["Pantry"], 10 + i));
    const out = assignPlanDays(meals, { now: NOW });
    assert.deepEqual(new Set(out.map((o) => o.assignedDayOfWeek)).size, 7);
    assert.equal(out.filter((o) => o.dayIndex === null).length, 0);
  });
});

describe("assignedDateRange — the instance's dates come from the assignment (F3)", () => {
  it("a Wednesday-created 7-day plan runs Thursday → the following Wednesday and wins on Thursday", () => {
    // NOW is Wednesday 2026-09-16 (UTC); tomorrow is Thursday the 17th.
    const meals = Array.from({ length: 7 }, (_, i) => meal(`m${i}`, ["Pantry"], 10 + i));
    const assigned = assignPlanDays(meals, { now: NOW });
    const range = assignedDateRange(assigned);
    assert.ok(range);
    assert.equal(range.startDate.toISOString(), "2026-09-17T00:00:00.000Z");
    assert.equal(range.startDate.getUTCDay(), 4, "Thursday");
    assert.equal(range.endDate.toISOString(), "2026-09-23T00:00:00.000Z");
    assert.equal(range.endDate.getUTCDay(), 3, "the following Wednesday");

    const row = { id: "p", ...range, activatedAt: NOW, createdAt: NOW };
    // Range-containment (lib/planDates.ts): winner on Thursday, on the last
    // Wednesday, not on creation day, not the day after.
    assert.equal(resolveThisWeekPlan([row], new Date("2026-09-17T08:00:00Z"))?.id, "p");
    assert.equal(resolveThisWeekPlan([row], new Date("2026-09-23T23:00:00Z"))?.id, "p");
    assert.equal(resolveThisWeekPlan([row], NOW), null, "not yet active on creation day");
    assert.equal(resolveThisWeekPlan([row], new Date("2026-09-24T00:00:00Z")), null);
  });

  it("unassigned overflow meals do not extend the range; nothing assigned → null", () => {
    const assigned = assignPlanDays(
      [meal("a", ["Pantry"], 1), meal("b", ["Pantry"], 2), meal("c", ["Protein"], 3), meal("d", ["Pantry"], 4)],
      { planDurationDays: 2, now: NOW },
    );
    const range = assignedDateRange(assigned);
    assert.deepEqual(
      { s: range?.startDate.toISOString(), e: range?.endDate.toISOString() },
      { s: "2026-09-17T00:00:00.000Z", e: "2026-09-18T00:00:00.000Z" },
    );
    assert.equal(assignedDateRange(assignPlanDays([], { now: NOW })), null);
  });
});

describe("assignPlanDays — more meals than days", () => {
  it("assigns the first planDurationDays meals (given order) and leaves the rest with NO day", () => {
    const out = assignPlanDays(
      [
        meal("m1", ["Pantry"], 10),
        meal("m2", ["Protein"], 30),
        meal("m3", ["Dairy"], 20),
        meal("m4", ["Protein"], 5), // beyond the plan length — never dated
        meal("m5", ["Pantry"], 40),
      ],
      { planDurationDays: 3, now: NOW },
    );
    const unassigned = out.filter((o) => o.dayIndex === null).map((o) => o.mealId);
    assert.deepEqual(unassigned, ["m4", "m5"]);
    for (const o of out.filter((x) => x.dayIndex === null)) {
      assert.equal(o.assignedDayOfWeek, null);
      assert.equal(o.assignedDate, null);
    }
    // The three dated ones are ordered among themselves: m2 (fresh) → m3 (dairy) → m1 (pantry).
    assert.deepEqual(
      out.slice(0, 3).map((o) => [o.mealId, o.dayIndex]),
      [
        ["m1", 2],
        ["m2", 0],
        ["m3", 1],
      ],
    );
  });

  it("planDurationDays larger than the meal count dates every meal", () => {
    const out = assignPlanDays([meal("a", ["Pantry"], 1), meal("b", ["Pantry"], 2)], {
      planDurationDays: 7,
      now: NOW,
    });
    assert.deepEqual(out.map((o) => o.dayIndex), [1, 0]);
  });
});

describe("loadAssignableMeals + assignAndPersistPlanDays", () => {
  it("reads categories through dishLinks → dish → dishIngredients → ingredient and persists days", async () => {
    const rowsById: Record<string, unknown> = {
      fish: {
        id: "fish",
        activeTimeMinutes: 25,
        estimatedTimeMinutes: 40,
        difficulty: "medium",
        dishLinks: [
          {
            dish: {
              dishIngredients: [
                { ingredient: { category: "Protein" } },
                { ingredient: { category: "Pantry" } },
              ],
            },
          },
        ],
      },
      pasta: {
        id: "pasta",
        activeTimeMinutes: null,
        estimatedTimeMinutes: 20,
        difficulty: "easy",
        dishLinks: [{ dish: { dishIngredients: [{ ingredient: { category: "Pantry" } }] } }],
      },
      extra: {
        id: "extra",
        activeTimeMinutes: 5,
        estimatedTimeMinutes: 10,
        difficulty: "easy",
        dishLinks: [],
      },
    };
    const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
    const tx = {
      meal: {
        findMany: async (args: { where: { id: { in: string[] } } }) =>
          args.where.id.in.map((id) => rowsById[id]),
      },
      mealPlanItem: {
        findMany: async () => [
          { id: "i1", mealId: "pasta" },
          { id: "i2", mealId: "fish" },
          { id: "i3", mealId: "extra" },
        ],
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push(args);
          return {};
        },
      },
    } as unknown as Parameters<typeof assignAndPersistPlanDays>[0];

    const loaded = await loadAssignableMeals(tx, ["pasta", "fish"]);
    assert.deepEqual(loaded[1].ingredientCategories, ["Protein", "Pantry"]);
    assert.equal(loaded[0].activeTimeMinutes, null);

    const assigned = await assignAndPersistPlanDays(tx, "plan-1", {
      planDurationDays: 2,
      now: NOW,
    });
    assert.equal(updates.length, 3, "every item is written, extras with nulls");
    assert.deepEqual(updates[0], {
      where: { id: "i1" },
      data: { assignedDayOfWeek: "Friday", assignedDate: new Date("2026-09-18T00:00:00Z") },
    });
    assert.deepEqual(updates[1], {
      where: { id: "i2" },
      data: { assignedDayOfWeek: "Thursday", assignedDate: new Date("2026-09-17T00:00:00Z") },
    });
    assert.deepEqual(updates[2], {
      where: { id: "i3" },
      data: { assignedDayOfWeek: null, assignedDate: null },
    });
    assert.equal(assigned.filter((a) => a.dayIndex === null).length, 1);
  });
});
