// WS7-8b USDA Integration — PHASE 0 READ-ONLY probe.
//
// SELECT-ONLY. No INSERT/UPDATE/DELETE, no schema changes. Prints catalog
// fill-state facts to ground the USDA integration design (PRD §11.8/§11.9).
//
// Run (PowerShell, from artifacts/api-server):
//   node --env-file=.env --import tsx scripts/ws7-8b-usda-phase0-probe.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // ── 1. Ingredient catalog: nutrition + purchase fill state ──────────────
  const totalIngredients = await prisma.ingredient.count();
  const nutritionNonNull = await prisma.ingredient.count({
    where: { nutritionRefPerUnit: { not: null } },
  });
  const subcategoryNonNull = await prisma.ingredient.count({
    where: { subcategory: { not: null } },
  });
  const purchaseUnitNonNull = await prisma.ingredient.count({
    where: { purchaseUnit: { not: null } },
  });
  const aliasesNonEmpty = await prisma.ingredient.count({
    where: { NOT: { aliases: { isEmpty: true } } },
  });

  console.log("── 1. Ingredient catalog fill state ──");
  console.log(`  total Ingredient rows:            ${totalIngredients}`);
  console.log(`  nutritionRefPerUnit non-null:     ${nutritionNonNull}`);
  console.log(`  nutritionRefPerUnit null:         ${totalIngredients - nutritionNonNull}`);
  console.log(`  subcategory non-null:             ${subcategoryNonNull}`);
  console.log(`  purchaseUnit non-null:            ${purchaseUnitNonNull}`);
  console.log(`  aliases non-empty:                ${aliasesNonEmpty}`);

  // ── 2. defaultUnit distribution ─────────────────────────────────────────
  const unitGroups = await prisma.ingredient.groupBy({
    by: ["defaultUnit"],
    _count: { _all: true },
  });
  unitGroups.sort((a, b) => b._count._all - a._count._all);
  console.log("\n── 2. defaultUnit distribution ──");
  console.log(`  distinct defaultUnit values:      ${unitGroups.length}`);
  for (const g of unitGroups) {
    console.log(`    ${String(g._count._all).padStart(4)}  "${g.defaultUnit}"`);
  }

  // ── 3. category distribution ────────────────────────────────────────────
  const catGroups = await prisma.ingredient.groupBy({
    by: ["category"],
    _count: { _all: true },
  });
  catGroups.sort((a, b) => b._count._all - a._count._all);
  console.log("\n── 3. category distribution ──");
  for (const g of catGroups) {
    console.log(`    ${String(g._count._all).padStart(4)}  ${g.category}`);
  }

  // ── 4. Dish / Meal macro fill state (per-serving all-zero) ──────────────
  const totalDishes = await prisma.dish.count();
  const dishesAllZero = await prisma.dish.count({
    where: {
      caloriesPerServing: 0,
      proteinGPerServing: 0,
      carbsGPerServing: 0,
      fatGPerServing: 0,
    },
  });
  const totalMeals = await prisma.meal.count();
  const mealsAllZero = await prisma.meal.count({
    where: {
      caloriesPerServing: 0,
      proteinGPerServing: 0,
      carbsGPerServing: 0,
      fatGPerServing: 0,
    },
  });
  console.log("\n── 4. Dish / Meal macro fill state ──");
  console.log(`  total Dish rows:                  ${totalDishes}`);
  console.log(`  Dish with all-zero per-serving:   ${dishesAllZero}`);
  console.log(`  total Meal rows:                  ${totalMeals}`);
  console.log(`  Meal with all-zero per-serving:   ${mealsAllZero}`);

  // ── 5. DishIngredient unit distribution (as-used units) ─────────────────
  const diUnitGroups = await prisma.dishIngredient.groupBy({
    by: ["unit"],
    _count: { _all: true },
  });
  diUnitGroups.sort((a, b) => b._count._all - a._count._all);
  console.log("\n── 5. DishIngredient.unit distribution (as-used) ──");
  console.log(`  distinct units:                   ${diUnitGroups.length}`);
  for (const g of diUnitGroups) {
    console.log(`    ${String(g._count._all).padStart(4)}  "${g.unit}"`);
  }
}

main()
  .catch((err) => {
    console.error("[usda-phase0-probe] FAILED:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
