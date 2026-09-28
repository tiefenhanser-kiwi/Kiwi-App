// Grocery census — Part A probe. READ-ONLY.
// Confirms the Prisma client resolves, the dev branch is reachable, and
// prints the corpus-selection facts (candidate plans, the canon-named lists).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function host(): string {
  const u = new URL(process.env.DATABASE_URL ?? "");
  return u.hostname;
}

async function main() {
  const h = host();
  if (!h.includes("ep-broad-haze")) {
    throw new Error("REFUSING: DATABASE_URL host is not the dev branch");
  }
  console.log("db host ok (ep-broad-haze*)");

  const counts = {
    users: await prisma.user.count(),
    plans: await prisma.mealPlanInstance.count(),
    lists: await prisma.groceryList.count(),
    listItems: await prisma.groceryListItem.count(),
    ingredients: await prisma.ingredient.count(),
    relations: await prisma.ingredientRelation.count(),
    dishIngredients: await prisma.dishIngredient.count(),
  };
  console.log("COUNTS", JSON.stringify(counts, null, 1));

  // The lists canon names, by id prefix.
  const prefixes = ["bd29f91a", "3346e106", "cb5c8f6e", "c08a9f4e", "98dc58d0"];
  for (const p of prefixes) {
    const rows = await prisma.groceryList.findMany({
      where: { id: { startsWith: p } },
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        mealPlanInstanceId: true,
        userId: true,
        _count: { select: { items: true } },
      },
    });
    console.log(
      `NAMED ${p}:`,
      rows.length === 0
        ? "NOT FOUND"
        : JSON.stringify(
            rows.map((r) => ({
              id: r.id,
              plan: r.mealPlanInstanceId,
              status: r.status,
              rows: r._count.items,
              at: r.createdAt.toISOString(),
            })),
          ),
    );
  }

  // The September 19 list(s), by date + row count.
  const sept = await prisma.groceryList.findMany({
    where: {
      createdAt: {
        gte: new Date("2026-09-18T00:00:00Z"),
        lt: new Date("2026-09-21T00:00:00Z"),
      },
    },
    select: {
      id: true,
      createdAt: true,
      mealPlanInstanceId: true,
      _count: { select: { items: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(
    "SEPT18-20 LISTS:",
    JSON.stringify(
      sept.map((r) => ({
        id: r.id.slice(0, 8),
        plan: r.mealPlanInstanceId?.slice(0, 8) ?? null,
        rows: r._count.items,
        at: r.createdAt.toISOString(),
      })),
      null,
      1,
    ),
  );

  // Recent plans with dish content, most recent first.
  const plans = await prisma.mealPlanInstance.findMany({
    where: { items: { some: {} } },
    select: {
      id: true,
      userId: true,
      titleOverride: true,
      createdAt: true,
      compostedAt: true,
      template: { select: { title: true } },
      _count: { select: { items: true } },
      groceryLists: { select: { id: true, status: true, _count: { select: { items: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  console.log("RECENT PLANS:");
  for (const p of plans) {
    console.log(
      [
        p.id.slice(0, 8),
        `u=${p.userId.slice(0, 6)}`,
        `meals=${p._count.items}`,
        `lists=${p.groceryLists.length}`,
        `listRows=${p.groceryLists.map((l) => l._count.items).join("/") || "-"}`,
        p.compostedAt ? "COMPOSTED" : "live",
        p.createdAt.toISOString().slice(0, 10),
        (p.titleOverride ?? p.template?.title ?? "").slice(0, 40),
      ].join("  "),
    );
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
