// BUG-040 — backfill empty count-units on curated catalog meals.
//
// The 12 curated seed meals carry count-only produce ingredients (limes, onions,
// avocado, bay leaves, tomatoes, cucumber, corn tortillas, etc.) seeded with
// unit="" — which fails WizardExpandDishIngredientSchema (unit.min(1)) when the
// meal is composed into a wizard draft, 422'ing at activation (BUG-040 Defect 1).
//
// The catalog-wide convention for count-only items is unambiguously "each" (599
// uses; every count-only produce that HAS a unit uses it — verified Phase 0).
// This one-shot sets unit="each" for every empty/null-unit DishIngredient that
// belongs to a curated public meal. It NEVER touches measured units (oz/cup/tbsp
// /g) — those are non-empty, so the filter excludes them by construction.
//
// Usage (from repo root; §10 — scripts live under artifacts/api-server/scripts/):
//   pnpm --filter @workspace/api-server exec tsx scripts/backfill-curated-count-units.ts            # dry-run (default)
//   pnpm --filter @workspace/api-server exec tsx scripts/backfill-curated-count-units.ts --apply    # commit

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const COUNT_UNIT = "each";

async function main() {
  // Empty/null-unit DishIngredients whose dish is linked to a curated public
  // meal. (A dish can link to multiple meals; scope on the curated-public link.)
  const rows = await prisma.dishIngredient.findMany({
    where: {
      // DishIngredient.unit is a non-nullable String; the offenders are empty
      // strings (Phase 0: 20 rows, all ""). No nulls to consider.
      unit: "",
      dish: {
        mealLinks: {
          some: { meal: { sourceType: "curated", isPublic: true } },
        },
      },
    },
    select: {
      id: true,
      unit: true,
      quantity: true,
      ingredient: { select: { displayName: true } },
      dish: {
        select: {
          title: true,
          mealLinks: { select: { meal: { select: { title: true, sourceType: true } } } },
        },
      },
    },
  });

  console.log(`\n=== BUG-040 curated count-unit backfill (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
  console.log(`Rows to set unit="${COUNT_UNIT}": ${rows.length}\n`);
  for (const r of rows) {
    const meal = r.dish.mealLinks.map((l) => l.meal.title).join(" / ");
    console.log(
      `  [${meal}] ${r.dish.title} :: ${r.ingredient.displayName}  qty=${r.quantity} unit=${JSON.stringify(r.unit)} → "${COUNT_UNIT}"`,
    );
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN — no writes. Re-run with --apply to commit ${rows.length} update(s).\n`);
    return;
  }

  let updated = 0;
  for (const r of rows) {
    await prisma.dishIngredient.update({
      where: { id: r.id },
      data: { unit: COUNT_UNIT },
    });
    updated++;
  }
  console.log(`\nAPPLIED — updated ${updated} DishIngredient row(s) to unit="${COUNT_UNIT}".\n`);

  // Post-check: any curated-public empty units left?
  const remaining = await prisma.dishIngredient.count({
    where: {
      unit: "",
      dish: { mealLinks: { some: { meal: { sourceType: "curated", isPublic: true } } } },
    },
  });
  console.log(`Post-check: curated-public empty/null units remaining = ${remaining}\n`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error("backfill error:", e);
    return prisma.$disconnect().then(() => process.exit(1));
  });
