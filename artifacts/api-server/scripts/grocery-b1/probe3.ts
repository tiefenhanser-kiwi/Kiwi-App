// [grocery] B1 · Part A — PROBE 3. READ-ONLY. BUG-328's honest step sums.
//   node --env-file=.env --import tsx scripts/grocery-b1/probe3.ts
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const titles = [
    "Cheese Ravioli with Marinara and Garlic Bread",
    "Spicy Chicken Scampi with Cherry Tomatoes over Linguine",
    "Sausage and Kale Orecchiette with Crusty Bread",
  ];
  for (const t of titles) {
    const meals = await prisma.meal.findMany({
      where: { title: t },
      select: {
        id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true,
        sourceType: true, isPublic: true, userId: true,
        dishLinks: { select: { dish: { select: { id: true, title: true, estimatedTimeMinutes: true } } } },
      },
    });
    if (meals.length === 0) { console.log(`\n(no meal titled "${t}")`); continue; }
    for (const m of meals) {
      const dishIds = m.dishLinks.map((l) => l.dish.id);
      const steps = await prisma.recipeInstructionStep.findMany({
        where: { ownerType: "dish", ownerId: { in: dishIds } },
        select: { ownerId: true, estimatedMinutes: true, phaseType: true, pathKey: true, stepTextRaw: true },
        orderBy: { stepIndex: "asc" },
      });
      const base = steps.filter((s) => s.pathKey !== "bought");
      const sum = base.reduce((a, s) => a + s.estimatedMinutes, 0);
      const boughtSum = steps.filter((s) => s.pathKey === "bought").reduce((a, s) => a + s.estimatedMinutes, 0);
      const scratchSum = steps.filter((s) => s.pathKey === "scratch").reduce((a, s) => a + s.estimatedMinutes, 0);
      const nullPath = steps.filter((s) => s.pathKey == null).reduce((a, s) => a + s.estimatedMinutes, 0);
      console.log(`\n${m.title}`);
      console.log(`  id=${m.id.slice(0, 8)} src=${m.sourceType} public=${m.isPublic} user=${m.userId ? m.userId.slice(0, 8) : "null"}`);
      console.log(`  LABEL estimatedTimeMinutes=${m.estimatedTimeMinutes} · activeTimeMinutes=${m.activeTimeMinutes ?? "null"}`);
      console.log(`  dishes: ${m.dishLinks.map((l) => `${l.dish.title} (${l.dish.estimatedTimeMinutes}m)`).join(" + ")}`);
      console.log(`  steps: ${steps.length} total · base(null pathKey)=${nullPath}m · scratch=${scratchSum}m · bought=${boughtSum}m`);
      console.log(`  HONEST STEP SUM (base + scratch, i.e. pathKey != 'bought') = ${sum} min · ratio vs label = ${(sum / m.estimatedTimeMinutes).toFixed(2)}`);
      console.log(`  ALT (base + bought, the convenience path)                  = ${nullPath + boughtSum} min · ratio = ${((nullPath + boughtSum) / m.estimatedTimeMinutes).toFixed(2)}`);
    }
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
