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
