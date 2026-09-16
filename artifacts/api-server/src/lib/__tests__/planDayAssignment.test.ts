// WS9 Redesign Arc Block 1 — D-WS7-213 half 1, deterministic day assignment.
// Literal expectations: a seafood meal lands day 1; the lowest-active meal of
// the least-perishable tier lands last; the start date is tomorrow (UTC); more
// meals than days leaves the extras unassigned; the persist helper writes
// assignedDayOfWeek + assignedDate on every item (nulls for the extras).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveThisWeekPlan } from "../planDates";
import {
  activeWindowFromToday,
  addUtcDays,
  assignAndPersistPlanDays,
  assignedDateRange,
  assignPlanDays,
  DAY_NAMES,
  inclusiveDayCount,
  parseLocalDate,
  todayFor,
  loadAssignableMeals,
  PERISHABILITY_BY_CATEGORY,
  perishabilityTierFor,
  isSeafoodIngredientName,
  SEAFOOD_INGREDIENT_TERMS,
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
  it("is the named inferCategory vocabulary — Part B: seafood (0, by name) ahead of fresh (1), chilled (2), stable (3)", () => {
    assert.deepEqual(PERISHABILITY_BY_CATEGORY, {
      Protein: 1,
      Produce: 1,
      Dairy: 2,
      Bakery: 3,
      Pantry: 3,
      Canned: 3,
      Frozen: 3,
      Snacks: 3,
      Household: 3,
    });
  });
  it("the most perishable ingredient governs the meal; unknown / none → stable", () => {
    assert.equal(perishabilityTierFor(["Pantry", "Canned", "Protein"]), 1);
    assert.equal(perishabilityTierFor(["Pantry", "Dairy"]), 2);
    assert.equal(perishabilityTierFor(["Pantry", "Frozen"]), 3);
    assert.equal(perishabilityTierFor(["Mystery"]), 3);
    assert.equal(perishabilityTierFor([]), 3);
  });
  it("Part B (BUG-280): a seafood NAME puts the meal in tier 0 whatever its category says", () => {
    assert.equal(perishabilityTierFor(["Protein", "Pantry"], ["salmon fillets", "rice"]), 0);
    // inferCategory mis-stamps these; the name still wins.
    assert.equal(perishabilityTierFor(["Canned"], ["ahi tuna steaks"]), 0);
    assert.equal(perishabilityTierFor(["Pantry"], ["mahi-mahi fillets"]), 0);
    assert.equal(perishabilityTierFor(["Protein"], ["chicken thighs"]), 1);
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

// Post-pass Part B (BUG-280, [WS9-arc-PS-B]) — fish first: the FRESH tier is
// split, seafood → other fresh → dairy → shelf-stable, easiest-last unchanged
// inside each tier. Name list, word-boundary matched; the six ruled negatives
// and the live-table traps are pinned so a naive substring match cannot creep
// back in.
const named = (
  mealId: string,
  names: string[],
  cats: string[],
  active: number,
  difficulty = "easy",
): AssignableMeal => ({ ...meal(mealId, cats, active, difficulty), ingredientNames: names });

describe("Part B — fish first (BUG-280)", () => {
  it("a salmon meal sorts ahead of a chicken meal of EQUAL effort (given order would have put chicken first)", () => {
    const out = assignPlanDays(
      [
        named("chicken", ["chicken thighs", "rice"], ["Protein", "Pantry"], 25),
        named("salmon", ["salmon fillets", "rice"], ["Protein", "Pantry"], 25),
      ],
      { now: NOW },
    );
    const byId = Object.fromEntries(out.map((o) => [o.mealId, o]));
    assert.equal(byId.salmon.dayIndex, 0);
    assert.equal(byId.salmon.perishabilityTier, 0);
    assert.equal(byId.chicken.dayIndex, 1);
    assert.equal(byId.chicken.perishabilityTier, 1);
  });

  it("a Worcestershire-containing beef meal does NOT jump the seafood tier", () => {
    const out = assignPlanDays(
      [
        named("beef", ["ground beef", "worcestershire sauce"], ["Protein", "Pantry"], 25),
        named("salmon", ["salmon fillets"], ["Protein"], 25),
      ],
      { now: NOW },
    );
    const byId = Object.fromEntries(out.map((o) => [o.mealId, o]));
    assert.equal(byId.beef.perishabilityTier, 1);
    assert.equal(byId.salmon.dayIndex, 0);
    assert.equal(byId.beef.dayIndex, 1);
  });

  it("the six ruled negatives are NOT seafood: fish sauce · oyster sauce · anchovy paste · Worcestershire · imitation crab · canned tuna", () => {
    for (const n of [
      "fish sauce",
      "oyster sauce",
      "anchovy paste",
      "worcestershire sauce",
      "imitation crab",
      "imitation crab meat",
      "canned tuna",
      "canned tuna in water",
    ]) {
      assert.equal(isSeafoodIngredientName(n), false, n);
    }
  });

  it("live-table traps (2026-09-16 probe) are NOT seafood; real fish names ARE, whatever inferCategory stamped", () => {
    for (const n of [
      "oyster mushrooms",
      "oyster crackers",
      "clam juice",
      "bottled clam juice",
      "clam chowder base",
      "dry crab boil seasoning",
      "solid white albacore tuna in water",
      "canned wild-caught salmon",
      "frozen peeled shrimp",
      "frozen fish sticks",
      "dried shrimp",
      "smoked salmon",
      // word boundaries: no substring bleed
      "codfish cakes mix",
      "coddled eggs",
      "crabapple jelly",
    ]) {
      assert.equal(isSeafoodIngredientName(n), false, n);
    }
    for (const n of [
      "salmon fillets, skin-on",
      "large shrimp, peeled and deveined (16/20 count)",
      "cod fillets",
      "ahi tuna steaks",
      "mahi-mahi fillets",
      "flounder fillets",
      "lump crab meat",
      "chilean sea bass",
      "lobster tails",
      "tilapia fillets",
    ]) {
      assert.equal(isSeafoodIngredientName(n), true, n);
    }
  });

  it("every seeded term is present and the list is not empty (the break test empties it)", () => {
    for (const t of [
      "salmon", "shrimp", "cod", "tuna", "tilapia", "halibut", "trout", "scallop",
      "mussel", "clam", "crab", "lobster", "oyster", "snapper", "sea bass", "swordfish",
      "mahi", "sole", "flounder", "squid", "calamari", "octopus",
    ]) {
      assert.ok(SEAFOOD_INGREDIENT_TERMS.includes(t), t);
    }
  });

  it("easiest-last still holds INSIDE each tier: two seafood meals, the quicker one lands second; then fresh, dairy, stable", () => {
    const out = assignPlanDays(
      [
        named("mac", ["cheddar", "pasta"], ["Dairy", "Pantry"], 15),
        named("quickfish", ["tilapia fillets"], ["Protein"], 10),
        named("chili", ["canned beans"], ["Canned"], 20),
        named("chicken", ["chicken breast"], ["Protein"], 30),
        named("slowfish", ["halibut"], ["Protein"], 40),
        named("salad", ["romaine"], ["Produce"], 5),
      ],
      { now: NOW },
    );
    const order = [...out].sort((a, b) => a.dayIndex! - b.dayIndex!).map((o) => o.mealId);
    assert.deepEqual(order, ["slowfish", "quickfish", "chicken", "salad", "mac", "chili"]);
  });

  it("a caller without names gets the category tiers only (no crash, no seafood tier)", () => {
    assert.equal(perishabilityTierFor(["Protein"]), 1);
    const out = assignPlanDays([meal("x", ["Protein"], 10)], { now: NOW });
    assert.equal(out[0].perishabilityTier, 1);
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
                { ingredient: { category: "Protein", canonicalName: "cod fillets" } },
                { ingredient: { category: "Pantry", canonicalName: "rice" } },
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
        dishLinks: [
          {
            dish: {
              dishIngredients: [{ ingredient: { category: "Pantry", canonicalName: "pasta" } }],
            },
          },
        ],
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
    assert.deepEqual(loaded[1].ingredientNames, ["cod fillets", "rice"]);
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

// WS9 Redesign Arc Block 2 (Part D) — the client's local calendar day and
// the "for now" window (rules (a) + (e)).
describe("Block 2 — localDate + the active window", () => {
  it("parseLocalDate accepts YYYY-MM-DD for a real day only", () => {
    assert.equal(parseLocalDate("2026-09-19")?.toISOString(), "2026-09-19T00:00:00.000Z");
    assert.equal(parseLocalDate("2026-02-30"), null, "not a calendar date");
    assert.equal(parseLocalDate("2026-9-19"), null);
    assert.equal(parseLocalDate("2026-09-19T00:00:00Z"), null);
    assert.equal(parseLocalDate("19/09/2026"), null);
  });

  it("todayFor: the client's day when sent, else the server's UTC day", () => {
    // Saturday 9:26 PM ET = 01:26Z Sunday: UTC says the 20th, the client says the 19th.
    const at = new Date("2026-09-20T01:26:00Z");
    assert.equal(todayFor(undefined, at).toISOString(), "2026-09-20T00:00:00.000Z");
    assert.equal(todayFor("2026-09-19", at).toISOString(), "2026-09-19T00:00:00.000Z");
    // …so "tomorrow" is Sunday, not Monday.
    assert.equal(DAY_NAMES[addUtcDays(todayFor("2026-09-19", at), 1).getUTCDay()], "Sunday");
    assert.equal(DAY_NAMES[addUtcDays(todayFor(undefined, at), 1).getUTCDay()], "Monday");
  });

  it("activeWindowFromToday: opens today, ends on the last assigned day; today + 6 with nothing assigned", () => {
    const today = new Date("2026-09-16T00:00:00Z");
    const assigned = assignPlanDays(
      [meal("a", ["Pantry"], 30), meal("b", ["Pantry"], 20), meal("c", ["Pantry"], 10)],
      { startDate: addUtcDays(today, 1) },
    );
    const w = activeWindowFromToday(today, assigned);
    assert.equal(w.startDate.toISOString(), "2026-09-16T00:00:00.000Z");
    assert.equal(w.endDate.toISOString(), "2026-09-19T00:00:00.000Z");
    const empty = activeWindowFromToday(today, []);
    assert.equal(empty.endDate.toISOString(), "2026-09-22T00:00:00.000Z");
  });

  it("inclusiveDayCount", () => {
    assert.equal(inclusiveDayCount(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-26T00:00:00Z")), 7);
    assert.equal(inclusiveDayCount(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-20T00:00:00Z")), 1);
    assert.equal(inclusiveDayCount(new Date("2026-09-21T00:00:00Z"), new Date("2026-09-20T00:00:00Z")), 0);
  });
});
