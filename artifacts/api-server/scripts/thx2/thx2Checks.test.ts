// THX-2G follow-up C — the deterministic checks and the read-only prep proxy.
//
//   node --import tsx --test scripts/thx2/thx2Checks.test.ts
//
// (outside the `pnpm test` glob, like thx2Core.test.ts)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PrismaClient } from "@prisma/client";

import type { WizardExpandEnrichedMealDetails } from "../../src/lib/ai/schemas/wizard";
import { applyChecks, fixUnit, isCookFraction, snapToCookFraction, swapKey, swapProblem } from "./thx2Checks";
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
