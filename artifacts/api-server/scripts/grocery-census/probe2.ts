// Grocery census — Part A probe 2. READ-ONLY.
// Pins the "September 19 under-order" list by its symptom, and profiles
// candidate plans for corpus variety.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
    throw new Error("REFUSING: not the dev branch");
  }

  // 1. The chicken-broth under-order row canon names.
  const broth = await prisma.groceryListItem.findMany({
    where: { displayName: { contains: "broth", mode: "insensitive" } },
    select: {
      displayName: true,
      quantity: true,
      unit: true,
      purchaseUnit: true,
      purchaseQuantity: true,
      purchaseDisplay: true,
      groceryList: {
        select: { id: true, createdAt: true, mealPlanInstanceId: true },
      },
    },
  });
  console.log("=== BROTH ROWS ===");
  for (const b of broth) {
    console.log(
      [
        b.groceryList.id.slice(0, 8),
        b.groceryList.createdAt.toISOString().slice(0, 10),
        `${b.quantity} ${b.unit}`,
        `pack=${b.purchaseQuantity ?? "-"} ${b.purchaseUnit ?? "-"} (${b.purchaseDisplay ?? "-"})`,
        b.displayName,
      ].join("  |  "),
    );
  }

  // 2. Corpus variety signals per candidate plan: does the plan's dish set
  //    touch herbs / citrus / canned / dairy, does the owner have recurring
  //    items, and does any dish carry path-tagged steps.
  const planIds = await prisma.mealPlanInstance.findMany({
    where: { items: { some: {} } },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: 80,
  });

  const HERBS = ["cilantro", "parsley", "basil", "thyme", "rosemary", "mint", "dill", "sage", "scallion", "green onion", "chive"];
  const CITRUS = ["lemon", "lime", "orange"];
  const CANNED = ["canned", "can of", "broth", "stock", "diced tomatoes", "crushed tomatoes", "tomato paste", "beans", "coconut milk"];
  const DAIRY = ["milk", "cream", "butter", "cheese", "yogurt", "sour cream"];

  console.log("\n=== PLAN PROFILES ===");
  const rows: string[] = [];
  for (const { id } of planIds) {
    const plan = await prisma.mealPlanInstance.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        titleOverride: true,
        createdAt: true,
        template: { select: { title: true } },
        user: { select: { preferences: { select: { recurringGroceryItems: true } } } },
        items: {
          select: {
            recipeOverrideJson: true,
            meal: {
              select: {
                title: true,
                dishLinks: {
                  select: {
                    dish: {
                      select: {
                        id: true,
                        title: true,
                        dishIngredients: { select: { ingredient: { select: { canonicalName: true, category: true } }, unit: true } },
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
    if (!plan) continue;
    const names: string[] = [];
    const units = new Set<string>();
    let dishCount = 0;
    for (const it of plan.items)
      for (const dl of it.meal.dishLinks) {
        dishCount++;
        for (const di of dl.dish.dishIngredients) {
          if (di.ingredient?.canonicalName) names.push(di.ingredient.canonicalName);
          if (di.unit) units.add(di.unit);
        }
      }
    const has = (list: string[]) => names.some((n) => list.some((k) => n.includes(k)));
    const rec = plan.user?.preferences?.recurringGroceryItems ?? [];
    const overrides = plan.items.filter((i) => i.recipeOverrideJson != null).length;
    rows.push(
      [
        plan.id.slice(0, 8),
        `u=${plan.userId.slice(0, 6)}`,
        `d=${dishCount}`,
        `ing=${names.length}`,
        `herb=${has(HERBS) ? "Y" : "-"}`,
        `citrus=${has(CITRUS) ? "Y" : "-"}`,
        `can=${has(CANNED) ? "Y" : "-"}`,
        `dairy=${has(DAIRY) ? "Y" : "-"}`,
        `rec=${rec.length}`,
        `ovr=${overrides}`,
        `units=${units.size}`,
        plan.createdAt.toISOString().slice(0, 10),
        (plan.titleOverride ?? plan.template?.title ?? "").slice(0, 34),
      ].join(" "),
    );
  }
  console.log(rows.join("\n"));

  // 3. Recurring items across users.
  const prefs = await prisma.userPreferences.findMany({
    where: { NOT: { recurringGroceryItems: { isEmpty: true } } },
    select: { userId: true, recurringGroceryItems: true },
  });
  console.log("\n=== USERS WITH RECURRING ITEMS ===");
  for (const p of prefs)
    console.log(p.userId.slice(0, 6), JSON.stringify(p.recurringGroceryItems));
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
