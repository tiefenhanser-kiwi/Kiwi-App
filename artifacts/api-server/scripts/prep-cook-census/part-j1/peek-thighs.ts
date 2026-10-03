// Part J.1b #3 — READ-ONLY: the Slow-Cooker Chicken and Dumplings thighs, note and steps.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
(async () => {
  const items = await prisma.mealPlanItem.findMany({ where: { mealPlanInstanceId: "e55a9305-2695-4c16-a25e-effcc03fc109" }, select: { meal: { select: { id: true, title: true, dishLinks: { select: { dish: { select: { id: true, title: true, dishIngredients: { select: { preparationNote: true, quantity: true, unit: true, ingredient: { select: { displayName: true } } } } } } } } } } } });
  for (const it of items) {
    if (!/Dumplings/.test(it.meal.title)) continue;
    for (const l of it.meal.dishLinks) {
      for (const di of l.dish.dishIngredients) if (/chicken/i.test(di.ingredient.displayName)) console.log("ING", di.ingredient.displayName, "|", di.quantity, di.unit, "| note:", di.preparationNote);
      const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerId: { in: [l.dish.id, it.meal.id] } }, orderBy: { stepIndex: "asc" }, select: { ownerType: true, stepIndex: true, phaseType: true, stepTextTranslated: true } });
      for (const s of steps) console.log(s.ownerType, s.stepIndex, s.phaseType, s.stepTextTranslated);
    }
  }
})().finally(() => prisma.$disconnect());
