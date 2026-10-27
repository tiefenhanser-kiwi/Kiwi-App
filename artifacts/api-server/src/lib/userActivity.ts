// WS7-4-A — Activity event emission helper.
// Single shared entry point for prisma.userActivity.create writes. Mirrors
// the bumpPlanRevision pattern: pass an injected Prisma.TransactionClient
// when emitting inside a mutation transaction; fall back to the singleton
// prisma client otherwise.
//
// Errors are swallowed (logger.warn). Activity emission must never fail a
// user-facing mutation — matches the existing inline pattern in routes/
// meals.ts, routes/groceryLists.ts, lib/planMacros.ts.

import type { ActivityEventType, Prisma } from "@prisma/client";

import { logger } from "./logger";
import { prisma } from "./prisma";

type Tx = Prisma.TransactionClient;

export interface EmitActivityParams {
  userId: string;
  eventType: ActivityEventType;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  tx?: Tx;
}

export async function emitActivity(params: EmitActivityParams): Promise<void> {
  const { userId, eventType, entityType, entityId, metadata, tx } = params;
  const client = tx ?? prisma;
  try {
    await client.userActivity.create({
      data: {
        userId,
        eventType,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
        platform: "api",
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    logger.warn(
      { event: "activity_emit_failed", userId, eventType, err },
      "Failed to emit user activity",
    );
  }
}

/**
 * SERVER-6 BUG-547 — `plan_prep_started`, ONCE PER PLAN, from the first prep
 * check-off. Until this the only emitter was the prepStatus PATCH on
 * PATCH /plans/:id, which no client sends, so the event never happened (LIFE-2).
 * The check-off PUT calls this after its upsert.
 *
 * Once per plan by a read before the write: any `plan_prep_started` row for the
 * plan already counts, the PATCH's included. There is no unique index on
 * activities; two concurrent first check-offs can both write, and a second row
 * changes nothing a reader counts (LIFE-2 reads the earliest). Never throws: a
 * failure is one warn line and the check-off stands.
 */
export async function emitPlanPrepStartedOnce(
  client: Pick<Tx, "userActivity">,
  args: { userId: string; planId: string; stepKey: string },
): Promise<boolean> {
  try {
    const already = await client.userActivity.findFirst({
      where: { userId: args.userId, eventType: "plan_prep_started", entityType: "MealPlanInstance", entityId: args.planId },
      select: { id: true },
    });
    if (already) return false;
    await emitActivity({
      tx: client as Tx,
      userId: args.userId,
      eventType: "plan_prep_started",
      entityType: "MealPlanInstance",
      entityId: args.planId,
      metadata: { source: "check_off", stepKey: args.stepKey },
    });
    return true;
  } catch (err) {
    logger.warn(
      { event: "plan_prep_started_emit_failed", userId: args.userId, planId: args.planId, err },
      "Prep check-off saved; plan_prep_started was not recorded",
    );
    return false;
  }
}
