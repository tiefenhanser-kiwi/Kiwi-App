// WS6 6c-4 Block A — Plan revision bump helper.
// Monotonically increments MealPlanInstance.revisionId. Called from any
// callsite that mutates plan content (item add/update/delete, plan title/
// dates/servings change). GroceryList.lastGeneratedFromPlanRevisionId
// compares against this to detect drift.
//
// No mealPlanItem.{create,update,delete,upsert} or mealPlanInstance.update
// callsites exist in api-server/src as of HEAD d124dc2 — meal-plan mutation
// routes haven't been built yet. This helper ships ahead so future routes
// can wire bumpPlanRevision in their transactions from the start.

import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma";

type Tx = Prisma.TransactionClient;

export async function bumpPlanRevision(planId: string, tx?: Tx): Promise<void> {
  const client = tx ?? prisma;
  await client.mealPlanInstance.update({
    where: { id: planId },
    data: { revisionId: { increment: 1 } },
  });
}
