// [prepcook] Part J.1c item 5 — READ-ONLY: the Slow-Cooker Chicken and Dumplings
// carrots as the catalog stores them (amount, servings, step prose), to find where
// "peel 2 carrots" could come from.
import { PrismaClient } from "@prisma/client";

import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { FORBIDDEN_PLAN } from "../part-i/corpus";

const prisma = new PrismaClient();
async function main() {
  const { userId } = await prisma.mealPlanInstance.findUniqueOrThrow({ where: { id: FORBIDDEN_PLAN }, select: { userId: true } });
  const { input } = await loadPrepWeekInput({ planId: FORBIDDEN_PLAN, userId, prisma });
  for (const m of input.meals) {
    for (const d of m.dishes) {
      const ing = d.ingredients.filter((i) => /carrot/i.test(i.ingredientName));
      if (!ing.length) continue;
      console.log(`${m.mealName} / ${d.dishName}  base ${d.baseServings} authored ${d.authoredBaseServings} override ${m.servingsOverride}`);
      for (const i of ing) console.log(`  ${i.quantity} ${i.unit} ${i.ingredientName} · note ${i.preparationNote} · purchase ${i.purchaseUnit}`);
      for (const s of d.stepTexts.filter((t) => /carrot/i.test(t))) console.log(`  step: ${s}`);
    }
  }
}
main().finally(() => prisma.$disconnect());
