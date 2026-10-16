// THX-2G follow-up C — the deterministic checks and the read-only prep proxy.
//
//   node --import tsx --test scripts/thx2/thx2Checks.test.ts
//
// (outside the `pnpm test` glob, like thx2Core.test.ts)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PrismaClient } from "@prisma/client";

import type { WizardExpandEnrichedMealDetails } from "../../src/lib/ai/schemas/wizard";
import { applyChecks, capMakeAheadMinutes, extendReplaces, fixUnit, isCookFraction, MAKE_AHEAD_MINUTES_CAP, snapToCookFraction, swapKey, swapProblem } from "./thx2Checks";
import { nameKey } from "./thx2Core";
import { readOnlyPrisma } from "./thx2Prep";

const macros = { caloriesPerServing: 100, proteinGPerServing: 1, carbsGPerServing: 1, fatGPerServing: 1 };

describe("swaps that are not shortcuts are dropped", () => {
  it("a product replaced by itself, after normalising store-bought / refrigerated / carton / low-sodium / plurals", () => {
    assert.equal(swapKey("Store-bought refrigerated pie crusts"), swapKey("refrigerated pie crust (contains wheat)"));
    assert.ok(swapProblem({ product: "store-bought refrigerated pie crust", replaces: ["refrigerated pie crust (contains wheat)"] }));
    assert.ok(swapProblem({ product: "chicken broth carton", replaces: ["low-sodium chicken broth"] }));
  });
  it("bought broth or stock for bought broth or stock is dropped", () => {
    assert.ok(swapProblem({ product: "chicken broth carton", replaces: ["low-sodium chicken stock"] }));
    assert.ok(swapProblem({ product: "rotisserie chicken broth carton", replaces: ["vegetable broth"] }));
  });
  it("store-bought stock for stock the recipe MAKES is kept (Hans)", () => {
    assert.equal(swapProblem({ product: "store-bought turkey stock", replaces: ["turkey neck and giblets", "yellow onion", "celery stalks"] }), null);
    assert.equal(swapProblem({ product: "turkey stock", replaces: ["homemade turkey stock"] }), null);
  });
  it("a real shortcut is kept", () => {
    assert.equal(swapProblem({ product: "taco seasoning", replaces: ["cumin", "chili powder"] }), null);
    assert.equal(swapProblem({ product: "jarred cranberry sauce", replaces: ["fresh cranberries", "granulated sugar"] }), null);
  });
});

describe("units", () => {
  it("garlic counted each becomes clove; a head or powder does not", () => {
    const g = { name: "garlic", quantity: 4, unit: "each" };
    assert.ok(fixUnit(g));
    assert.equal(g.unit, "clove");
    const named = { name: "garlic cloves", quantity: 4, unit: "each" };
    fixUnit(named);
    assert.deepEqual([named.quantity, named.unit, named.name], [4, "clove", "garlic"], "no '4 clove garlic cloves'");
    const head = { name: "garlic head", quantity: 1, unit: "each" };
    assert.equal(fixUnit(head), null);
    const powder = { name: "garlic powder", quantity: 1, unit: "teaspoon" };
    assert.equal(fixUnit(powder), null);
  });
  it("a teaspoon amount under ⅛ becomes 1 pinch; ⅛ itself stays", () => {
    const c = { name: "ground cloves", quantity: 0.06, unit: "teaspoon" };
    fixUnit(c);
    assert.deepEqual([c.quantity, c.unit], [1, "pinch"]);
    const eighth = { name: "allspice", quantity: 0.125, unit: "teaspoon" };
    assert.equal(fixUnit(eighth), null);
  });
  it("a spoon or cup amount that is no cook's fraction is snapped; weights are left alone", () => {
    const t = { name: "flour", quantity: 0.33, unit: "cup" };
    fixUnit(t);
    assert.equal(t.quantity, 1 / 3);
    const lb = { name: "potatoes", quantity: 2.4, unit: "pound" };
    assert.equal(fixUnit(lb), null);
    assert.equal(snapToCookFraction(1.7), 1 + 2 / 3);
    assert.ok(isCookFraction(1.75) && !isCookFraction(0.06));
  });
});

describe("applyChecks on a generated meal", () => {
  it("drops the bad swaps, keeps the good, fixes units, and reports each", () => {
    const meal: WizardExpandEnrichedMealDetails = {
      title: "Pot Pie", cuisineType: "American", estimatedTimeMinutes: 60, difficulty: "easy", servings: 4,
      dishes: [{
        title: "Leftover Turkey Pot Pie", role: "main", positionIndex: 0, macros,
        ingredients: [
          { name: "refrigerated pie crust", quantity: 1, unit: "each" },
          { name: "garlic", quantity: 3, unit: "each" },
          { name: "ground cloves", quantity: 0.06, unit: "teaspoon" },
          { name: "low-sodium chicken broth", quantity: 2, unit: "cup" },
        ],
        substitutions: [
          { product: "store-bought refrigerated pie crust", quantity: 1, unit: "box", replaces: ["refrigerated pie crust"] },
          { product: "chicken broth carton", quantity: 1, unit: "carton", replaces: ["low-sodium chicken broth"] },
        ],
      }],
    };
    const notes = applyChecks(meal);
    assert.equal(notes.filter((n) => n.kind === "swap_dropped").length, 2);
    assert.equal(notes.filter((n) => n.kind === "unit_fixed").length, 2);
    assert.equal(meal.dishes[0].substitutions, undefined, "no swaps left → field cleared");
    assert.equal(meal.dishes[0].ingredients[1].unit, "clove");
    assert.equal(meal.dishes[0].ingredients[2].unit, "pinch");
  });
});

describe("follow-up F — after finalize", () => {
  const stockMeal = (): WizardExpandEnrichedMealDetails => ({
    title: "Feast", cuisineType: "American", estimatedTimeMinutes: 60, difficulty: "medium", servings: 10,
    dishes: [{
      title: "Pan Gravy", role: "sauce", positionIndex: 0, macros,
      ingredients: [
        { name: "turkey neck", quantity: 1, unit: "each" },
        { name: "carrots", quantity: 1, unit: "each" },
        { name: "bay leaves", quantity: 2, unit: "each" },
        { name: "turkey drippings", quantity: 0.5, unit: "cup" },
        { name: "Kosher salt", quantity: 1, unit: "teaspoon" },
      ],
      substitutions: [{ product: "store-bought turkey stock", quantity: 48, unit: "ounce", replaces: ["turkey neck"] }],
    }],
  });
  const stockSteps = () => ({
    dishSteps: [{
      mealIndex: 0, dishIndex: 0,
      components: [{ key: "stock", label: "Stock", order: 0 }],
      steps: [
        { text: "Make ahead (Tuesday): Put the turkey neck, 1 carrot and 2 bay leaves in a pot with 8 cups water.", phaseType: "prep" as const, estimatedMinutes: 8, isTimingSensitive: false, componentKey: "stock", pathKey: "scratch" as const },
        { text: "Make ahead (Tuesday): Simmer 2 hours, strain and chill.", phaseType: "cook" as const, estimatedMinutes: 120, isTimingSensitive: false, componentKey: "stock", pathKey: "scratch" as const },
        { text: "Make ahead (Tuesday): Chill 48 oz store-bought stock; do not add salt.", phaseType: "prep" as const, estimatedMinutes: 2, isTimingSensitive: false, componentKey: "stock", pathKey: "bought" as const },
        { text: "On Thursday: Whisk the drippings into the stock and season with the salt.", phaseType: "cook" as const, estimatedMinutes: 8, isTimingSensitive: true },
      ],
    }],
  });
  it("a make-ahead step that is not hands-on is capped at 15 minutes; prep/assemble and Thursday steps keep theirs", () => {
    const fin = stockSteps();
    const notes = capMakeAheadMinutes(stockMeal(), fin);
    assert.deepEqual(fin.dishSteps[0].steps.map((s) => s.estimatedMinutes), [8, MAKE_AHEAD_MINUTES_CAP, 2, 8]);
    assert.equal(notes.length, 1);
    assert.ok(fin.dishSteps[0].steps[1].text.includes("Simmer 2 hours"), "the long duration stays in the text as the note");
  });
  it("the cap covers the whole make-ahead RUN (unprefixed steps up to 'On Thursday:'), not just prefixed steps", () => {
    const fin = {
      dishSteps: [{
        mealIndex: 0, dishIndex: 0,
        steps: [
          { text: "Make ahead (Wednesday): Preheat the oven to 425°F.", phaseType: "preheat" as const, estimatedMinutes: 15, isTimingSensitive: false },
          { text: "Press the crusts into two 9-inch pie dishes.", phaseType: "prep" as const, estimatedMinutes: 6, isTimingSensitive: false },
          { text: "Bake at 375°F for 50–55 minutes; cool completely.", phaseType: "cook" as const, estimatedMinutes: 55, isTimingSensitive: false },
          { text: "On Thursday: Warm the pies 10 minutes at 300°F.", phaseType: "cook" as const, estimatedMinutes: 20, isTimingSensitive: false },
          { text: "Slice and serve.", phaseType: "cook" as const, estimatedMinutes: 25, isTimingSensitive: false },
        ],
      }],
    };
    capMakeAheadMinutes(stockMeal(), fin);
    assert.deepEqual(fin.dishSteps[0].steps.map((s) => s.estimatedMinutes), [15, 6, MAKE_AHEAD_MINUTES_CAP, 20, 25], "the in-run bake is capped; Thursday steps are not");
  });
  it("a swap whose replaces already names the ingredient in another spelling ('carrot' for 'carrots') gains nothing", () => {
    const meal = stockMeal();
    meal.dishes[0].substitutions![0].replaces = ["turkey neck", "carrot", "bay leaf"];
    const notes = extendReplaces(meal, stockSteps());
    assert.deepEqual(notes, []);
    assert.equal(nameKey("bay leaves"), nameKey("bay leaf"));
  });
  it("ingredients used only in the scratch component join that swap's replaces; base and bought uses do not", () => {
    const meal = stockMeal();
    const notes = extendReplaces(meal, stockSteps());
    assert.deepEqual(meal.dishes[0].substitutions![0].replaces, ["turkey neck", "carrots", "bay leaves"]);
    assert.deepEqual(notes.map((n) => n.kind), ["replaces_extended", "replaces_extended"]);
    assert.ok(!meal.dishes[0].substitutions![0].replaces.includes("Kosher salt"), "salt is used on Thursday (base), and the bought step's 'do not add salt' is no use");
    assert.ok(!meal.dishes[0].substitutions![0].replaces.includes("turkey drippings"), "a base ingredient stays bought");
  });
  it("a component with no mappable swap is reported, not guessed", () => {
    const meal = stockMeal();
    meal.dishes[0].substitutions!.push({ product: "second swap", quantity: 1, unit: "each", replaces: ["Kosher salt"] });
    const fin = stockSteps();
    fin.dishSteps[0].components = [{ key: "other", label: "Other", order: 0 }];
    const notes = extendReplaces(meal, fin);
    assert.ok(notes.every((n) => n.kind === "replaces_unmapped") && notes.length === 2);
  });
});

describe("the prep proxy writes nothing", () => {
  const fake = {
    meal: { findMany: async () => ["read"], create: async () => "WROTE" },
    ingredientRelation: { findMany: async () => [] },
    $queryRaw: async () => [],
    $transaction: async () => "WROTE",
    $executeRaw: async () => "WROTE",
  } as unknown as PrismaClient;
  const plan = { id: "p" };
  const ro = readOnlyPrisma(fake, plan);
  it("serves the synthetic plan and passes reads through", async () => {
    assert.equal(await ro.mealPlanInstance.findUnique({ where: { id: "p" } }), plan);
    assert.deepEqual(await ro.meal.findMany(), ["read"]);
  });
  it("throws on every write path", () => {
    assert.throws(() => (ro.meal as unknown as { create: () => unknown }).create());
    assert.throws(() => (ro as unknown as { $transaction: () => unknown }).$transaction());
    assert.throws(() => (ro as unknown as { $executeRaw: () => unknown }).$executeRaw());
  });
});
