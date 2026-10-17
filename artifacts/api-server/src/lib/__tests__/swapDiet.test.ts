// SAFE-1 (Part B) — Swap for Similar honours the user's stored diet: a
// vegetarian user swapping a vegetarian pasta never gets Carbonara or a sausage
// Arrabbiata. The signal is each meal's ingredient names (lib/similar/diet.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { animalKindOf, dietRestrictionsOf, fitsDiets } from "../similar/diet";
import { buildSwapPool } from "../similar/swapPool";

describe("diet — one ingredient line", () => {
  const cases: Array<[string, ReturnType<typeof animalKindOf>]> = [
    ["boneless skinless chicken thighs", "meat"],
    ["guanciale", "meat"],
    ["low-sodium chicken broth", "meat"],
    ["mild italian pork sausage links", "meat"],
    ["all-beef hot dogs", "meat"],
    ["lump crab meat", "fish"],
    ["oyster sauce", "fish"],
    ["worcestershire sauce", "fish"],
    ["fish sauce", "fish"],
    ["beefsteak tomato", null],
    ["oyster mushrooms", null],
    ["hot dog buns", null],
    ["chicken-style vegetable broth", null],
    ["vegetarian italian sausage", null],
    ["collard greens", null],
    ["celery ribs", null],
    ["eggplant", null],
    ["peanut butter", null],
    ["coconut milk", null],
    ["crumbled goat cheese", "animal_product"],
    ["large eggs", "animal_product"],
    ["unsalted butter", "animal_product"],
  ];
  for (const [name, want] of cases) it(`"${name}" → ${want}`, () => assert.equal(animalKindOf(name), want));
});

describe("diet — a meal against the diets", () => {
  const carbonara = ["spaghetti", "guanciale", "large eggs", "pecorino romano", "black pepper"];
  const primavera = ["penne", "zucchini", "cherry tomatoes", "parmesan cheese", "olive oil", "garlic"];
  const shrimp = ["linguine", "large shrimp", "garlic", "unsalted butter", "lemon"];
  const vegan = ["penne", "marinara sauce", "olive oil", "garlic", "basil"];
  it("vegetarian: Carbonara out, primavera in, shrimp out", () => {
    assert.equal(fitsDiets(carbonara, ["vegetarian"]), false);
    assert.equal(fitsDiets(primavera, ["vegetarian"]), true);
    assert.equal(fitsDiets(shrimp, ["vegetarian"]), false);
  });
  it("pescatarian keeps the shrimp; vegan drops the butter and the cheese", () => {
    assert.equal(fitsDiets(shrimp, ["pescatarian"]), true);
    assert.equal(fitsDiets(primavera, ["vegan"]), false);
    assert.equal(fitsDiets(vegan, ["vegan"]), true);
  });
  it("reads the stored eating styles in any case and ignores the non-exclusions", () => {
    assert.deepEqual(dietRestrictionsOf(["Vegetarian", "Keto", "high-protein"]), ["vegetarian"]);
    assert.deepEqual(dietRestrictionsOf([]), []);
    assert.deepEqual(dietRestrictionsOf(undefined), []);
  });
});

// ── buildSwapPool with a stored diet ────────────────────────────────────────

type Row = { id: string; title: string; lines: string[]; subs?: string[] };
const ROWS: Row[] = [
  { id: "src", title: "Eggplant Parmesan with Spaghetti", lines: ["eggplant", "spaghetti", "marinara sauce", "mozzarella"] },
  { id: "carb", title: "Spaghetti Carbonara", lines: ["spaghetti", "guanciale", "large eggs", "pecorino romano"] },
  { id: "arra", title: "Rigatoni Arrabbiata with Italian Sausage", lines: ["rigatoni", "hot italian sausage", "crushed tomatoes"] },
  { id: "ziti", title: "Roasted Vegetable Baked Ziti", lines: ["ziti", "zucchini", "ricotta", "marinara sauce"] },
  // A vegetarian-looking list whose bought-path swap is a meat product.
  { id: "swap", title: "Tomato Basil Penne", lines: ["penne", "tomatoes", "basil"], subs: ["meat sauce (jarred)"] },
];
const card = (r: Row) => ({
  id: r.id, title: r.title, cuisineType: "Italian", tags: [], userId: null, isPublic: true, mealType: "dinner", sourceStoreMealId: null,
  dishLinks: [{ roleLabel: "main", positionIndex: 0, dish: { title: r.title } }],
});
function fakePrisma(eatingStyles: string[]) {
  const reads: string[] = [];
  return {
    reads,
    prisma: {
      meal: {
        findUnique: async ({ where }: { where: { id: string } }) => card(ROWS.find((r) => r.id === where.id)!),
        findMany: async ({ where, select }: { where: { id?: { in: string[] }; userId?: string }; select: Record<string, unknown> }) => {
          if (where.id?.in) {
            reads.push("lines");
            assert.ok("dishLinks" in select);
            return ROWS.filter((r) => where.id!.in.includes(r.id)).map((r) => ({
              id: r.id,
              dishLinks: [{ dish: { substitutions: (r.subs ?? []).map((product) => ({ product, quantity: 1, unit: "jar", replaces: [] })), dishIngredients: r.lines.map((canonicalName) => ({ ingredient: { canonicalName } })) } }],
            }));
          }
          if (where.userId === "u1") return [];
          return ROWS.map(card);
        },
      },
      mealPlanInstance: { findFirst: async () => null },
      userPreferences: {
        findUnique: async ({ select }: { select: Record<string, boolean> }) =>
          select.eatingStyles ? { eatingStyles } : { allergiesAndAvoidances: [] },
      },
    } as never,
  };
}

describe("buildSwapPool — SAFE-1 the stored diet filters the pool", () => {
  it("a vegetarian user's pool holds no meat, and no meat swap product", async () => {
    const { prisma } = fakePrisma(["Vegetarian"]);
    const { pool } = await buildSwapPool(prisma, "u1", { sourceMealId: "src" });
    assert.deepEqual(pool.map((c) => c.row.id).sort(), ["ziti"]);
  });
  it("no stored diet: the pool is unfiltered and no line read happens", async () => {
    const f = fakePrisma([]);
    const { pool } = await buildSwapPool(f.prisma, "u1", { sourceMealId: "src" });
    assert.deepEqual(pool.map((c) => c.row.id).sort(), ["arra", "carb", "swap", "ziti"]);
    assert.deepEqual(f.reads, []);
  });
});
