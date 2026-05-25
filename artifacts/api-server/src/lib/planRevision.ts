// WS6 6c-4 Block A — Plan revision bump helper.
// Monotonically increments MealPlanInstance.revisionId and returns the new
// value. Callers that respond to a mutation should echo this in their
// response body so the client can invalidate cached plan reads.
// GroceryList.lastGeneratedFromPlanRevisionId compares against this to
// detect drift.

import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma";

type Tx = Prisma.TransactionClient;

export async function bumpPlanRevision(planId: string, tx?: Tx): Promise<number> {
  const client = tx ?? prisma;
  const updated = await client.mealPlanInstance.update({
    where: { id: planId },
    data: { revisionId: { increment: 1 } },
    select: { revisionId: true },
  });
  return updated.revisionId;
}
