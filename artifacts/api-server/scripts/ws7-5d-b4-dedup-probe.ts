// WS7-5d Block 4 Phase 1 — DB-tuple probe for the dedup diagnosis.
//
// Reads the most recent activated wizard plan and dumps three views:
//   (1) the final grocery list as persisted
//   (2) every source DishIngredient (pre-consolidator)
//   (3) the consolidator output (what the AI/deterministic partition saw)
//   (4) the user's recurringGroceryItems + pantryStaples
//
// Lets us attribute every row in the final list to either a source
// dish-ingredient, a recurring entry, or a Sonnet hallucination.
//
// Run: pnpm --filter @workspace/api-server exec tsx scripts/ws7-5d-b4-dedup-probe.ts
//
// Requires DATABASE_URL. Read-only.

import { PrismaClient } from "@prisma/client";
import { consolidatePlanIngredients } from "../src/lib/groceryList";

const prisma = new PrismaClient();

async function main() {
  const recentList = await prisma.groceryList.findFirst({
    where: {
      sourceType: "plan",
      mealPlanInstanceId: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      createdAt: true,
      mealPlanInstanceId: true,
      userId: true,
      items: {
        select: {
          displayName: true,
          quantity: true,
          unit: true,
          storeSection: true,
          ingredientId: true,
          isUniversalStaple: true,
          isRecurringItem: true,
          isUserPantryStaple: true,
          wasAiInferred: true,
        },
        orderBy: [{ storeSection: "asc" }, { displayName: "asc" }],
      },
    },
  });

  if (!recentList || !recentList.mealPlanInstanceId) {
    console.log("No plan-sourced grocery list found.");
    return;
  }

  console.log("─".repeat(80));
  console.log(`List ${recentList.id}`);
  console.log(`  title:  ${recentList.title}`);
  console.log(`  user:   ${recentList.userId}`);
  console.log(`  plan:   ${recentList.mealPlanInstanceId}`);
  console.log(`  created ${recentList.createdAt.toISOString()}`);
  console.log("─".repeat(80));

  console.log(`\n(1) FINAL grocery list items — ${recentList.items.length} rows`);
  for (const it of recentList.items) {
    const flags = [
      it.isUniversalStaple ? "univ" : null,
      it.isRecurringItem ? "rec" : null,
      it.isUserPantryStaple ? "pantry" : null,
      it.wasAiInferred ? "ai" : null,
      it.ingredientId ? null : "noIngId",
    ]
      .filter(Boolean)
      .join(",");
    console.log(
      `    [${it.storeSection.padEnd(14)}] qty=${String(it.quantity).padEnd(5)} unit=${it.unit.padEnd(10)} ${flags.padEnd(20)} | ${it.displayName}`,
    );
  }

  console.log("\n" + "─".repeat(80));
  console.log("(2) SOURCE DishIngredient rows (pre-consolidator)");
  console.log("─".repeat(80));

  const plan = await prisma.mealPlanInstance.findUnique({
    where: { id: recentList.mealPlanInstanceId },
    select: {
      id: true,
      titleOverride: true,
      template: { select: { title: true } },
      items: {
        orderBy: { positionIndex: "asc" },
        select: {
          id: true,
          mealId: true,
          servingsOverride: true,
          meal: {
            select: {
              title: true,
              dishLinks: {
                orderBy: { positionIndex: "asc" },
                select: {
                  dish: {
                    select: {
                      title: true,
                      servingsDefault: true,
                      dishIngredients: {
                        orderBy: { positionIndex: "asc" },
                        select: {
                          quantity: true,
                          unit: true,
                          preparationNote: true,
                          ingredient: {
                            select: {
                              canonicalName: true,
                              displayName: true,
                              category: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!plan) {
    console.log("Plan not found.");
    return;
  }
  console.log(`Plan: ${plan.titleOverride ?? plan.template?.title ?? "(none)"}`);
  console.log(`Plan items (meal scheduling): ${plan.items.length}`);

  type Row = {
    canonical: string;
    unit: string;
    quantity: number;
    prep: string | null;
    dish: string;
    meal: string;
    planItemId: string;
    mealId: string;
    servingsOverride: number | null;
    servingsDefault: number;
  };
  const allRows: Row[] = [];
  for (const it of plan.items) {
    const mealTitle = it.meal.title;
    for (const link of it.meal.dishLinks) {
      const dishTitle = link.dish.title;
      const servingsDefault = link.dish.servingsDefault;
      for (const di of link.dish.dishIngredients) {
        allRows.push({
          canonical: di.ingredient?.canonicalName ?? "(null)",
          unit: di.unit ?? "",
          quantity: di.quantity,
          prep: di.preparationNote ?? null,
          dish: dishTitle,
          meal: mealTitle,
          planItemId: it.id,
          mealId: it.mealId,
          servingsOverride: it.servingsOverride,
          servingsDefault,
        });
      }
    }
  }

  console.log(`Total DishIngredient iterations: ${allRows.length}`);
  console.log(`Distinct mealIds across plan.items: ${new Set(plan.items.map((i) => i.mealId)).size}`);
  for (const r of allRows) {
    console.log(
      `    canonical=${r.canonical.padEnd(28)} qty=${String(r.quantity).padEnd(5)} unit=${r.unit.padEnd(8)} prep=${JSON.stringify(r.prep ?? null).padEnd(20)} servOver=${r.servingsOverride ?? "null"} servDef=${r.servingsDefault} dish=${JSON.stringify(r.dish).slice(0, 40)}`,
    );
  }

  console.log("\n" + "─".repeat(80));
  console.log("(3) CONSOLIDATOR output (what generateFinalGroceryList received)");
  console.log("─".repeat(80));

  const consolidated = await consolidatePlanIngredients({
    prisma,
    planId: recentList.mealPlanInstanceId,
    userId: recentList.userId,
  });
  console.log(`Consolidated rows: ${consolidated.length}`);
  for (const c of consolidated) {
    const flags = [
      c.isUniversalStaple ? "univ" : null,
      c.isRecurringItem ? "rec" : null,
      c.isUserPantryStaple ? "pantry" : null,
    ]
      .filter(Boolean)
      .join(",");
    console.log(
      `    canonical=${c.canonicalName.padEnd(30)} qty=${String(c.quantity).padEnd(5)} unit=${c.unit.padEnd(8)} sect=${c.sectionKey.padEnd(14)} prep=${JSON.stringify(c.preparationNote ?? null).padEnd(20)} flags=${flags.padEnd(15)} | display="${c.displayName}"`,
    );
  }

  console.log("\n" + "─".repeat(80));
  console.log("(4) USER recurring + pantry staples");
  console.log("─".repeat(80));
  const user = await prisma.user.findUnique({
    where: { id: recentList.userId },
    select: {
      email: true,
      pantryStaples: { select: { ingredientName: true, isActive: true } },
      preferences: { select: { recurringGroceryItems: true } },
    },
  });
  console.log(`User email: ${user?.email}`);
  console.log(`Recurring items (${user?.preferences?.recurringGroceryItems?.length ?? 0}):`);
  for (const r of user?.preferences?.recurringGroceryItems ?? []) {
    console.log(`    "${r}"`);
  }
  console.log(`Pantry staples (${user?.pantryStaples?.length ?? 0}):`);
  for (const p of user?.pantryStaples ?? []) {
    console.log(`    "${p.ingredientName}" active=${p.isActive}`);
  }

  console.log("\n" + "─".repeat(80));
  console.log("(5) ATTRIBUTION — final list rows vs. consolidator rows");
  console.log("─".repeat(80));
  const consolidatedByLower = new Map<string, number>();
  for (const c of consolidated) {
    const k = c.canonicalName.toLowerCase().trim();
    consolidatedByLower.set(k, (consolidatedByLower.get(k) ?? 0) + 1);
  }
  console.log(`Final list row count: ${recentList.items.length}`);
  console.log(`Consolidator row count: ${consolidated.length}`);
  console.log(
    `Δ = ${recentList.items.length - consolidated.length} (positive → AI added or duplicated rows, negative → AI merged)`,
  );

  console.log("\nFinal-list display names NOT present (by case-insensitive substring) in consolidator canonicals:");
  const consCanonicalsLower = consolidated.map((c) => c.canonicalName.toLowerCase());
  for (const it of recentList.items) {
    const dn = it.displayName.toLowerCase();
    const found = consCanonicalsLower.some((c) => dn.includes(c) || c.includes(dn));
    if (!found) {
      console.log(`    [ORPHAN] ${it.displayName}  (sect=${it.storeSection}, qty=${it.quantity} ${it.unit})`);
    }
  }
}

main()
  .catch((err) => {
    console.error("Probe failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
