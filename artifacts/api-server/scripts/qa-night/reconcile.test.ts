// QA-NIGHT-1 — every reconciler on hand-made fixtures that pass and that fail.
//   node --import tsx --test scripts/qa-night/reconcile.test.ts      (from artifacts/api-server)
// No database, no server, no network: the reconcilers are pure.
import assert from "node:assert/strict";
import { test } from "node:test";

import { answerFold, appFold, planFold } from "./appFold";
import { proofProblems, type BootProof } from "./server";
import { mayStart } from "./spend";
import { parseRunArgs } from "./cookSim";
import { applyKnown, type KnownBug, matchKnown, newHigh, renderSummary, resultLine } from "./summary";
import { reconcileR1, reconcileR2, reconcileR3, type GroceryEvidence } from "./reconcileGrocery";
import {
  allowance,
  cookKey,
  proseAmounts,
  reconcileR4,
  reconcileR5,
  reconcileR6,
  reconcileR7,
  reconcileR8,
  reconcileR9,
  reconcileR10,
  reconcileR11,
  reconcileR12,
  bowlShares,
  splitDishesOf,
  stepAmounts,
  type FeastEvidence,
} from "./reconcilePrepCook";

const round2 = (n: number) => Math.round(n * 100) / 100;
import type { CallRecord, Finding, GroceryRow, PlanMeal, PrepSession, RecipeStep } from "./types";
import { normName, sameFood } from "./units";

// ── fixtures ────────────────────────────────────────────────────────────────

const tacos = (over: Partial<PlanMeal> = {}): PlanMeal => ({
  planItemId: "item-tacos", mealId: "meal-tacos", title: "Chicken Tacos", aliases: ["Chicken Tacos"],
  servingsOverride: null, birdWeightLb: null, isFeast: false,
  dishes: [{
    dishId: "d-tacos", title: "Tacos", servings: 4, defaultServings: 4,
    ingredients: [
      { name: "chicken thighs", quantity: 1.5, unit: "lb", isOptional: false },
      { name: "yellow onion", quantity: 1, unit: "each", isOptional: false },
      { name: "lime juice", quantity: 2, unit: "tbsp", isOptional: false },
      { name: "cilantro", quantity: 1, unit: "bunch", isOptional: true },
    ],
    steps: [
      { stepIndex: 0, text: "Dice the yellow onion and slice the chicken thighs.", estimatedMinutes: 10, phaseType: "prep" },
      { stepIndex: 1, text: "Cook the chicken with the onion; finish with lime juice.", estimatedMinutes: 15, phaseType: "cook" },
    ],
  }],
  ...over,
});

const soup = (): PlanMeal => ({
  planItemId: "item-soup", mealId: "meal-soup", title: "Onion Soup", aliases: ["Onion Soup"],
  servingsOverride: null, birdWeightLb: null, isFeast: false,
  dishes: [{
    dishId: "d-soup", title: "Soup", servings: 4, defaultServings: 4,
    ingredients: [
      { name: "yellow onion", quantity: 3, unit: "each", isOptional: false },
      { name: "beef broth", quantity: 4, unit: "cup", isOptional: false },
    ],
    steps: [
      { stepIndex: 0, text: "Slice the yellow onion.", estimatedMinutes: 10, phaseType: "prep" },
      { stepIndex: 1, text: "Simmer the onion in the beef broth.", estimatedMinutes: 40, phaseType: "cook" },
    ],
  }],
});

const row = (over: Partial<GroceryRow>): GroceryRow => ({
  id: over.displayName ?? "r", displayName: "x", canonicalName: null, quantity: 1, unit: "each", mealNames: [],
  isChecked: false, isUniversalStaple: false, isUserPantryStaple: false, isRecurringItem: false, isUserAdded: false, isOptional: false,
  ...over,
});

const goodList = (): GroceryRow[] => [
  row({ displayName: "Chicken thighs", quantity: 1.5, unit: "lb", mealNames: ["Chicken Tacos"] }),
  row({ displayName: "Yellow onion", quantity: 4, unit: "each", mealNames: ["Chicken Tacos", "Onion Soup"] }),
  row({ displayName: "Lime juice", quantity: 0.125, unit: "cup", mealNames: ["Chicken Tacos"] }),
  row({ displayName: "Beef broth", quantity: 32, unit: "fl oz", mealNames: ["Onion Soup"] }),
  row({ displayName: "Kosher salt", quantity: 1, unit: "each", isUniversalStaple: true }),
  row({ displayName: "Paper towels", quantity: 1, unit: "each", isUserAdded: true }),
];

const grocery = (rows: GroceryRow[], meals = [tacos(), soup()]): GroceryEvidence => ({ label: "fixture", meals, rows });

// ── R1 ──────────────────────────────────────────────────────────────────────

test("R1 passes a list that covers every recipe line (units converted: 2 tbsp ≤ ⅛ cup, 4 cups = 32 fl oz)", () => {
  const r = reconcileR1("t", grocery(goodList()));
  assert.deepEqual(r.findings, []);
  assert.ok(r.checked >= 5);
});

test("R1 reports a missing grocery row", () => {
  const r = reconcileR1("t", grocery(goodList().filter((x) => x.displayName !== "Chicken thighs")));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].signature, "R1:missing:chicken thigh");
  assert.equal(r.findings[0].severity, "high");
});

test("R1 reports a shortfall after a servings change, with both numbers", () => {
  const r = reconcileR1("t", grocery(goodList(), [tacos({ servingsOverride: 8 }), soup()]));
  const f = r.findings.find((x) => x.signature === "R1:shortfall:chicken thigh");
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f!.numbers!.listQty, 1.5);
  assert.ok(Math.abs(Number(f!.numbers!.need) - 1360.78) < 1); // 3 lb in grams
});

test("R1 counts a recipe line on a row in another unit family as not comparable, never a shortfall", () => {
  const r = reconcileR1("t", grocery(goodList().map((x) => (x.displayName === "Beef broth" ? { ...x, quantity: 2, unit: "carton" } : x))));
  assert.deepEqual(r.findings, []);
  assert.equal(r.notComparable, 1);
});

// ── R2 ──────────────────────────────────────────────────────────────────────

test("R2 passes: staples and user-added rows are labeled, every other row traces to a meal", () => {
  const r = reconcileR2("t", grocery(goodList()));
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.counts, { traced: 4, staples: 1, userAdded: 1, recurring: 0 });
});

test("R2 reports a row no recipe of its meal names, and a row for a meal not on the plan", () => {
  const rows = [...goodList(), row({ displayName: "Heavy cream", mealNames: ["Onion Soup"] }), row({ displayName: "Tortillas", mealNames: ["Fish Tacos"] })];
  const r = reconcileR2("t", grocery(rows));
  assert.deepEqual(r.findings.map((f) => f.signature).sort(), ["R2:row-for-meal-not-on-plan", "R2:row-not-in-recipes:heavy cream"]);
});

// ── R3 ──────────────────────────────────────────────────────────────────────

test("R3 passes a swap whose list followed", () => {
  const before = grocery(goodList());
  const after = grocery(goodList().filter((x) => !x.mealNames.every((n) => n === "Onion Soup")).map((x) => ({ ...x, quantity: x.displayName === "Yellow onion" ? 1 : x.quantity, mealNames: x.mealNames.filter((n) => n !== "Onion Soup") })), [tacos()]);
  const r = reconcileR3("t", { edit: "swap", mealTitle: "Chicken Tacos", mealAliases: ["Chicken Tacos"], before, after, removedTitles: ["Onion Soup"], reconciled: true });
  assert.deepEqual(r.findings, []);
});

test("R3 reports a removed meal's rows left on the list, and a list that did not move", () => {
  const before = grocery(goodList());
  const after = grocery(goodList(), [tacos()]);
  const r = reconcileR3("t", { edit: "swap", mealTitle: "Chicken Tacos", mealAliases: ["Chicken Tacos"], before, after, removedTitles: ["Onion Soup"], reconciled: false });
  const sigs = r.findings.map((f) => f.signature);
  assert.ok(sigs.includes("R3:swap:removed-meal-rows-remain"), sigs.join());
  assert.ok(sigs.includes("R3:swap:list-did-not-follow"), sigs.join());
});

test("R3 finds the edited meal's rows under any of its names (the list may use the long title)", () => {
  const before = grocery(goodList());
  const after = grocery(goodList().map((x) => (x.displayName === "Chicken thighs" ? { ...x, quantity: 3 } : x)), [tacos({ servingsOverride: 8 }), soup()]);
  const r = reconcileR3("t", { edit: "servings", mealTitle: "Tacos", mealAliases: ["Tacos", "Chicken Tacos"], before, after, removedTitles: [], reconciled: true });
  assert.ok(!r.findings.some((f) => f.signature.endsWith("list-did-not-follow")), r.findings.map((f) => f.signature).join());
});

// ── R4 ──────────────────────────────────────────────────────────────────────

const week = (steps: PrepSession["steps"]): PrepSession => ({ kind: "week", mealIds: [], steps });

const goodWeek = () => week([
  { stepKey: "week-labels", phase: "seasonings_dry", title: "Label 2 containers", instructions: "Onions · Chicken", contributesToMealIds: [], labelCount: 2, holdsNoContainer: true },
  { stepKey: "produce#onion", phase: "produce", title: "Dice 4 yellow onions", instructions: "Dice 4 yellow onions; 1 for the tacos, 3 for the soup.", contributesToMealIds: ["meal-tacos", "meal-soup"], containerNames: ["Onions"], containerId: "c-onion", coversCookSteps: [{ mealId: "meal-tacos", dishId: "d-tacos", stepIndex: 0 }, { mealId: "meal-soup", dishId: "d-soup", stepIndex: 0 }] },
  { stepKey: "proteins#chicken", phase: "proteins", title: "Slice the chicken", instructions: "Slice 1½ lb chicken thighs.", contributesToMealIds: ["meal-tacos"], containerNames: ["Chicken"], containerId: "c-chicken", coversCookSteps: [{ mealId: "meal-tacos", dishId: "d-tacos", stepIndex: 0 }] },
]);

test("R4 passes prep that stays inside the recipes and inside the list", () => {
  const r = reconcileR4("t", goodWeek(), [tacos(), soup()], goodList());
  assert.deepEqual(r.findings, []);
});

test("R4 reports a doubled prep (the same onions in two steps)", () => {
  const w = goodWeek();
  w.steps.push({ ...w.steps[1], stepKey: "produce#onion-again", title: "Dice 4 yellow onions again" });
  const r = reconcileR4("t", w, [tacos(), soup()]);
  const f = r.findings.find((x) => x.signature === "R4:prepped-twice:yellow onion");
  assert.ok(f, JSON.stringify(r.findings.map((x) => x.signature)));
  assert.equal(f!.numbers!.prepAmount, 8);
  assert.equal(f!.numbers!.recipeAmount, 4);
});

test("R4 reports prep that asks for more than the grocery list buys", () => {
  const rows = goodList().map((x) => (x.displayName === "Yellow onion" ? { ...x, quantity: 2 } : x));
  const r = reconcileR4("t", goodWeek(), [tacos(), soup()], rows);
  assert.deepEqual(r.findings.map((f) => f.signature), ["R4:prep-exceeds-list:yellow onion"]);
  assert.equal(r.findings[0].numbers!.prepAmount, 4);
  assert.equal(r.findings[0].numbers!.listQty, 2);
});

test("R4 lets a whole count round up (half a lemon is one lemon) but not run past it", () => {
  const m = tacos();
  m.dishes[0].ingredients.push({ name: "lemon", quantity: 0.5, unit: "each", isOptional: false });
  const ok = week([{ stepKey: "produce#lemon", phase: "produce", title: "Halve the lemon", instructions: "Halve 1 lemon.", contributesToMealIds: ["meal-tacos"] }]);
  assert.deepEqual(reconcileR4("t", ok, [m]).findings, []);
  const over = week([{ stepKey: "produce#lemon", phase: "produce", title: "Halve the lemons", instructions: "Halve 3 lemons.", contributesToMealIds: ["meal-tacos"] }]);
  assert.deepEqual(reconcileR4("t", over, [m]).findings.map((f) => f.signature), ["R4:prep-exceeds-recipe:lemon"]);
});

test("R4 lets a count round up to the next whole one and one past it, no further (QA-NIGHT-2 C)", () => {
  const m = tacos();
  m.dishes[0].ingredients.push({ name: "garlic cloves", quantity: 4.5, unit: "each", isOptional: false });
  const mince = (n: number) => week([{ stepKey: "produce#garlic", phase: "produce", title: "Mince all garlic", instructions: `Mince ${n} garlic cloves.`, contributesToMealIds: ["meal-tacos"] }]);
  assert.deepEqual(reconcileR4("t", mince(5), [m]).findings, []);
  assert.deepEqual(reconcileR4("t", mince(6), [m]).findings, []);
  assert.deepEqual(reconcileR4("t", mince(7), [m]).findings.map((f) => f.signature), ["R4:prep-exceeds-recipe:garlic"]);
  // Against the list: 14 cloves where it buys 13.625 is rounding; 16 (feast prep, BUG-606) is over.
  const rows = [row({ displayName: "garlic", quantity: 13.625, unit: "clove", mealNames: ["Chicken Tacos"] })];
  const big = tacos();
  big.dishes[0].ingredients.push({ name: "garlic cloves", quantity: 13.625, unit: "each", isOptional: false });
  assert.deepEqual(reconcileR4("t", mince(14), [big], rows).findings, []);
  assert.deepEqual(reconcileR4("t", mince(16), [big], rows).findings.map((f) => f.signature), ["R4:prep-exceeds-recipe:garlic", "R4:prep-exceeds-list:garlic"]);
  assert.equal(allowance(4.5, "each"), 6 + 1e-6);
  assert.equal(allowance(4.5, "each", [2.25, 2.25]), 7 + 1e-6);
});

test("R1 reports a count shortfall with no rounding slack (3 shallots where 3.1 are needed: inside the old 5 %)", () => {
  const m = tacos();
  m.dishes[0].ingredients.push({ name: "shallots", quantity: 3.1, unit: "each", isOptional: false });
  const short = [...goodList(), row({ displayName: "shallots", quantity: 3, unit: "each", mealNames: ["Chicken Tacos"] })];
  assert.deepEqual(reconcileR1("t", grocery(short, [m, soup()])).findings.map((f) => f.signature), ["R1:shortfall:shallot"]);
  const whole = [...goodList(), row({ displayName: "shallots", quantity: 4, unit: "each", mealNames: ["Chicken Tacos"] })];
  assert.deepEqual(reconcileR1("t", grocery(whole, [m, soup()])).findings, []);
});

test("R4 reports a duplicate step key and a cover of a meal the step is not for", () => {
  const w = goodWeek();
  w.steps.push({ ...w.steps[2] });
  w.steps[2] = { ...w.steps[2], coversCookSteps: [{ mealId: "meal-soup", dishId: "d-soup", stepIndex: 1 }] };
  const sigs = reconcileR4("t", w, [tacos(), soup()]).findings.map((f) => f.signature);
  assert.ok(sigs.includes("R4:duplicate-step-key"), sigs.join());
  assert.ok(sigs.includes("R4:covers-other-meal"), sigs.join());
});

test("proseAmounts reads the number, unit and food, and refuses a different food between them", () => {
  assert.deepEqual(proseAmounts("Mince 6 cloves garlic and 2 cups diced yellow onion", "yellow onion"), [{ qty: 2, unit: "cups" }]);
  assert.deepEqual(proseAmounts("Slice 1½ lb chicken thighs", "chicken thighs"), [{ qty: 1.5, unit: "lb" }]);
  assert.deepEqual(proseAmounts("Mix 2 cups of the onion dip", "yellow onion"), []);
  // QA-NIGHT-2 (h4): a step number is no amount.
  assert.deepEqual(proseAmounts("Into the bowl (the lemon zest from produce step 2 and garlic already in it), add: 2¼ tbsp honey", "garlic cloves"), []);
  assert.deepEqual(proseAmounts("Mince 15 cloves of garlic.", "garlic cloves"), [{ qty: 15, unit: "cloves" }]);
});

test("stepAmounts counts a step's total OR its destination lines, never both, and never the later prose", () => {
  const carrots: PrepSession["steps"][number] = { stepKey: "k", phase: "produce", title: "Prep all carrots", contributesToMealIds: [],
    instructions: "Work through 3 carrots: finely diced and sliced.\n1 carrot finely diced — into the Meat sauce vegetables container\n2 carrots sliced — into the Tortellini soup vegetables container" };
  assert.deepEqual(stepAmounts(carrots, "carrots"), [{ qty: 3, unit: "" }]);
  const mix: PrepSession["steps"][number] = { stepKey: "m", phase: "seasonings_dry", title: "Measure the Turkey mix", contributesToMealIds: [],
    instructions: "Into the Turkey mix:\n½ cup kosher salt\n5 bay leaves\nThat's the Turkey mix. On Wednesday night, dissolve it in the 7 sprigs fresh thyme and 1 gallon cold water." };
  assert.deepEqual(stepAmounts(mix, "bay leaves"), [{ qty: 5, unit: "" }]);
  assert.deepEqual(stepAmounts(mix, "fresh thyme"), []);
});

const burgers = (): PlanMeal => ({
  planItemId: "item-burgers", mealId: "meal-burgers", title: "Burgers", aliases: ["Burgers"],
  servingsOverride: null, birdWeightLb: null, isFeast: false,
  dishes: [{
    dishId: "d-burgers", title: "Burgers", servings: 4, defaultServings: 4,
    ingredients: [
      { name: "Worcestershire sauce", quantity: 1, unit: "tsp", isOptional: false, foodId: "f-worc" },
      { name: "hot sauce", quantity: 1, unit: "tsp", isOptional: false, foodId: "f-hot" },
      { name: "ketchup", quantity: 2, unit: "tbsp", isOptional: false, foodId: "f-ketchup" },
    ],
    steps: [{ stepIndex: 0, text: "Mix the sauce.", estimatedMinutes: 2, phaseType: "prep" }],
  }],
});

test("R4 gives each stated amount to the one food it names: \"1 tsp hot sauce\" is not Worcestershire (QA-8 A1, BUG-609)", () => {
  const sauce = week([{ stepKey: "sauces_marinades#burgers", phase: "sauces_marinades", title: "Measure the Burgers sauce", contributesToMealIds: ["meal-burgers"],
    instructions: "Get a small bowl for the Burgers sauce. Into the bowl:\n1 tsp Worcestershire sauce\n1 tsp hot sauce\n2 tbsp ketchup\nStir to combine." }]);
  assert.deepEqual(reconcileR4("t", sauce, [burgers()]).findings, []);
  // With no hot sauce on the plan, its line still names no Worcestershire.
  const m = burgers();
  m.dishes[0].ingredients = m.dishes[0].ingredients.filter((i) => i.name !== "hot sauce");
  assert.deepEqual(reconcileR4("t", sauce, [m]).findings, []);
  // Worcestershire stated twice is still prepped twice.
  const twice = week([...sauce.steps, { ...sauce.steps[0], stepKey: "sauces_marinades#again", title: "Measure it again" }]);
  assert.deepEqual(reconcileR4("t", twice, [burgers()]).findings.map((f) => f.signature).sort(), ["R4:prepped-twice:hot sauce", "R4:prepped-twice:ketchup", "R4:prepped-twice:worcestershire sauce"]);
});

test("R4 counts one food by the server's identity: fresh parsley and flat-leaf parsley in one step (QA-8 A2, BUG-608 void)", () => {
  const meal = (id: string, name: string, qty: number): PlanMeal => ({
    planItemId: `item-${id}`, mealId: `meal-${id}`, title: id, aliases: [id], servingsOverride: null, birdWeightLb: null, isFeast: false,
    dishes: [{ dishId: `d-${id}`, title: id, servings: 3, defaultServings: 3, ingredients: [{ name, quantity: qty, unit: "tbsp", isOptional: false, foodId: "f-parsley" }], steps: [] }],
  });
  const meals = [meal("salmon", "fresh flat-leaf parsley", 1.5), meal("butter-chicken", "fresh parsley", 0.75)];
  const chop = (total: string) => week([{ stepKey: "produce#parsley", phase: "produce", title: "Chop all flat-leaf parsley", contributesToMealIds: ["meal-salmon", "meal-butter-chicken"],
    instructions: `Work through ${total} tbsp fresh flat-leaf parsley: roughly chopped and finely chopped.\n1½ tbsp chopped — into the Salmon plate\n¾ tbsp finely chopped — into the Butter chicken plate` }]);
  assert.deepEqual(reconcileR4("t", chop("2¼"), meals).findings, []);
  assert.deepEqual(reconcileR4("t", chop("4"), meals).findings.map((f) => f.signature), ["R4:prep-exceeds-recipe:parsley"]);
  // Without the identity (two names, two foods) the one step is charged to flat-leaf alone: the night's BUG-608.
  const bare = meals.map((m) => ({ ...m, dishes: m.dishes.map((d) => ({ ...d, ingredients: d.ingredients.map(({ foodId: _, ...i }) => i) })) }));
  assert.deepEqual(reconcileR4("t", chop("2¼"), bare).findings.map((f) => f.signature), ["R4:prep-exceeds-recipe:flat-leaf parsley"]);
});

test("R8 reads a count's noun as Cook Mode shows it, scaled by the app (QA-8, BUG-597)", () => {
  const limes = (text: string, servingsOverride: number | null): PlanMeal => ({
    planItemId: "item-l", mealId: "meal-l", title: "Fish Tacos", aliases: ["Fish Tacos"], servingsOverride, birdWeightLb: null, isFeast: false,
    dishes: [{
      dishId: "d-l", title: "Fish Tacos", servings: 2, defaultServings: 2,
      ingredients: [{ name: "lime", quantity: 1, unit: "", isOptional: false }, { name: "olive oil", quantity: 2, unit: "tablespoon", isOptional: false }],
      steps: [{ stepIndex: 0, text, estimatedMinutes: 2, phaseType: "prep", amountRefs: [{ ingredientId: "i-lime", quantity: 1, unit: "", charStart: 4, charEnd: 5 }] }],
    }],
  });
  const sigs = (m: PlanMeal) => reconcileR8("t", { meal: m, sequence: null, sequenceTotalMinutes: null, cardTotalMinutes: null }).findings.map((f) => f.signature).filter((s) => s.startsWith("R8:scaled"));
  // The server agrees the noun for the plan's number (SERVER-10 E): "1 limes" in the text shows "2 limes".
  assert.deepEqual(sigs(limes("Cut 1 limes, juiced.", 4)), []);
  assert.deepEqual(sigs(limes("Cut 1 lime, juiced.", null)), []);
  assert.deepEqual(sigs(limes("Cut 1 lime, juiced.", 4)), ["R8:scaled-noun-disagrees:lime"]);
  assert.deepEqual(sigs(limes("Cut 1 limes, juiced.", null)), ["R8:scaled-noun-disagrees:lime"]);
  // The proof run's false hits: the number counts the part after the food ("3 garlic cloves", "4 celery stalks").
  const parts = limes("Cut 1 lime wedges.", 4);
  assert.deepEqual(sigs(parts), []);
  // The second night's: "3 beef patties" counts the patties (not one of FORMS or a count unit).
  assert.deepEqual(sigs(limes("Cut 1 lime halves.", 4)), []);
  // A food that ends its phrase is still judged.
  assert.deepEqual(sigs(limes("Cut 1 lime into wedges.", 4)), ["R8:scaled-noun-disagrees:lime"]);
  // The full night's false regression: "Trim the 4 zucchini" at ×¾ shows "3 zucchini", which is right.
  const zucchini = limes("Cut 1 lime.", 4);
  zucchini.dishes[0].ingredients[0].name = "zucchini";
  zucchini.dishes[0].steps[0].text = "Cut 1 zucchini.";
  assert.deepEqual(sigs(zucchini), []);
  // "1 zucchinis" would still be found (a plural after 1).
  zucchini.dishes[0].steps[0].text = "Cut 1 zucchinis.";
  assert.deepEqual(sigs({ ...zucchini, servingsOverride: null }), ["R8:scaled-noun-disagrees:zucchini"]);
});

// ── R12 ─────────────────────────────────────────────────────────────────────

const pepperSteak = (): PlanMeal => ({
  planItemId: "item-steak", mealId: "meal-steak", title: "Pepper Steak", aliases: ["Pepper Steak"],
  servingsOverride: null, birdWeightLb: null, isFeast: false,
  dishes: [{
    dishId: "d-steak", title: "Pepper Steak", servings: 4, defaultServings: 4,
    ingredients: [
      { name: "soy sauce", quantity: 4, unit: "tablespoon", isOptional: false, foodId: "f-soy", ingredientId: "i-soy" },
      { name: "toasted sesame oil", quantity: 1, unit: "tablespoon", isOptional: false, foodId: "f-sesame", ingredientId: "i-sesame" },
      { name: "flank steak", quantity: 1, unit: "lb", isOptional: false, foodId: "f-steak", ingredientId: "i-steak" },
    ],
    steps: [],
  }],
});
const bowlStep = (lines: string[]): PrepSession["steps"][number] => ({ stepKey: "sauces_marinades#steak", phase: "sauces_marinades", title: "Measure the Steak sauce", contributesToMealIds: ["meal-steak"],
  instructions: ["Get a small bowl for the Steak sauce. Into the bowl:", ...lines, "Stir to combine."].join("\n") });
const steakRead = (soy: number, sesame: number): Record<string, RecipeStep> => ({
  [cookKey("d-steak", 0)]: { stepIndex: 0, text: "Toss the sliced steak with the Steak sauce you prepped.", estimatedMinutes: 15, phaseType: "prep" },
  [cookKey("d-steak", 8)]: { stepIndex: 8, text: `Stir in ${soy} tablespoons soy sauce and ${sesame} tablespoon sesame oil.`, estimatedMinutes: 2, phaseType: "cook",
    amountRefs: [{ ingredientId: "i-soy", quantity: soy, unit: "tablespoon" }, { ingredientId: "i-sesame", quantity: sesame, unit: "tablespoon" }] },
});
const r12 = (bowl: string[], read: Record<string, RecipeStep>, hidden = new Set<string>()) =>
  reconcileR12("t", "after full prep", splitDishesOf(pepperSteak(), read, [bowlStep(bowl)], hidden));

test("R12 passes a split whose bowl and later step add up to the recipe (D-WS9-362)", () => {
  const r = r12(["2 tbsp soy sauce", "½ tbsp toasted sesame oil"], steakRead(2, 0.5));
  assert.deepEqual(r.findings, []);
  assert.equal(r.checked, 2);
});

test("R12 reports a bowl that holds the whole row while a later step measures it again, and a later step that says the whole", () => {
  const whole = r12(["4 tbsp soy sauce", "1 tbsp toasted sesame oil"], steakRead(2, 0.5));
  assert.deepEqual(whole.findings.map((f) => f.signature), ["R12:whole-in-bowl-and-again:soy sauce", "R12:whole-in-bowl-and-again:sesame oil"]);
  assert.equal(whole.findings[0].numbers!.bowl, round2(4 * 14.7868));
  const again = r12(["2 tbsp soy sauce", "½ tbsp toasted sesame oil"], steakRead(4, 0.5));
  assert.deepEqual(again.findings.map((f) => f.signature), ["R12:later-step-says-whole:soy sauce"]);
  const off = r12(["1 tbsp soy sauce", "½ tbsp toasted sesame oil"], steakRead(2, 0.5));
  assert.deepEqual(off.findings.map((f) => f.signature), ["R12:shares-do-not-add:soy sauce"]);
});

test("R12 checks nothing that is not a split: the whole row in the bowl and no later measure, or a later step the app folds", () => {
  const read = steakRead(2, 0.5);
  delete read[cookKey("d-steak", 8)].amountRefs;
  assert.equal(r12(["4 tbsp soy sauce", "1 tbsp toasted sesame oil"], read).checked, 0);
  assert.equal(r12(["4 tbsp soy sauce", "1 tbsp toasted sesame oil"], steakRead(2, 0.5), new Set([cookKey("d-steak", 8)])).checked, 0);
  // A bowl Cook Mode never names is not a split either.
  const unnamed = steakRead(2, 0.5);
  unnamed[cookKey("d-steak", 0)].text = "Toss the sliced steak with the soy sauce and sesame oil.";
  assert.equal(r12(["4 tbsp soy sauce", "1 tbsp toasted sesame oil"], unnamed).checked, 0);
  // Authored steps that state the row twice ("remove the 2 bay leaves") restate it: no share to add up.
  const restated = steakRead(4, 1);
  restated[cookKey("d-steak", 0)].amountRefs = [{ ingredientId: "i-soy", quantity: 4, unit: "tablespoon" }, { ingredientId: "i-sesame", quantity: 1, unit: "tablespoon" }];
  const baseline = steakRead(4, 1);
  baseline[cookKey("d-steak", 0)].amountRefs = restated[cookKey("d-steak", 0)].amountRefs;
  const ev = splitDishesOf(pepperSteak(), steakRead(4, 1), [bowlStep(["4 tbsp soy sauce", "1 tbsp toasted sesame oil"])], new Set(), baseline);
  assert.equal(reconcileR12("t", "x", ev).checked, 0);
  // The same bowl over a recipe that does split the row is judged.
  const split = steakRead(2, 0.5);
  split[cookKey("d-steak", 0)].amountRefs = [{ ingredientId: "i-soy", quantity: 2, unit: "tablespoon" }, { ingredientId: "i-sesame", quantity: 0.5, unit: "tablespoon" }];
  const ev2 = splitDishesOf(pepperSteak(), steakRead(2, 0.5), [bowlStep(["4 tbsp soy sauce", "1 tbsp toasted sesame oil"])], new Set(), split);
  assert.equal(reconcileR12("t", "x", ev2).findings.length, 2);
});

test("bowlShares reads a bowl's header lines, the inline form and a destination line", () => {
  const names = new Map([["f-lemon", ["fresh lemon juice"]], ["f-zest", ["lemon zest"]], ["f-garlic", ["garlic"]], ["f-worc", ["Worcestershire sauce"]]]);
  const steps: PrepSession["steps"] = [
    { stepKey: "a", phase: "produce", title: "Zest and juice the lemons", contributesToMealIds: [], instructions: "Zest the lemons first, then juice them for 4 tbsp lemon juice.\nInto the Cod sauce bowl: 2 tbsp fresh lemon juice · 1 tsp lemon zest\nInto the Lemon juice tub: 1 tbsp for the Lemon-Herb Rice" },
    { stepKey: "b", phase: "produce", title: "Mince all garlic", contributesToMealIds: [], instructions: "Mince 3 cloves of garlic.\n2 cloves garlic — into the Meatloaf sauce bowl\n1 clove for Buttered Green Beans — into the Minced garlic tub" },
    { stepKey: "c", phase: "sauces_marinades", title: "Finish the Meatloaf sauce", contributesToMealIds: [], instructions: "Into the Meatloaf sauce bowl (plain breadcrumbs and garlic already in it), add:\n1 tbsp Worcestershire sauce\nWhisk to combine." },
  ];
  const b = bowlShares(steps, names);
  assert.deepEqual(b.get("Cod sauce")?.get("f-lemon"), [{ qty: 2, unit: "tbsp" }]);
  assert.deepEqual(b.get("Cod sauce")?.get("f-zest"), [{ qty: 1, unit: "tsp" }]);
  assert.deepEqual(b.get("Meatloaf sauce")?.get("f-garlic"), [{ qty: 2, unit: "cloves" }]);
  assert.deepEqual(b.get("Meatloaf sauce")?.get("f-worc"), [{ qty: 1, unit: "tbsp" }]);
  assert.equal(b.get("Minced garlic"), undefined); // no amount names garlic on that line
});

// ── R5 ──────────────────────────────────────────────────────────────────────

const soupRead = (text: string, chips?: string[]): Record<string, RecipeStep> => ({
  [cookKey("d-soup", 0)]: { stepIndex: 0, text, estimatedMinutes: 10, phaseType: "prep", ...(chips ? { preppedRefs: chips.map((l) => ({ containerId: l, label: l })) } : {}) },
});

test("R5 passes a subset that stays in its meals and leaves the others' Cook Mode alone", () => {
  const s: PrepSession = { kind: "subset", mealIds: ["meal-tacos"], steps: [goodWeek().steps[2]] };
  const read = soupRead("Slice the yellow onion.");
  const r = reconcileR5("t", { session: s, before: { "meal-soup": read }, served: { "meal-soup": read }, ticked: { "meal-soup": read }, titles: {} });
  assert.deepEqual(r.findings, []);
});

test("R5 reports a third meal's onions in a subset, and its Cook Mode changing when the subset is ticked", () => {
  const s: PrepSession = { kind: "subset", mealIds: ["meal-tacos"], steps: [goodWeek().steps[1]] };
  const read = soupRead("Slice the yellow onion.");
  const r = reconcileR5("t", { session: s, before: { "meal-soup": read }, served: { "meal-soup": read }, ticked: { "meal-soup": soupRead("Grab the prepped onions.", ["Onions"]) }, titles: { "meal-soup": "Onion Soup" } });
  assert.deepEqual(r.findings.map((f) => f.signature), ["R5:step-outside-subset", "R5:other-meal-cook-mode-changed"]);
  assert.match(r.findings[1].detail, /"Slice the yellow onion\." → "Grab the prepped onions\." \[Onions\]/);
});

test("R5 tells the request apart from the ticks", () => {
  const s: PrepSession = { kind: "one-meal", mealIds: ["meal-tacos"], steps: [goodWeek().steps[2]] };
  const r = reconcileR5("t", { session: s, before: { "meal-soup": soupRead("Slice the yellow onion.") }, served: { "meal-soup": soupRead("Slice the onion.") }, ticked: { "meal-soup": soupRead("Slice the onion.") }, titles: {} });
  assert.deepEqual(r.findings.map((f) => f.signature), ["R5:subset-request-changed-other-meal"]);
});

// ── R6 ──────────────────────────────────────────────────────────────────────

test("R6 passes: labelCount = the card's N = the containers filled; cook names a made container", () => {
  const r = reconcileR6("t", goodWeek(), [{ mealTitle: "Chicken Tacos", dishId: "d-tacos", stepIndex: 0, containerId: "c-onion", label: "Onions" }]);
  assert.deepEqual(r.findings, []);
});

test("R6 reports a label count that disagrees, and a cook step naming a container prep never made", () => {
  const w = goodWeek();
  w.steps[0] = { ...w.steps[0], labelCount: 3 };
  const r = reconcileR6("t", w, [{ mealTitle: "Chicken Tacos", dishId: "d-tacos", stepIndex: 1, containerId: "c-lime", label: "Lime juice" }]);
  assert.deepEqual(r.findings.map((f) => f.signature), ["R6:label-count-mismatch:week", "R6:cook-names-unmade-container"]);
});

// ── R7 ──────────────────────────────────────────────────────────────────────

const base: Record<string, RecipeStep> = {
  [cookKey("d-tacos", 0)]: { stepIndex: 0, text: "Dice the yellow onion and slice the chicken thighs.", estimatedMinutes: 10, phaseType: "prep" },
  [cookKey("d-tacos", 1)]: { stepIndex: 1, text: "Cook the chicken with the onion.", estimatedMinutes: 15, phaseType: "cook" },
};
const steps7 = () => goodWeek().steps;
const ev7 = (after: Record<string, RecipeStep>, ticked: string[], prepped = false) => ({
  label: "fixture", meals: [{ meal: tacos(), baseline: base, after }], prepSteps: steps7(), ticked: new Set(ticked), prepped,
});
const noCovers = () => steps7().map((x) => ({ ...x, coversCookSteps: [] }));
const chipped = { ...base, [cookKey("d-tacos", 0)]: { ...base[cookKey("d-tacos", 0)], text: "Grab the prepped onions and chicken.", preppedRefs: [{ containerId: "c-onion", label: "Onions" }, { containerId: "c-chicken", label: "Chicken" }] } };

test("R7 passes: the ticked steps reach Cook Mode as chips, the step nothing ticked is untouched", () => {
  const r = reconcileR7("t", ev7(chipped, ["produce#onion", "proteins#chicken"]));
  assert.deepEqual(r.findings, []);
  assert.ok(r.checked >= 2);
});

test("R7 passes a covered step the client folds into \"Done in prep\" when every covering step is ticked", () => {
  assert.deepEqual(reconcileR7("t", ev7(base, ["produce#onion", "proteins#chicken"])).findings, []);
});

test("R7 reports Cook Mode that still says chop after the cook ticked it", () => {
  const r = reconcileR7("t", { ...ev7(base, ["produce#onion", "proteins#chicken"]), prepSteps: noCovers() });
  assert.deepEqual(r.findings.map((f) => `${f.signature} ${f.step}`), ["R7:cook-still-says-chop produce#onion", "R7:cook-still-says-chop proteins#chicken"]);
  assert.match(r.findings[1].detail, /still reads "Dice the yellow onion and slice the chicken thighs\."/);
});

test("R7 reports partial prep muting what was not ticked: a chip from an unticked step", () => {
  const r = reconcileR7("t", ev7(chipped, ["produce#onion"]));
  assert.deepEqual(r.findings.map((f) => f.signature), ["R7:chip-from-unticked-prep"]);
});

test("R7 reports a reworded step with no ticked prep behind it", () => {
  const after = { ...base, [cookKey("d-tacos", 1)]: { ...base[cookKey("d-tacos", 1)], text: "Cook the prepped chicken." } };
  const r = reconcileR7("t", ev7(after, []));
  assert.deepEqual(r.findings.map((f) => f.signature), ["R7:unticked-muted"]);
});

test("R7 takes the app's fold (CLIENT-6 B): a step whose onion nothing ticked diced shows in full, with the chicken's chip", () => {
  // Only the chicken step covers cook step 0; the onion step (same cook step, no covers) is not ticked.
  const steps = steps7().map((x) => (x.stepKey === "produce#onion" ? { ...x, coversCookSteps: [] } : x));
  const ev = { ...ev7(base, ["proteins#chicken"]), prepSteps: steps };
  assert.deepEqual(appFold(tacos(), base, planFold(steps, ev.ticked)).done, new Set());
  assert.deepEqual([...appFold(tacos(), base, planFold(steps, ev.ticked)).chips.values()], [[{ containerId: "c-chicken", label: "Chicken" }]]);
  assert.deepEqual(reconcileR7("t", ev).findings, []);
});

test("R7 still reports a fold the app makes over an unticked food (one the dish's ingredients do not name)", () => {
  const steps = steps7().map((x) => (x.stepKey === "produce#onion" ? { ...x, coversCookSteps: [] } : x));
  const m = tacos();
  m.dishes[0].ingredients = m.dishes[0].ingredients.filter((i) => i.name !== "yellow onion");
  const r = reconcileR7("t", { ...ev7(base, ["proteins#chicken"]), meals: [{ meal: m, baseline: base, after: base }], prepSteps: steps });
  assert.deepEqual(r.findings.map((f) => f.signature), ["R7:collapsed-over-unticked-food"]);
});

test("R7 reports a \"Yes, I prepped\" read no plan folds (the meal is not in this week's plan) that words a covered step in full", () => {
  const r = reconcileR7("t", ev7(base, ["produce#onion", "proteins#chicken"], true));
  assert.deepEqual(r.findings.map((f) => f.signature), ["R7:prepped-read-not-worded"]);
});

test("R7 passes a \"Yes, I prepped\" read the app folds by this week's structure (CLIENT-6 C: titles only, every step done)", () => {
  const structure = { steps: steps7().map(({ instructions: _i, ...s }) => s) };
  const r = reconcileR7("t", { ...ev7(base, ["produce#onion", "proteins#chicken"], true), fold: answerFold(structure) });
  assert.deepEqual(r.findings, []);
});

test("appFold: BUG-584's own step folds only when the onion's step is ticked too; BUG-583's garlic-only step folds after a yes", () => {
  const m = tacos();
  m.dishes[0].ingredients.push({ name: "garlic cloves", quantity: 2, unit: "each", isOptional: false });
  const read = { [cookKey("d-tacos", 0)]: { stepIndex: 0, text: "Finely dice the yellow onion and mince the 2 garlic cloves.", estimatedMinutes: 5, phaseType: "prep" },
    [cookKey("d-tacos", 1)]: { stepIndex: 1, text: "Mince 2 garlic cloves.", estimatedMinutes: 2, phaseType: "prep" } };
  const covers = [{ mealId: "meal-tacos", dishId: "d-tacos", stepIndex: 0 }, { mealId: "meal-tacos", dishId: "d-tacos", stepIndex: 1 }];
  const garlic = { stepKey: "produce#garlic", title: "Mince the garlic", instructions: "Mince 2 garlic cloves.", containerNames: ["Minced garlic"], containerId: "c-garlic", coversCookSteps: covers };
  const onion = { stepKey: "produce#onion", title: "Dice the yellow onion", instructions: "Finely dice 1 yellow onion.", containerNames: ["Onions"], containerId: "c-onion", coversCookSteps: [covers[0]] };
  const garlicOnly = appFold(m, read, { steps: [garlic, onion], checked: new Set(["produce#garlic"]) });
  assert.deepEqual([...garlicOnly.done], [cookKey("d-tacos", 1)]);
  const both = appFold(m, read, { steps: [garlic, onion], checked: new Set(["produce#garlic", "produce#onion"]) });
  assert.deepEqual([...both.done].sort(), [cookKey("d-tacos", 0), cookKey("d-tacos", 1)]);
  const yes = appFold(m, read, answerFold({ steps: [{ stepKey: garlic.stepKey, title: garlic.title, coversCookSteps: [covers[1]] }] }));
  assert.deepEqual([...yes.done], [cookKey("d-tacos", 1)]);
  assert.deepEqual(appFold(m, read, null).done, new Set());
});

// ── R8 ──────────────────────────────────────────────────────────────────────

const two = (): PlanMeal => ({
  ...tacos(),
  dishes: [
    { ...tacos().dishes[0], steps: [
      { stepIndex: 0, text: "Dice the yellow onion and slice the chicken thighs.", estimatedMinutes: 10, phaseType: "prep" },
      { stepIndex: 1, text: "Roast the chicken and onion at 425°F; add the lime juice.", estimatedMinutes: 30, phaseType: "cook" },
    ] },
    { dishId: "d-rice", title: "Rice", servings: 4, defaultServings: 4, ingredients: [{ name: "long-grain rice", quantity: 1, unit: "cup", isOptional: false }], steps: [
      { stepIndex: 0, text: "Bake the rice at 350°F, covered.", estimatedMinutes: 30, phaseType: "cook" },
    ] },
  ],
});

test("R8 passes a complete, ordered, one-temperature Cook Mode whose card matches", () => {
  const seq = [
    { dishId: "d-tacos", originalStepIndex: 0, sequenceIndex: 0, startOffsetMinutes: -70 },
    { dishId: "d-tacos", originalStepIndex: 1, sequenceIndex: 1, startOffsetMinutes: -60 },
    { dishId: "d-rice", originalStepIndex: 0, sequenceIndex: 2, startOffsetMinutes: -30 },
  ];
  const r = reconcileR8("t", { meal: two(), sequence: seq, sequenceTotalMinutes: 70, cardTotalMinutes: 70 });
  assert.deepEqual(r.findings, []);
});

test("R8 reports an unused ingredient, steps out of order, an oven at two temperatures and a card 10 %+ off", () => {
  const m = two();
  m.dishes[0].ingredients.push({ name: "smoked paprika", quantity: 1, unit: "tsp", isOptional: false });
  const seq = [
    { dishId: "d-tacos", originalStepIndex: 1, sequenceIndex: 0, startOffsetMinutes: -40 },
    { dishId: "d-tacos", originalStepIndex: 0, sequenceIndex: 1, startOffsetMinutes: -35 },
    { dishId: "d-rice", originalStepIndex: 0, sequenceIndex: 2, startOffsetMinutes: -30 },
  ];
  const sigs = reconcileR8("t", { meal: m, sequence: seq, sequenceTotalMinutes: 50, cardTotalMinutes: 40 }).findings.map((f) => f.signature);
  assert.deepEqual(sigs.sort(), ["R8:card-time-off", "R8:ingredient-unused:smoked paprika", "R8:oven-two-temperatures", "R8:steps-out-of-order"]);
});

// ── R9 ──────────────────────────────────────────────────────────────────────

const feast = (rows: FeastEvidence["rows"], over: Partial<FeastEvidence> = {}): FeastEvidence => ({
  label: "Classic", feastDate: "2026-11-26", feastDayName: "Thursday", rows, birdWeightLb: 16, recipeLb: { min: 12, max: 14 }, sessionDay: "Wednesday", ...over,
});
const goodRows = (): FeastEvidence["rows"] => [
  { kind: "thaw", dayName: "Saturday", date: "2026-11-21", daysBefore: 5, dishId: "turkey", dishName: "Roast Turkey", thawDays: 5 },
  { kind: "make", dayName: "Tuesday", date: "2026-11-24", daysBefore: 2, dishId: "pie", dishName: "Pie", keepsDays: 3 },
  { kind: "brine", dayName: "Wednesday", date: "2026-11-25", daysBefore: 1, dishId: "turkey", dishName: "Roast Turkey" },
];

test("R9 passes: dated before the feast, inside the keep window, thaw = ⌈16 ÷ 4⌉ days before the brine", () => {
  assert.deepEqual(reconcileR9("t", feast(goodRows())).findings, []);
});

test("R9 reports a thaw that breaks the weight rule, a make-ahead outside its keep window and a wrong date", () => {
  const rows = goodRows();
  rows[0] = { ...rows[0], daysBefore: 3, date: "2026-11-23", dayName: "Monday" };
  rows[1] = { ...rows[1], daysBefore: 7, date: "2026-11-20", dayName: "Thursday" };
  rows.sort((a, b) => b.daysBefore - a.daysBefore);
  const sigs = reconcileR9("t", feast(rows)).findings.map((f) => f.signature).sort();
  assert.deepEqual(sigs, ["R9:a-week-early:make", "R9:date-mismatch:make", "R9:outside-keep-window", "R9:thaw-weight-rule", "R9:weekday-mismatch:make"]);
});

// ── R10, R11 ────────────────────────────────────────────────────────────────

test("R10 passes one plan_prep_started per ticked plan and one cook_finished per finish; reports a repeat", () => {
  assert.deepEqual(reconcileR10("t", { plans: [{ planId: "p", label: "p", ticksPut: 12, prepStartedRows: 1 }], finishesRecorded: 1, cookFinishedRows: 1 }).findings, []);
  const sigs = reconcileR10("t", { plans: [{ planId: "p", label: "p", ticksPut: 12, prepStartedRows: 2 }], finishesRecorded: 1, cookFinishedRows: 2 }).findings.map((f) => f.signature);
  assert.deepEqual(sigs, ["R10:prep-started-repeated", "R10:cook-finished-count"]);
});

const call = (over: Partial<CallRecord>): CallRecord => ({ household: "t", step: "s", method: "GET", path: "/plans/1e41fc0c-7294-4bd3-a14a-302e44bbcd7c", status: 200, ms: 100, expected: [], ...over });

test("R11 passes 2xx and an expected 4xx; reports a 5xx, an unexpected 4xx, a slow call and a console error", () => {
  assert.deepEqual(reconcileR11("t", [call({}), call({ status: 401, expected: [401] })]).findings, []);
  const sigs = reconcileR11("t", [call({ status: 500 }), call({ status: 404 }), call({ ms: 25_000 })], ["TypeError: x is undefined"]).findings.map((f) => f.signature);
  assert.deepEqual(sigs, ["R11:5xx:GET /plans/:id", "R11:unexpected-4xx:GET /plans/:id 404", "R11:slow:GET /plans/:id", "R11:console-error:TypeError: x is undefined"]);
});

// ── what the first real run taught the matchers ─────────────────────────────

test("names: accents survive, a generic head alone is no food, plant parts fold to the plant", () => {
  assert.equal(normName("Jalapeños"), "jalapeno");
  assert.equal(sameFood("hot sauce", "soy sauce"), false);
  assert.equal(sameFood("soy sauce", "low-sodium soy sauce"), true);
  assert.equal(sameFood("fresh thyme leaves", "fresh thyme"), true);
  assert.equal(sameFood("garlic cloves", "garlic"), true);
  assert.equal(sameFood("egg yolks", "egg"), true);
  assert.equal(sameFood("grated Parmigiano-Reggiano", "parmesan"), true);
});

test("R1 and R4 sum every row a list has for one food (three \"Kosher salt\" rows)", () => {
  const m = tacos();
  m.dishes[0].ingredients.push({ name: "kosher salt", quantity: 0.5, unit: "cup", isOptional: false });
  const rows = [...goodList(), row({ id: "s1", displayName: "Kosher salt", quantity: 1.375, unit: "teaspoon", mealNames: ["Chicken Tacos"], isUniversalStaple: true }), row({ id: "s2", displayName: "Kosher salt", quantity: 0.625, unit: "cup", mealNames: ["Chicken Tacos"], isUniversalStaple: true })];
  assert.deepEqual(reconcileR1("t", grocery(rows, [m, soup()])).findings, []);
  const brine = week([{ stepKey: "seas#brine", phase: "seasonings_dry", title: "Measure the brine", instructions: "Into the brine:\n½ cup kosher salt", contributesToMealIds: ["meal-tacos"] }]);
  assert.deepEqual(reconcileR4("t", brine, [m], rows).findings, []);
});

test("R7 links a clause dropped after a comma to the ticked step that names its food", () => {
  const steps = [{ stepKey: "produce#garlic", phase: "produce", title: "Prep all garlic", instructions: "Mince 4 cloves of garlic.", contributesToMealIds: ["meal-tacos"] }];
  const b = { [cookKey("d-tacos", 0)]: { stepIndex: 0, text: "Finely dice the onion, and mince the 4 garlic cloves; slice the scallions.", estimatedMinutes: 5, phaseType: "prep" } };
  const a = { [cookKey("d-tacos", 0)]: { ...b[cookKey("d-tacos", 0)], text: "Finely dice the onion; slice the scallions." } };
  const r = reconcileR7("t", { label: "partial", meals: [{ meal: tacos(), baseline: b, after: a }], prepSteps: steps, ticked: new Set(["produce#garlic"]), prepped: false });
  assert.deepEqual(r.findings, []);
});

test("R7 judges a ticked step meal by meal: a chip in one meal does not excuse \"dice the onion\" in another", () => {
  const steps = [{ stepKey: "produce#onion", phase: "produce", title: "Dice all yellow onion", instructions: "Dice 4 yellow onions.", contributesToMealIds: ["meal-tacos", "meal-soup"], containerNames: ["Onions"], containerId: "c-onion" }];
  const t0 = { [cookKey("d-tacos", 0)]: { stepIndex: 0, text: "Dice the yellow onion.", estimatedMinutes: 5, phaseType: "prep" } };
  const t1 = { [cookKey("d-tacos", 0)]: { ...t0[cookKey("d-tacos", 0)], text: "Grab the onions you prepped.", preppedRefs: [{ containerId: "c-onion", label: "Onions" }] } };
  const s0 = { [cookKey("d-soup", 0)]: { stepIndex: 0, text: "Slice the yellow onion.", estimatedMinutes: 10, phaseType: "prep" } };
  const r = reconcileR7("t", { label: "after full prep", meals: [{ meal: tacos(), baseline: t0, after: t1 }, { meal: soup(), baseline: s0, after: s0 }], prepSteps: steps, ticked: new Set(["produce#onion"]), prepped: false });
  assert.deepEqual(r.findings.map((f) => `${f.signature} ${f.meal}`), ["R7:cook-still-says-chop Onion Soup"]);
});

test("R1 never asks the list for water in any form", () => {
  const m = tacos();
  m.dishes[0].ingredients.push({ name: "reserved pasta cooking water", quantity: 0.5, unit: "cup", isOptional: false });
  assert.deepEqual(reconcileR1("t", grocery(goodList(), [m, soup()])).findings, []);
});

test("known bugs are known after an edit too (R3 re-runs R1/R2 under its own prefix)", () => {
  const known = [{ id: "BUG-409", signature: "^R2:optional-bought", note: "" }];
  assert.equal(matchKnown({ rule: "R3", signature: "R3:bird-weight:R2:optional-bought:fresh chive", severity: "low", household: "6", detail: "" }, known), "BUG-409");
});

// ── the run's own fences ────────────────────────────────────────────────────

test("the boot proof refuses a child that could send email", () => {
  const ok: BootProof = { event: "qa_night_boot_env", pid: 1, port: "3100", RESEND_API_KEY: "empty", SIGNUP_ALERT_TO: "unset", LIFECYCLE_EMAIL_ENABLED: "false", lifecycleEmailEnabled: false };
  assert.deepEqual(proofProblems(ok), []);
  assert.equal(proofProblems({ ...ok, RESEND_API_KEY: "SET (36 chars)" }).length, 1);
  assert.equal(proofProblems({ ...ok, LIFECYCLE_EMAIL_ENABLED: "true", lifecycleEmailEnabled: true }).length, 2);
  assert.equal(proofProblems({ ...ok, port: "3000" }).length, 1);
});

test("the cost cap starts a household only when spend + its reserve stays inside the budget", () => {
  assert.equal(mayStart(10, 4.5, 15), true);
  assert.equal(mayStart(10.6, 4.5, 15), false);
});

test("known bugs match by signature and, when given, detail", () => {
  const known = [{ id: "BUG-567", signature: "^R9:(a-week-early|outside-keep-window)", note: "" }, { id: "BUG-449", signature: "^R8:oven", detail: "[Ss]tuffing", note: "" }];
  assert.equal(matchKnown({ rule: "R9", signature: "R9:a-week-early:make", severity: "medium", household: "6", detail: "" }, known), "BUG-567");
  assert.equal(matchKnown({ rule: "R8", signature: "R8:oven-two-temperatures", severity: "medium", household: "6", detail: "Rolls at 400°F" }, known), undefined);
});

test("a finding that matches a FIXED bug is regressed: high, in its own bold section, and it moves the exit code", () => {
  const known: KnownBug[] = [{ id: "BUG-584", signature: "^R7:collapsed-over-unticked-food", note: "", status: "fixed", fixedIn: "94007ef5" }, { id: "BUG-409", signature: "^R2:optional-bought", note: "" }];
  const back: Finding = { rule: "R7", signature: "R7:collapsed-over-unticked-food", severity: "medium", household: "2", detail: "after partial prep: …" };
  const open: Finding = { rule: "R2", signature: "R2:optional-bought:chive", severity: "low", household: "6", detail: "" };
  applyKnown(back, known);
  applyKnown(open, known);
  assert.deepEqual([back.known, back.regressed, back.severity], ["BUG-584", true, "high"]);
  assert.deepEqual([open.known, open.regressed], ["BUG-409", undefined]);
  const results = [{ rule: "R7" as const, checked: 1, findings: [back] }, { rule: "R2" as const, checked: 1, findings: [open] }];
  assert.equal(newHigh(results).length, 1);
  const md = renderSummary(results, { date: "d", runTag: "t", households: [], skipped: [], spendUsd: 0, budgetUsd: 1, spendByPrompt: {}, wallMin: 0, accountsCreated: 0, accountsDeleted: 0, accountsLeft: [], bootProof: "", ui: "off", cookSim: "off" });
  assert.match(md, /## Regressed \(1\)\n- \*\*regressed\*\* \*\*BUG-584\*\* · \*\*high\*\* `R7:collapsed-over-unticked-food`/);
  assert.match(md, /cook-sim: off/);
  assert.doesNotMatch(md.split("## Known")[1], /BUG-584/);
  assert.equal(resultLine(newHigh(results)), "RESULT: 1 new high finding(s) (1 regressed) — see summary.md");
  assert.equal(resultLine([]), "RESULT: clean");
});

test("the run's arguments: --cook-sim with or without pnpm's \"--\", the env switch, and anything else refused", () => {
  assert.deepEqual(parseRunArgs(["--cook-sim"], {}), { cookSim: true, cookSimSource: "on (--cook-sim)", unknown: [] });
  assert.deepEqual(parseRunArgs(["--", "--cook-sim"], {}), { cookSim: true, cookSimSource: "on (--cook-sim)", unknown: [] });
  assert.deepEqual(parseRunArgs([], {}), { cookSim: false, cookSimSource: "off", unknown: [] });
  assert.equal(parseRunArgs([], { KIWI_QA_COOK_SIM: "1" }).cookSimSource, "on (KIWI_QA_COOK_SIM=1)");
  assert.equal(parseRunArgs([], { npm_config_cook_sim: "true" }).cookSim, true);
  assert.equal(parseRunArgs(["--cook-sim=off"], { KIWI_QA_COOK_SIM: "1" }).cookSim, false);
  assert.deepEqual(parseRunArgs(["—cook-sim"], {}).unknown, ["—cook-sim"]);
  assert.deepEqual(parseRunArgs(["--cooksim"], {}).unknown, ["--cooksim"]);
});
