// WS9 Block 3a / D-WS9-026 — first-plan activation stamp.
//
// Stamps User.firstPlanCreatedAt the first time a user commits a real
// (non-wizard-draft) plan. Called from every plan-commit seam:
//   - POST /plans                    (manual create)      routes/plans.ts
//   - POST /plans/from-template/:id  (use template)       routes/plans.ts
//   - wizard "activate"              (draft → this week)   routes/wizard.ts
//   - wizard "save and use"          (draft → saved)       routes/wizard.ts
//
// The `firstPlanCreatedAt: null` predicate in the WHERE makes this a
// write-if-null guard: the FIRST commit wins, every later commit no-ops.
// It is a *first*, NOT a *latest* — updateMany-with-guard, never an upsert.
// Runs inside the caller's transaction so the stamp commits atomically with
// the plan it records.

import type { Prisma } from "@prisma/client";

export async function markFirstPlanCreated(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.user.updateMany({
    where: { id: userId, firstPlanCreatedAt: null },
    data: { firstPlanCreatedAt: new Date() },
  });
}
