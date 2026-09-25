// Row 13 "Test Kitchen" · Block 1 — the use-template copy, extracted.
//
// This is the body that lived inline in POST /plans/use-template/:templateId
// (routes/plans.ts, WS7-4-B c4), moved here VERBATIM in behaviour so a second
// caller can have it: the guest claim's `templatePlanId`, which adopts a
// featured weekly plan into a brand-new account at sign-up (scope §3.7).
//
// Nothing about the copy changed. It was already written entirely against a
// `tx` — create the instance, stamp first-plan-created, fork-on-acquire the
// template's meals, mirror the items, bump the template's use counters, emit
// the activity — so lifting it out is a move, not a rewrite. The route now
// calls it inside the same $transaction it always opened.

import { Prisma, type PrismaClient } from "@prisma/client";

import { forkMealForUser } from "./mealFork";
import { emitActivity } from "./userActivity";

export type CopyTemplateResult =
  | { kind: "not_found" }
  | {
      kind: "created";
      instance: { id: string; revisionId: number };
    };

/**
 * Copy a public (or the requester's own private) MealPlanTemplate into a new
 * undated MealPlanInstance for `userId`.
 *
 * Visibility: a template that is neither public nor the requester's own reads
 * as `not_found` — never 403, so the route cannot be used to probe ids.
 *
 * The new plan is UNDATED and therefore not "current": WS7-6 (E) removed the
 * stored isActiveThisWeek column, "active" is the date-range predicate, and
 * the caller dates it separately if it wants it to be this week's plan.
 */
export async function copyTemplateForUser(
  tx: Prisma.TransactionClient,
  templateId: string,
  userId: string,
  markFirstPlanCreated: (
    tx: Prisma.TransactionClient,
    userId: string,
  ) => Promise<void>,
): Promise<CopyTemplateResult> {
  const template = await tx.mealPlanTemplate.findUnique({
    where: { id: templateId },
    include: { items: { orderBy: { positionIndex: "asc" } } },
  });
  if (!template) return { kind: "not_found" };
  if (!template.isPublic && template.userId !== userId) {
    return { kind: "not_found" };
  }

  // WS7-6 (E): no demote-prior — the stored isActiveThisWeek column is gone.
  // The new row is created undated; the caller dates it, and the per-user
  // EXCLUDE constraint enforces single-current at that point.
  const instance = await tx.mealPlanInstance.create({
    data: {
      userId,
      mealPlanTemplateId: templateId,
      titleOverride: null,
      status: "draft",
      startDate: null,
      endDate: null,
      // WS9 3d Part 2d (D-WS9-013) — use-template mints a real committed
      // (non-draft) plan, just undated/inactive; stamp the commit instant.
      committedAt: new Date(),
      optimizationNotes:
        (template.optimizationNotes as Prisma.InputJsonValue | null) ??
        Prisma.DbNull,
      breakfastOverrides: null,
      lunchOverrides: null,
    },
  });

  // D-WS9-026 — stamp first-plan-created (write-if-null; first wins).
  await markFirstPlanCreated(tx, userId);

  if (template.items.length > 0) {
    // WS7-7-A B5 fix2 (D-WS7-139) — fork-on-acquire. Template items bind the
    // template's mealIds, which for a public/featured template are
    // curated/null-owner or another user's meals. Clone each not-already-owned
    // source meal into a user-owned copy so the new plan's meals are editable.
    // Dedup by source mealId: a meal that appears in two slots of the template
    // shares ONE forked copy (preserving the template's intra-plan sharing);
    // already-owned meals bind as-is.
    const distinctMealIds = [...new Set(template.items.map((it) => it.mealId))];
    const owners = await tx.meal.findMany({
      where: { id: { in: distinctMealIds } },
      select: { id: true, userId: true },
    });
    const ownerById = new Map(owners.map((m) => [m.id, m.userId]));
    const boundBySource = new Map<string, string>();
    for (const sourceMealId of distinctMealIds) {
      const owner = ownerById.get(sourceMealId);
      boundBySource.set(
        sourceMealId,
        owner === userId
          ? sourceMealId
          : (await forkMealForUser(tx, sourceMealId, userId)).mealId,
      );
    }
    await tx.mealPlanItem.createMany({
      data: template.items.map((it) => ({
        mealPlanInstanceId: instance.id,
        mealId: boundBySource.get(it.mealId) ?? it.mealId,
        positionIndex: it.positionIndex,
        assignedDayOfWeek: it.assignedDayOfWeek,
        isBreakfast: it.isBreakfast,
        isLunch: it.isLunch,
        isDinner: it.isDinner,
      })),
    });
  }

  await tx.mealPlanTemplate.update({
    where: { id: templateId },
    data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
  });

  await emitActivity({
    tx,
    userId,
    eventType: "plan_used_from_browse",
    entityType: "MealPlanInstance",
    entityId: instance.id,
    metadata: { templateId, itemCount: template.items.length },
  });

  return {
    kind: "created",
    instance: { id: instance.id, revisionId: instance.revisionId },
  };
}

/** Narrow the client type the route hands in. Exported for the route's use. */
export type PlanFromTemplatePrisma = Pick<PrismaClient, "$transaction">;
