// BUG-359 — Prep the Week's wording residue after J.1c, one pin per item, through
// the real adapter, engine and assembly where the item lives there.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LoadPrepWeekInputResult, PrepLoadedPlan } from "../prepWeekAggregation";
import { buildPrepWeekPlan } from "../prepWeekBuild";
import { bowlNameFor, joinUse } from "../prepComponents";
import { timeRow } from "../prepStepMinutes";

type Ing = { id: string; name: string; category: string; quantity: number; unit: string; note?: string };
type St = { i: number; phase: string; text: string; ids?: string[]; key?: string };
type Dish = { id: string; name: string; ings: Ing[]; steps: St[] };
type Meal = { id: string; name: string; day: string; lag: number; dishes: Dish[] };

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000b3590`;

function load(meals: Meal[], pastMealIds?: Set<string>): LoadPrepWeekInputResult {
  const input: PrepLoadedPlan = {
    planId: uuid(999),
    planName: "BUG-359",
    meals: meals.map((m) => ({
      mealId: m.id,
      mealName: m.name,
      cuisine: null,
      servingsOverride: null,
      dishes: m.dishes.map((d) => ({
        dishId: d.id,
        dishName: d.name,
        dishRole: "main" as const,
        baseServings: 4,
        authoredBaseServings: 4,
        ingredients: d.ings.map((x) => ({
          ingredientId: x.id, ingredientName: x.name, category: x.category, quantity: x.quantity, unit: x.unit,
          preparationNote: x.note ?? null, sourceYield: null, purchaseUnit: null,
        })),
        stepTexts: d.steps.map((s) => s.text),
        componentSteps: d.steps.map((s) => ({ stepIndex: s.i, text: s.text, componentKey: s.key ?? null, ingredientIds: s.ids ?? [], phaseType: s.phase })),
      })),
    })),
  };
  return {
    input,
    planRevisionId: 1,
    cookDays: {
      prepDay: "2026-10-04",
      lagByMealId: new Map(meals.map((m) => [m.id, m.lag])),
      dayNameByMealId: new Map(meals.map((m) => [m.id, m.day])),
      ...(pastMealIds ? { pastMealIds } : {}),
    },
    identity: { foldedIdByIngredientId: new Map() },
  };
}

/** Every container a food is put in, by name. */
function destinations(meals: Meal[], food: string): string[] {
  const b = buildPrepWeekPlan(load(meals));
  return [
    ...new Set(
      b.stepPlan.steps
        .filter((s) => !s.demoted)
        .flatMap((s) => s.components.filter((c) => c.ingredientName === food).flatMap((c) => c.measures.map((m) => m.destination ?? s.bowlName ?? ""))),
    ),
  ];
}

// f49f5209's taco dish, step text verbatim.
const tacos: Meal = {
  id: uuid(1), name: "Cheesy Taco Bell–Style Ground Beef Tacos", day: "Tuesday", lag: 2,
  dishes: [{
    id: uuid(11), name: "Taco Bell–Style Seasoned Ground Beef",
    ings: [
      { id: uuid(101), name: "iceberg lettuce", category: "Produce", quantity: 2, unit: "cup", note: "finely shredded" },
      { id: uuid(102), name: "roma tomatoes", category: "Produce", quantity: 2, unit: "each", note: "finely diced" },
      { id: uuid(103), name: "chili powder", category: "Pantry", quantity: 1.5, unit: "tsp" },
      { id: uuid(104), name: "ground cumin", category: "Pantry", quantity: 1, unit: "tsp" },
      { id: uuid(105), name: "smoked paprika", category: "Pantry", quantity: 0.5, unit: "tsp" },
      { id: uuid(106), name: "garlic powder", category: "Pantry", quantity: 0.5, unit: "tsp" },
      { id: uuid(107), name: "water", category: "Pantry", quantity: 0.25, unit: "cup" },
      { id: uuid(108), name: "ground beef (80/20)", category: "Protein", quantity: 1.25, unit: "lb" },
    ],
    steps: [
      { i: 0, phase: "prep", text: "Finely shred 2 cups iceberg lettuce and finely dice 2 roma tomatoes; set aside in separate small bowls.", ids: [uuid(101), uuid(102)] },
      { i: 1, phase: "prep", key: "seasoning", text: "In a small bowl, whisk together 1½ teaspoons chili powder, 1 teaspoon cumin, ½ teaspoon smoked paprika and ½ teaspoon garlic powder.", ids: [uuid(103), uuid(104), uuid(105), uuid(106)] },
      { i: 3, phase: "cook", text: "Heat a large skillet over medium-high heat, add the 1¼ pounds 80/20 ground beef, and cook, breaking it up with a spoon, until no pink remains, about 7 minutes.", ids: [uuid(108)] },
      { i: 5, phase: "cook", key: "seasoning", text: "Sprinkle the spice blend over the beef, pour in ¼ cup water, and stir over medium heat for 2–3 minutes until the liquid is mostly absorbed.", ids: [uuid(107)] },
      { i: 8, phase: "assemble", text: "Fill each warm shell with seasoned beef, then top with shredded lettuce, diced tomato, and a dollop of sour cream (about 2 teaspoons per taco)." },
    ],
  }],
};

describe("BUG-359 — the six wording residues", () => {
  it("1 · taco lettuce and tomatoes go on the toppings plate (D-WS9-301 R2), not into '<dish> vegetables'", () => {
    for (const food of ["iceberg lettuce", "roma tomatoes"]) {
      assert.deepEqual(destinations([tacos], food), ["Taco Bell–Style Seasoned Ground Beef toppings plate"], food);
    }
  });

  it("1 · …but pizza toppings that go into the oven are not a plate", () => {
    const pizza: Meal = {
      id: uuid(2), name: "Pizza Night", day: "Monday", lag: 1,
      dishes: [{
        id: uuid(21), name: "Margherita Pizza",
        ings: [{ id: uuid(201), name: "roma tomatoes", category: "Produce", quantity: 2, unit: "each", note: "thinly sliced" }],
        steps: [
          { i: 0, phase: "prep", text: "Thinly slice 2 roma tomatoes.", ids: [uuid(201)] },
          { i: 1, phase: "assemble", text: "Top the dough with the sliced tomatoes." },
          { i: 2, phase: "cook", text: "Bake at 500°F for 10 minutes." },
        ],
      }],
    };
    assert.ok(!destinations([pizza], "roma tomatoes").some((d) => /plate/.test(d)));
  });

  it("2 · a blend's name keeps every word of its dish", () => {
    const names = buildPrepWeekPlan(load([tacos])).stepPlan.steps.map((s) => s.bowlName).filter(Boolean);
    assert.ok(names.includes("Taco Bell–Style Seasoned Ground Beef spice blend"), names.join(" | "));
    assert.equal(
      bowlNameFor("Tomato and Onion Slow-Cooker Pot Roast", null, null, 0, false, false, "vegetables"),
      "Tomato and Onion Slow-Cooker Pot Roast vegetables",
    );
    // The "with …" clause still goes.
    assert.equal(bowlNameFor("Breaded Chicken Cutlets with Vodka Sauce", null, null, 0, false, false, "sauce jar"), "Breaded Chicken Cutlets sauce jar");
  });

  it("3 · a cook day already gone is named, never '(Saturday, today)'", () => {
    const lemon: Meal = {
      id: uuid(3), name: "Lemon-Herb Baked Chicken", day: "Saturday", lag: 0,
      dishes: [{
        id: uuid(31), name: "Garlic Herb Roasted Potatoes",
        ings: [{ id: uuid(301), name: "baby Yukon gold potatoes", category: "Produce", quantity: 1.5, unit: "lb", note: "halved" }],
        steps: [
          { i: 0, phase: "prep", text: "Halve 1½ lb baby Yukon gold potatoes.", ids: [uuid(301)] },
          { i: 1, phase: "cook", text: "Roast the potatoes at 425°F for 30 minutes." },
        ],
      }],
    };
    const past = buildPrepWeekPlan(load([lemon], new Set([uuid(3)]))).heldLines;
    assert.ok(past.length > 0, "the potatoes are held for cook day");
    for (const l of past) {
      assert.doesNotMatch(l, /today/, l);
      assert.match(l, /\(Saturday\)/, l);
    }
    // A cook day that IS today still says so.
    assert.ok(buildPrepWeekPlan(load([lemon])).heldLines.some((l) => /\(Saturday, today\)/.test(l)));
  });

  it("4 · cubing tofu is knife work by weight, not a 1-minute measure", () => {
    const r = timeRow("extra-firm tofu", "pressed and cut into 1-inch cubes", "28 oz", undefined, ["cube"]);
    assert.equal(r.action, "meat-cube");
    assert.ok(r.minutes > 4, `${r.minutes} min for 1¾ lb`);
  });

  it("5 · a dish name ending in its container's word is not doubled", () => {
    assert.equal(joinUse("Velvety Nacho Cheese Sauce", "sauce jar"), "Velvety Nacho Cheese Sauce jar");
    assert.equal(joinUse("Chimichurri Marinade", "marinade bowl"), "Chimichurri Marinade bowl");
    assert.equal(joinUse("Cajun Spice Blend", "spice blend"), "Cajun Spice Blend");
    assert.equal(joinUse("Taco Toppings", "toppings plate"), "Taco Toppings plate");
    // A one-word use is never folded away, and an unrelated one is untouched.
    assert.equal(joinUse("Roasted Vegetables", "vegetables"), "Roasted Vegetables vegetables");
    assert.equal(joinUse("Carne Asada", "marinade bowl"), "Carne Asada marinade bowl");
  });

  // (A patted-dry protein that meets a marinade keeps its step: H7.1 2b's tests.)
  it("6 · setting out a package is not a prep step (D-WS9-299); trimming it still is", () => {
    const chops: Meal = {
      id: uuid(6), name: "Breaded Pork Chops", day: "Wednesday", lag: 3,
      dishes: [{
        id: uuid(61), name: "Crispy Breaded Pork Chops",
        ings: [{ id: uuid(601), name: "bone-in pork chops", category: "Protein", quantity: 4, unit: "each", note: "about 3/4 inch thick, ~7 oz each" }],
        steps: [
          { i: 0, phase: "prep", text: "Pat the 4 bone-in pork chops dry with paper towels, then season both sides with salt and pepper.", ids: [uuid(601)] },
          { i: 1, phase: "cook", text: "Fry the chops in a large skillet 4–5 minutes per side." },
        ],
      }],
    };
    const step = buildPrepWeekPlan(load([chops])).stepPlan.steps.find((s) => s.phase === "proteins")!;
    assert.ok(step, "the chops have a step to judge");
    assert.equal(step.demoted?.reason, "heat-or-no-knife-work");

    // Trimmed chops are knife work and stay.
    const trimmed = structuredClone(chops);
    trimmed.dishes[0].steps[0].text = "Trim the excess fat from the 4 bone-in pork chops and pat them dry.";
    assert.equal(buildPrepWeekPlan(load([trimmed])).stepPlan.steps.find((s) => s.phase === "proteins")!.demoted, undefined);
  });
});
