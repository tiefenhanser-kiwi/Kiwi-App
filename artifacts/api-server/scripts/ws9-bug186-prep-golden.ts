// WS9 BUG-186 — deterministic Prep Week golden-diff harness.
//
// Guard for the prepCategoryOverride loader seam. Drives the REAL adapter
// (buildPrepCombineInput) and the REAL engine (combinePrep) over every dish
// that references an overridden ingredient, plus an untouched control sample.
//
// It replicates loadPrepWeekInput's per-ingredient field map (the 6 fields at
// prepWeekAggregation.ts) rather than calling the loader, because the loader is
// PLAN-scoped and the blast radius here is DISH-scoped. The one field that
// matters — category — is resolved through the same resolvePrepCategory the
// loader uses, so the seam under test is genuinely exercised.
//
// ZERO writes. No AI. No grocery generation.
//
// Run: node --env-file=.env --import tsx scripts/ws9-bug186-prep-golden.ts <out.json> [--raw]
//   --raw : ignore the override table (reproduces pre-BUG-186 behaviour)

import { writeFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { buildPrepCombineInput } from "../src/lib/prepCombineAdapter";
import { combinePrep } from "../src/lib/prepCombineEngine";
import type {
  PrepLoadedDish,
  PrepLoadedPlan,
} from "../src/lib/prepWeekAggregation";

const OUT = process.argv[2];
const RAW = process.argv.includes("--raw");
if (!OUT) throw new Error("usage: ws9-bug186-prep-golden.ts <out.json> [--raw]");

// Resolved lazily so this harness runs against the pre-change tree too.
let resolvePrepCategory: (name: string, category: string) => string = (
  _n,
  c,
) => c;
if (!RAW) {
  const mod = await import("../src/lib/prepCategoryOverride");
  resolvePrepCategory = mod.resolvePrepCategory;
}

// The 22 override-table canonical names (BUG-186 ruling set).
const OVERRIDDEN = [
  "parmigiano-reggiano", "pecorino romano", "queso fresco", "paneer",
  "parmigiano-reggiano rind", "shaved parmigiano-reggiano",
  "grated pecorino romano", "parmigiano reggiano",
  "finely grated parmigiano-reggiano", "fontina",
  "freshly grated parmigiano-reggiano", "gorgonzola dolce",
  "parmigiano-reggiano, finely grated",
  "large eggs", "hard-boiled eggs",
  "extra-firm tofu", "firm tofu", "silken tofu",
  "wide egg noodles", "fresh chow mein egg noodles",
  "fresh lo mein egg noodles", "egg noodles",
];

const prisma = new PrismaClient();

const targetIds = (
  await prisma.ingredient.findMany({
    where: { canonicalName: { in: OVERRIDDEN } },
    select: { id: true },
  })
).map((r) => r.id);

// Affected: dishes with at least one overridden ingredient.
const affected = await prisma.dish.findMany({
  where: { dishIngredients: { some: { ingredientId: { in: targetIds } } } },
  select: { id: true },
  orderBy: { id: "asc" },
});

// Control: a deterministic sample of dishes with NONE of them.
const control = await prisma.dish.findMany({
  where: { dishIngredients: { none: { ingredientId: { in: targetIds } } } },
  select: { id: true },
  orderBy: { id: "asc" },
  take: 150,
});

const dishIds = [...affected.map((d) => d.id), ...control.map((d) => d.id)];
const controlSet = new Set(control.map((d) => d.id));

const dishes = await prisma.dish.findMany({
  where: { id: { in: dishIds } },
  select: {
    id: true,
    title: true,
    servingsDefault: true,
    authoredServingsDefault: true,
    dishIngredients: {
      select: {
        quantity: true,
        unit: true,
        preparationNote: true,
        ingredient: {
          select: { id: true, displayName: true, category: true },
        },
      },
    },
  },
  orderBy: { id: "asc" },
});

const out: Record<string, unknown> = {};
for (const dish of dishes) {
  // Mirrors loadPrepWeekInput's map, with category through the seam.
  const loadedDish: PrepLoadedDish = {
    dishId: dish.id,
    dishName: dish.title,
    dishRole: "main",
    baseServings: dish.servingsDefault,
    authoredBaseServings: dish.authoredServingsDefault,
    ingredients: dish.dishIngredients.map((di) => ({
      ingredientId: di.ingredient.id,
      ingredientName: di.ingredient.displayName,
      category: resolvePrepCategory(
        di.ingredient.displayName,
        di.ingredient.category,
      ),
      quantity: di.quantity,
      unit: di.unit,
      preparationNote: di.preparationNote ?? null,
    })),
    stepTexts: [],
  };
  if (loadedDish.ingredients.length === 0) continue;

  const plan: PrepLoadedPlan = {
    planId: `golden-${dish.id}`,
    planName: "golden",
    meals: [
      {
        mealId: `m-${dish.id}`,
        mealName: dish.title,
        cuisine: null,
        servingsOverride: null,
        dishes: [loadedDish],
      },
    ],
  };

  out[dish.id] = {
    control: controlSet.has(dish.id),
    result: combinePrep(buildPrepCombineInput(plan)),
  };
}

writeFileSync(OUT, JSON.stringify(out, null, 1));
console.error(
  `dishes=${Object.keys(out).length} affected=${affected.length} control=${control.length} raw=${RAW}`,
);
await prisma.$disconnect();
