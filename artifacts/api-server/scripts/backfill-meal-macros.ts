// WS7-6 Fix-Block 3 — Meal.*PerServing backfill for existing rows.
//
// Bug 3: Meal.*PerServing was 0 on every meal in the DB because no write
// path summed per-dish macros up to the meal row. Block 3 fixes the write
// paths going forward; this script backfills the existing rows.
//
// Formula (Hans's ruling — shared with the live helper):
//   Meal.{cal,protein,carbs,fat}PerServing = Σ dish.*PerServing
// across the meal's linked dishes. Dish serving counts do NOT enter.
//
// Honesty: this script sums what's there. Many existing dishes have
// *PerServing = 0 today; meals whose dishes are all 0 will stay 0 after
// backfill — that's the honest aggregation, not a backfill failure. Dish
// macro ESTIMATION (USDA/AI) is a separate concern (out of scope here).
//
// Default mode is --dry-run: prints the per-meal proposed change and
// summary stats WITHOUT writing. Pass --commit to actually update the
// Meal rows. Idempotent (recompute-and-set, not increment) so re-running
// after --commit is safe.
//
// Run:
//   pnpm --filter @workspace/api-server exec tsx scripts/backfill-meal-macros.ts
//   pnpm --filter @workspace/api-server exec tsx scripts/backfill-meal-macros.ts --commit

import { PrismaClient } from "@prisma/client";

import { aggregateMealMacrosFromDishes } from "../src/lib/mealMacros.ts";

interface MealRow {
  id: string;
  title: string;
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  dishLinks: Array<{
    dish: {
      caloriesPerServing: number;
      proteinGPerServing: number;
      carbsGPerServing: number;
      fatGPerServing: number;
    };
  }>;
}

function eqMacros(
  a: {
    caloriesPerServing: number;
    proteinGPerServing: number;
    carbsGPerServing: number;
    fatGPerServing: number;
  },
  b: {
    caloriesPerServing: number;
    proteinGPerServing: number;
    carbsGPerServing: number;
    fatGPerServing: number;
  },
): boolean {
  // Float-eq with a tiny epsilon for the 0.1 + 0.2 ≠ 0.3 cases.
  const eps = 1e-9;
  return (
    Math.abs(a.caloriesPerServing - b.caloriesPerServing) < eps &&
    Math.abs(a.proteinGPerServing - b.proteinGPerServing) < eps &&
    Math.abs(a.carbsGPerServing - b.carbsGPerServing) < eps &&
    Math.abs(a.fatGPerServing - b.fatGPerServing) < eps
  );
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  const mode = commit ? "COMMIT" : "DRY-RUN";

  const prisma = new PrismaClient();
  try {
    console.log(`[backfill-meal-macros] mode=${mode}`);
    console.log("[backfill-meal-macros] loading non-archived meals + dish macros...");

    const meals: MealRow[] = await prisma.meal.findMany({
      where: { isArchived: false },
      select: {
        id: true,
        title: true,
        caloriesPerServing: true,
        proteinGPerServing: true,
        carbsGPerServing: true,
        fatGPerServing: true,
        dishLinks: {
          select: {
            dish: {
              select: {
                caloriesPerServing: true,
                proteinGPerServing: true,
                carbsGPerServing: true,
                fatGPerServing: true,
              },
            },
          },
        },
      },
    });

    const total = meals.length;
    let wouldChange = 0;
    let nonZeroAfter = 0;
    let stayZeroAfter = 0;
    let alreadyCorrect = 0;
    const changes: Array<{
      id: string;
      title: string;
      before: {
        caloriesPerServing: number;
        proteinGPerServing: number;
        carbsGPerServing: number;
        fatGPerServing: number;
      };
      after: {
        caloriesPerServing: number;
        proteinGPerServing: number;
        carbsGPerServing: number;
        fatGPerServing: number;
      };
    }> = [];

    for (const m of meals) {
      const sum = aggregateMealMacrosFromDishes(m.dishLinks.map((l) => l.dish));
      const before = {
        caloriesPerServing: m.caloriesPerServing,
        proteinGPerServing: m.proteinGPerServing,
        carbsGPerServing: m.carbsGPerServing,
        fatGPerServing: m.fatGPerServing,
      };
      if (sum.caloriesPerServing > 0) nonZeroAfter++;
      else stayZeroAfter++;
      if (eqMacros(before, sum)) {
        alreadyCorrect++;
        continue;
      }
      wouldChange++;
      changes.push({ id: m.id, title: m.title, before, after: sum });
    }

    console.log(`\n[backfill-meal-macros] summary:`);
    console.log(`  total meals (non-archived):     ${total}`);
    console.log(`  would change:                   ${wouldChange}`);
    console.log(`  already correct (no-op):        ${alreadyCorrect}`);
    console.log(`  non-zero macros after backfill: ${nonZeroAfter}`);
    console.log(`  staying at 0 (dishes all 0):    ${stayZeroAfter}`);
    console.log(
      `\n  honest-aggregation note: a meal staying 0 means its linked dishes`,
    );
    console.log(
      `  have *PerServing = 0 — Dish macro estimation is a separate concern`,
    );
    console.log(`  (USDA/AI), NOT a backfill failure.`);

    if (changes.length > 0) {
      console.log(`\n[backfill-meal-macros] proposed changes (up to 20 shown):`);
      for (const c of changes.slice(0, 20)) {
        console.log(
          `  ${c.id}  "${c.title}"`,
        );
        console.log(
          `    cal: ${c.before.caloriesPerServing.toFixed(1)} → ${c.after.caloriesPerServing.toFixed(1)}` +
            `  prot: ${c.before.proteinGPerServing.toFixed(1)} → ${c.after.proteinGPerServing.toFixed(1)}` +
            `  carb: ${c.before.carbsGPerServing.toFixed(1)} → ${c.after.carbsGPerServing.toFixed(1)}` +
            `  fat: ${c.before.fatGPerServing.toFixed(1)} → ${c.after.fatGPerServing.toFixed(1)}`,
        );
      }
      if (changes.length > 20) {
        console.log(`  ... and ${changes.length - 20} more`);
      }
    }

    if (!commit) {
      console.log(
        `\n[backfill-meal-macros] DRY-RUN — no writes. Re-run with --commit to apply.`,
      );
      return;
    }

    console.log(`\n[backfill-meal-macros] applying ${changes.length} updates...`);
    let written = 0;
    for (const c of changes) {
      await prisma.meal.update({
        where: { id: c.id },
        data: c.after,
      });
      written++;
    }
    console.log(`[backfill-meal-macros] done — ${written} Meal rows updated.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[backfill-meal-macros] FAILED:", err);
  process.exit(1);
});
