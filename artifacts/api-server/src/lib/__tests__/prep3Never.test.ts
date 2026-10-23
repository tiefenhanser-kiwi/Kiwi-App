// PREP-3 (R8) — what is never prepped: equipment is never measured into a container, an
// avocado is never a morning cut, and a weeknight cut the dish uses within its first ten
// minutes is a step of it, not a morning step ("this morning" two minutes later).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { combinePrep, isNeverMeasured, type PrepCombineInput } from "../prepCombineEngine";
import { buildStepPlan, containerNamesOf } from "../prepWeekAssembly";
import { morningSteps } from "../heldCookDay";
import { HELD_MORNING_STEP } from "../cookingScheduler";
import { MORNING_MIN_LEAD } from "../heldMorning";
import type { LoadPrepWeekInputResult, PrepLoadedPlan } from "../prepWeekAggregation";
import { buildPrepWeekPlan } from "../prepWeekBuild";

const MEAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// The equipment rows dev's catalog holds (PREP-3 probe), plus the ones the list names.
const EQUIPMENT_ROWS = ["wooden or metal skewers", "wooden skewers", "toothpicks", "toothpicks or kitchen twine", "toothpicks or wooden skewers", "large brining bag", "aluminum foil", "parchment paper", "kitchen twine", "cupcake liners", "plastic wrap"];

function skewerMarinade(): PrepCombineInput {
  const component = { key: "marinade", noun: "marinade", bowlName: "Lemon-Herb Marinated Chicken Skewers marinade bowl" };
  const m = (ingredientId: string, ingredientName: string, category: string, quantity: number, unit: string, preparationNote?: string) => ({
    ingredientId, ingredientName, category, quantity, unit, ...(preparationNote ? { preparationNote } : {}), component, momentKey: "c:marinade",
  });
  return {
    meals: [{
      mealId: MEAL,
      mealName: "Mediterranean Chicken Skewers",
      dishes: [{
        dishId: "d1",
        dishName: "Lemon-Herb Marinated Chicken Skewers",
        dishRole: "main",
        ingredients: [
          m("oregano", "dried oregano", "Pantry", 1.5, "tsp"),
          m("thyme", "dried thyme", "Pantry", 0.5, "tsp"),
          m("cumin", "ground cumin", "Pantry", 0.5, "tsp"),
          m("paprika", "smoked paprika", "Pantry", 0.5, "tsp"),
          m("oil", "extra-virgin olive oil", "Pantry", 3, "tbsp"),
          m("garlic", "garlic cloves", "Produce", 4, "clove", "minced"),
          ...EQUIPMENT_ROWS.map((name, i) => m(`eq${i}`, name, i % 2 ? "Other" : "Pantry", 8, "each", "if wooden, soaked in water 30 minutes")),
        ],
      }],
    }],
  };
}

describe("PREP-3 (R8) — equipment is never measured", () => {
  it("every equipment row is on the list", () => {
    for (const n of EQUIPMENT_ROWS) assert.ok(isNeverMeasured(n), n);
    for (const food of ["pretzel sticks", "cinnamon stick", "celery sticks", "rice paper wrappers"]) assert.equal(isNeverMeasured(food), false, food);
  });

  it("no container holds an equipment word (the skewers' marinade bowl)", () => {
    const sp = buildStepPlan(combinePrep(skewerMarinade()), "Test Plan");
    for (const st of sp.steps) {
      // A fixed word list, not EQUIPMENT itself (a test against the list it tests proves nothing).
      for (const c of st.components) assert.doesNotMatch(c.ingredientName, /skewer|toothpick|twine|foil|parchment|liner|plastic wrap|\bbag\b/i, `${st.stepKey}: ${c.ingredientName}`);
    }
    assert.ok(sp.steps.some((s) => containerNamesOf(s).some((n) => / marinade bowl$/.test(n))), "the marinade itself is still a container");
  });
});

const s = (stepIndex: number, estimatedMinutes: number, text: string, phaseType = "prep") => ({ stepIndex, estimatedMinutes, phaseType, text });

describe("PREP-3 (R8) — the morning cut", () => {
  it("an avocado is never a morning cut: the guacamole's own step is untouched", () => {
    const guac = [
      s(0, 5, "Finely dice ¼ cup red onion, mince 1 seeded jalapeño, and finely chop 3 tablespoons fresh cilantro."),
      s(1, 3, "Halve, pit, and scoop the flesh of 3 ripe Hass avocados into a medium bowl.", "assemble"),
      s(2, 2, "Add 2 tablespoons lime juice immediately and mash with a fork.", "assemble"),
    ];
    const out = morningSteps(guac, [{ name: "ripe Hass avocados", quantity: 3, unit: "each", note: "halved, pitted and scooped" }], { minLead: MORNING_MIN_LEAD });
    assert.ok(out.every((x) => !x.changed), JSON.stringify(out.filter((x) => x.changed)));
  });

  it("used within the first ten minutes: a plain first step, no hold, no \"this morning\" (Friday's parsley)", () => {
    const meatballs = [
      s(0, 3, "Combine ½ cup plain breadcrumbs and ¼ cup whole milk in a large bowl and let soak for 2 minutes."),
      s(1, 5, "Add the ground beef, the egg, 3 tablespoons finely chopped fresh flat-leaf parsley and the Parmesan to the soaked breadcrumbs and mix gently."),
      s(2, 5, "Roll the meat mixture into 16 equal balls."),
    ];
    const out = morningSteps(meatballs, [{ name: "fresh flat-leaf parsley", quantity: 3, unit: "tablespoon", note: "finely chopped" }], { minLead: MORNING_MIN_LEAD });
    const added = out.filter((x) => x.isNew);
    assert.equal(added.length, 1);
    assert.equal(out[0], added[0], "it comes first");
    assert.doesNotMatch(added[0].text, HELD_MORNING_STEP);
    assert.ok(out.every((x) => !/this morning/.test(x.text)), out.map((x) => x.text).join(" | "));
  });

  it("used after the first ten minutes: still the morning cut (Friday's broccoli, blanched at minute 11)", () => {
    const broccoli = [
      s(0, 5, "Mince the 2 garlic cloves and cut ¾ pound broccoli into bite-sized florets."),
      s(1, 6, "Bring a large pot of salted water to a boil over high heat.", "preheat"),
      s(2, 3, "Blanch the broccoli florets in the boiling water for 2 minutes, then drain.", "cook"),
    ];
    const out = morningSteps(broccoli, [{ name: "broccoli", quantity: 0.75, unit: "pound", note: "cut into bite-sized florets" }], { minLead: MORNING_MIN_LEAD });
    assert.match(out[0].text, HELD_MORNING_STEP);
  });

  it("the feast's patch passes no lead: its morning cuts are as they were", () => {
    const meatballs = [
      s(0, 3, "Combine the breadcrumbs and milk."),
      s(1, 5, "Add 3 tablespoons finely chopped fresh flat-leaf parsley and mix."),
    ];
    const out = morningSteps(meatballs, [{ name: "fresh flat-leaf parsley", quantity: 3, unit: "tablespoon", note: "finely chopped" }]);
    assert.ok(out.some((x) => HELD_MORNING_STEP.test(x.text)));
  });
});


/** One meal of one dish for the week's build (BUG-359's loader, cut down). */
function oneMealLoad(day: string, lag: number, ings: { id: string; name: string; category: string; quantity: number; unit: string; note?: string }[], steps: { i: number; phase: string; text: string; ids?: string[] }[]): LoadPrepWeekInputResult {
  const mealId = "00000001-0000-4000-8000-0000000p3e08";
  const input: PrepLoadedPlan = {
    planId: "00000999-0000-4000-8000-0000000p3e08",
    planName: "PREP-3 R8",
    meals: [{
      mealId, mealName: "Steak Fajita Bowl", cuisine: null, servingsOverride: null,
      dishes: [{
        dishId: "00000011-0000-4000-8000-0000000p3e08", dishName: "Chunky Guacamole", dishRole: "main" as const, baseServings: 4, authoredBaseServings: 4,
        ingredients: ings.map((x) => ({ ingredientId: x.id, ingredientName: x.name, category: x.category, quantity: x.quantity, unit: x.unit, preparationNote: x.note ?? null, sourceYield: null, purchaseUnit: null })),
        stepTexts: steps.map((s) => s.text),
        componentSteps: steps.map((s) => ({ stepIndex: s.i, text: s.text, componentKey: null, ingredientIds: s.ids ?? [], phaseType: s.phase })),
      }],
    }],
  };
  return { input, planRevisionId: 1, cookDays: { prepDay: "2026-10-25", lagByMealId: new Map([[mealId, lag]]), dayNameByMealId: new Map([[mealId, day]]) }, identity: { foldedIdByIngredientId: new Map() } };
}

describe("PREP-3 (R8) — Prep the Week's held line for an avocado", () => {
  it("\"cut the ripe Hass avocados as you cook\", never \"that morning\"", () => {
    const AVO = "00000101-0000-4000-8000-0000000p3e08";
    const lines = buildPrepWeekPlan(oneMealLoad("Tuesday", 2, [
      { id: AVO, name: "ripe Hass avocados", category: "Produce", quantity: 3, unit: "each", note: "halved, pitted and scooped" },
    ], [
      { i: 0, phase: "assemble", text: "Halve, pit, and scoop the flesh of 3 ripe Hass avocados into a medium bowl.", ids: [AVO] },
      { i: 1, phase: "assemble", text: "Mash with a fork." },
    ])).heldLines;
    const line = lines.find((l) => /avocado/i.test(l));
    assert.ok(line, lines.join(" | "));
    assert.match(line!, /cut the ripe Hass avocados as you cook \(they brown once cut\)/);
    assert.doesNotMatch(line!, /that morning/);
  });
});
