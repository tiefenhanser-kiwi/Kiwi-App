// THX-3c — Prep the feast: E (the make-ahead dishes' cuts, measured to their own
// day) and G (no tub of whole spices alone).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildFeastSession, buildPrepWeekPlan, finishPrepWeek } from "../prepWeekBuild";
import { assemblePrepWeekResult, engineTitle } from "../prepWeekAssembly";
import { PREP_ENGINE_VERSION } from "../prepWeekFingerprint";
import type { LoadPrepWeekInputResult } from "../prepWeekAggregation";

type Load = Pick<LoadPrepWeekInputResult, "input" | "cookDays" | "identity">;
const M = "f0000000-0000-4000-8000-0000000000c1";
const I = (n: number) => `f1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ing = (n: number, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null = null) => ({
  ingredientId: I(n), ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});

/** One make-ahead gravy whose stock step adds `spices` beside the neck and onion. */
function gravy(spices: ReturnType<typeof ing>[], words: string): Load {
  const rows = [ing(1, "turkey neck", "Protein", 1, "each"), ing(2, "yellow onion", "Produce", 1, "each", "chopped"), ...spices];
  return {
    input: {
      planId: "f2000000-0000-4000-8000-0000000000c1",
      planName: "THX-3c gravy",
      meals: [{
        mealId: M, mealName: "THX-3c Thanksgiving", servingsOverride: null, feast: true,
        dishes: [{
          dishId: "fd000000-0000-4000-8000-0000000000c1", dishName: "Pan Gravy", dishRole: "sauce", baseServings: 10, authoredBaseServings: 10,
          ingredients: rows, makeAheadDays: ["tue"],
          stepTexts: [`Make ahead (Tuesday): Simmer the turkey neck, the chopped onion, ${words} in 6 cups water for 1 hour.`],
          componentSteps: [{ stepIndex: 0, phaseType: "cook", componentKey: null, text: `Make ahead (Tuesday): Simmer the turkey neck, the chopped onion, ${words} in 6 cups water for 1 hour.`, ingredientIds: rows.map((r) => r.ingredientId) }],
        }],
      }],
    },
    cookDays: { prepDay: null, lagByMealId: new Map([[M, 4]]), dayNameByMealId: new Map([[M, "Thursday"]]) },
    identity: undefined,
  } as unknown as Load;
}
const dryContainers = (l: Load) =>
  buildFeastSession(l)!.stepPlan.steps.filter((s) => !s.demoted && s.phase === "seasonings_dry" && s.bowlName).map((s) => s.components.map((c) => c.ingredientName).sort().join(", "));

describe("THX-3c G — a feast dry container of whole spices alone keeps the floor of three", () => {
  it("bay leaves and peppercorns are no container: their amounts stay in the recipe step", () => {
    assert.deepEqual(dryContainers(gravy([ing(3, "bay leaves", "Pantry", 2, "each"), ing(4, "black peppercorns", "Pantry", 1, "teaspoon")], "2 bay leaves and 1 teaspoon black peppercorns")), []);
  });

  it("three whole spices are a container", () => {
    assert.deepEqual(
      dryContainers(gravy([ing(3, "bay leaves", "Pantry", 2, "each"), ing(4, "black peppercorns", "Pantry", 1, "teaspoon"), ing(5, "whole cloves", "Pantry", 3, "each")], "2 bay leaves, 1 teaspoon black peppercorns and 3 whole cloves")),
      ["bay leaves, black peppercorns, whole cloves"],
    );
  });

  // THX-3d (R1) — THX-3's feast floor of two is gone: two items of any kind stay in
  // their recipe step (the brine's salt and sugar), three make a mix.
  it("THX-3d R1 — a whole spice beside one other measure is no mix (the feast's floor is three)", () => {
    assert.deepEqual(
      dryContainers(gravy([ing(3, "bay leaves", "Pantry", 2, "each"), ing(6, "granulated sugar", "Pantry", 1, "tablespoon")], "2 bay leaves and 1 tablespoon granulated sugar")),
      [],
    );
  });

  it("THX-3d R1 — a pinch of salt the step names in words joins the mix (sugar, cinnamon stick, salt)", () => {
    const rows = [ing(6, "granulated sugar", "Pantry", 1.5, "cup"), ing(7, "cinnamon stick", "Pantry", 1, "each"), ing(8, "kosher salt", "Pantry", 1, "pinch")];
    const l = gravy(rows, "1½ cups granulated sugar, 1 cinnamon stick, and a pinch of kosher salt");
    // The pinch has no amountRef: the step's ids hold everything but it.
    const d = (l as any).input.meals[0].dishes[0];
    d.componentSteps[0].ingredientIds = d.componentSteps[0].ingredientIds.filter((id: string) => id !== I(8));
    assert.deepEqual(dryContainers(l), ["cinnamon stick, granulated sugar, kosher salt"]);
  });
});

// ── E — a Make-Ahead-shaped feast, read on Sunday (Thursday is 4 days out) ─────
const D = (n: number) => `fd000000-0000-4000-8000-0000000000e${n}`;
const step = (stepIndex: number, phaseType: string, text: string, ids: number[]) => ({ stepIndex, phaseType, componentKey: null, text, ingredientIds: ids.map(I) });
const dish = (n: number, dishName: string, rows: ReturnType<typeof ing>[], steps: ReturnType<typeof step>[], makeAheadDays?: string[]) => ({
  dishId: D(n), dishName, dishRole: "side", baseServings: 10, authoredBaseServings: 10, ingredients: rows,
  stepTexts: steps.map((s) => s.text), componentSteps: steps, ...(makeAheadDays ? { makeAheadDays } : {}),
});
function makeAhead(feast = true): Load {
  return {
    input: {
      planId: "f2000000-0000-4000-8000-0000000000e1",
      planName: "THX-3c make-ahead",
      meals: [{
        mealId: M, mealName: "THX-3c Make-Ahead Thanksgiving", servingsOverride: null, ...(feast ? { feast: true } : {}),
        dishes: [
          dish(1, "Make-Ahead Gravy", [ing(31, "yellow onion", "Produce", 1, "each", "roughly chopped"), ing(32, "garlic", "Produce", 4, "clove", "smashed"), ing(33, "turkey wings", "Protein", 2, "pound")], [
            step(0, "cook", "Make ahead (Tuesday): Sear the turkey wings; add the chopped onion and the smashed garlic.", [33, 31, 32]),
          ], ["tue"]),
          dish(2, "Overnight Stuffing", [ing(41, "fresh flat-leaf parsley", "Produce", 0.25, "cup", "chopped"), ing(42, "fresh thyme", "Produce", 2, "tablespoon", "leaves only"), ing(43, "chicken stock", "Pantry", 3, "cup")], [
            step(0, "cook", "Make ahead (Wednesday): Toss the bread with ¼ cup chopped parsley, 2 tablespoons thyme leaves and 3 cups stock.", [41, 42, 43]),
          ], ["wed"]),
          dish(3, "Mashed Potato Casserole", [ing(51, "Russet potatoes", "Produce", 5, "pound", "peeled and cut into 2-inch chunks"), ing(52, "fresh chives", "Produce", 3, "tablespoon", "thinly sliced, for topping"), ing(53, "whole milk", "Dairy", 0.75, "cup")], [
            step(0, "cook", "Make ahead (Wednesday): Boil the potato chunks until tender; mash with ¾ cup milk.", [51, 53]),
            step(1, "assemble", "On Thursday: Scatter 3 tablespoons sliced chives over the top and serve.", [52]),
          ], ["wed"]),
          dish(4, "Green Beans", [ing(61, "fresh flat-leaf parsley", "Produce", 2, "tablespoon", "chopped, for garnish")], [
            step(0, "assemble", "Scatter 2 tablespoons chopped parsley over the beans and serve.", [61]),
          ]),
          // Monday's sauce: the session is done before Monday, so Thursday is 4 days out.
          dish(5, "Cranberry Sauce", [ing(71, "orange", "Produce", 1, "each", "zested and juiced"), ing(72, "fresh cranberries", "Produce", 12, "ounce", "rinsed")], [
            step(0, "cook", "Make ahead (Monday): Simmer 12 oz cranberries with the orange zest and juice.", [72, 71]),
          ], ["mon"]),
        ],
      }],
    },
    cookDays: { prepDay: null, lagByMealId: new Map([[M, 4]]), dayNameByMealId: new Map([[M, "Thursday"]]) },
    identity: undefined,
  } as unknown as Load;
}
const finish = (b: NonNullable<ReturnType<typeof buildFeastSession>>) =>
  finishPrepWeek(assemblePrepWeekResult(b.stepPlan, { steps: b.stepPlan.steps.filter((s) => !s.fixedProse).map((s) => ({ stepId: s.stepId, title: engineTitle(s) || "Prep", instructions: `${engineTitle(s) || "Prep"}.` })) }), b);

describe("THX-3c E — the make-ahead dishes' cuts are back in Prep the feast", () => {
  const b = buildFeastSession(makeAhead())!;
  const produce = b.stepPlan.steps.filter((s) => s.phase === "produce" && !s.demoted);
  const cut = (name: string) => produce.find((s) => s.components.some((c) => c.ingredientName === name));

  it("the gravy's onion and smashed garlic, the stuffing's parsley and thyme leaves, the casserole's chives", () => {
    for (const n of ["yellow onion", "garlic", "fresh flat-leaf parsley", "fresh thyme", "fresh chives"]) assert.ok(cut(n), `${n} missing: ${produce.map((s) => s.stepKey).join(", ")}`);
    assert.ok(cut("garlic")!.components[0].measures.some((m) => m.preparationNote === "smashed" || /smashed/.test(m.amount)));
  });

  it("but not the stock, the milk or the turkey wings", () => {
    const all = b.stepPlan.steps.filter((s) => !s.demoted).flatMap((s) => s.components.map((c) => c.ingredientName));
    assert.ok(!all.some((n) => /stock|milk|wings/.test(n)), all.join(", "));
  });

  it("a potato is cut the morning of ITS day — Wednesday, never Thursday", () => {
    const held = finish(b).phases.find((p) => p.phase === "proteins")?.heldForCookDay ?? [];
    assert.deepEqual(held.filter((l) => /Russet/.test(l)), ["Mashed Potato Casserole (Wednesday, 3 days out) — cut the Russet potatoes (it browns once cut) that morning."]);
  });

  it("holds are measured to the dish's day: Wednesday's parsley keeps (3 of 3 days), Thursday's waits (4 > 3)", () => {
    const parsley = cut("fresh flat-leaf parsley")!;
    const h = b.holds.get(parsley.stepKey);
    assert.ok(h && !h.all, "the stuffing's parsley is prepped today");
    assert.deepEqual(h!.heldPortions.map((p) => [p.dish, p.day, p.lag]), [["Green Beans", "Thursday", 4]]);
    const held = finish(b).phases.find((p) => p.phase === "proteins")?.heldForCookDay ?? [];
    // Thursday's two garnishes (3-day herbs, 4 days out) share Thursday's line, named by their dishes.
    assert.ok(held.includes("Green Beans and Mashed Potato Casserole (Thursday, 4 days out) — chop the fresh flat-leaf parsley and thinly slice the fresh chives that morning."), held.join("\n"));
  });

  it("the weeknight is as it was: no smashed garlic or thyme leaves as work, chives for topping not prep", () => {
    const week = buildPrepWeekPlan(makeAhead(false));
    const live = week.stepPlan.steps.filter((s) => s.phase === "produce" && !s.demoted).flatMap((s) => s.components.map((c) => c.ingredientName));
    assert.ok(!live.includes("fresh thyme") && !live.includes("fresh chives"), live.join(", "));
  });

  it("the engine moved: version 15 (12 for E, 13 for the follow-up, 14 for THX-3d, 15 for its round 2)", () => {
    assert.equal(PREP_ENGINE_VERSION, 15);
  });
});

// ── item 5 — a garnish rule 7 drops in the feast is said, never silent ─────────
describe("THX-3c item 5 — a feast garnish over the container target gets a cook-day line", () => {
  // Sixteen sides, each its own vegetables container (over the target of 15), and one
  // single-dish garnish: rule 7 drops the chives.
  const sides = Array.from({ length: 16 }, (_, k) =>
    dish(10 + k, `Side ${k}`, [ing(100 + 2 * k, `carrot ${k}`, "Produce", 2, "each", "diced"), ing(101 + 2 * k, `parsnip ${k}`, "Produce", 2, "each", "diced")], [
      step(0, "cook", `Cook the diced carrot ${k} and parsnip ${k} in butter.`, [100 + 2 * k, 101 + 2 * k]),
    ]),
  );
  const chives = dish(9, "Mashed Potatoes", [ing(90, "fresh chives", "Produce", 2, "tablespoon", "thinly sliced, for garnish")], [
    step(0, "assemble", "On Thursday: Scatter 2 tablespoons sliced chives over the potatoes and serve.", [90]),
  ]);
  const load = makeAhead();
  (load.input.meals[0] as { dishes: unknown[] }).dishes = [chives, ...sides];
  const b = buildFeastSession(load)!;

  it("rule 7 dropped the chives step", () => {
    const st = b.stepPlan.steps.find((s) => s.components.some((c) => c.ingredientName === "fresh chives"))!;
    assert.match(st.demoted?.reason ?? "", /^rule 7/);
  });

  it("…and the cook-day list says when to slice them", () => {
    const held = finish(b).phases.find((p) => p.phase === "proteins")?.heldForCookDay ?? [];
    assert.ok(held.some((l) => /^Mashed Potatoes \(Thursday, \d days? out\) — thinly slice the fresh chives that morning\.$/.test(l)), held.join("\n"));
  });
});
