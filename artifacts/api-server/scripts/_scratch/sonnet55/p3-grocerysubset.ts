// READ-ONLY: which corpus plans send a non-empty subset to grocery.generate_list.
import { PrismaClient } from "@prisma/client";
import { consolidatePlanIngredients } from "../../../src/lib/groceryList";
import { loadRelationRows } from "../../../src/lib/relationIndexLoader";
import { buildRelationIndex } from "../../../src/lib/ingredientRelations";
import { partitionForAI } from "../../../src/lib/groceryListAI";
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("refusing");
const prisma = new PrismaClient();
const rows = await loadRelationRows(prisma);
const relations = buildRelationIndex(rows);
for (const p of ["2251c7f5", "d06a721d", "c62587bb", "425da049", "163875ec", "247cd7bb", "2b6e51a1", "316d0846", "31c7a885", "96a94410", "a8b0bbd5"]) {
  const plan = await prisma.mealPlanInstance.findFirst({ where: { id: { startsWith: p } }, select: { id: true, userId: true } });
  if (!plan) continue;
  const c = await consolidatePlanIngredients({ prisma, planId: plan.id, userId: plan.userId, relations, relationRows: rows } as never);
  const { aiSubset } = partitionForAI(c, relations);
  console.log(p, "rows", c.length, "aiSubset", aiSubset.length);
}
await prisma.$disconnect();
