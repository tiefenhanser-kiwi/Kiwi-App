import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const plan = await prisma.mealPlanInstance.findFirst({
    where: { id: { startsWith: "f5556c19" } },
    select: { id: true, items: { select: { servingsOverride: true, meal: { select: { servingsDefault: true, dishLinks: { select: { dish: { select: { servingsDefault: true, dishIngredients: { select: { quantity: true, unit: true, ingredient: { select: { canonicalName: true } } } } } } } } } } } } },
  });
  const tally = new Map<string, { q: number; u: string }>();
  for (const it of plan!.items) {
    for (const l of it.meal.dishLinks) {
      const mult = (it.servingsOverride ?? l.dish.servingsDefault) / l.dish.servingsDefault;
      for (const di of l.dish.dishIngredients) {
        const n = di.ingredient.canonicalName;
        if (!/lime/i.test(n)) continue;
        const cur = tally.get(n) ?? { q: 0, u: di.unit };
        cur.q += di.quantity * mult;
        tally.set(n, cur);
      }
    }
  }
  for (const [n, v] of tally) console.log(`  ${n}: ${v.q} ${v.u}`);
  const edges = await prisma.ingredientRelation.findMany({
    where: { label: "component", from: { canonicalName: "lime" } },
    include: { to: { select: { canonicalName: true } } },
  });
  for (const e of edges) console.log(`  EDGE lime -> ${e.to.canonicalName}: ${e.yieldQuantity} ${e.yieldUnit} co=${e.coHarvestable} human=${e.reviewedByHuman}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
