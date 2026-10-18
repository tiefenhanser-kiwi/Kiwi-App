// Row 13 "Test Kitchen" · Block 1 — the use-template copy, extracted.
//
// This is the body that lived inline in POST /plans/use-template/:templateId
// (routes/plans.ts, WS7-4-B c4), moved here VERBATIM in behaviour so a second
// caller can have it: the guest claim's `templatePlanId`, which adopts a
// featured weekly plan into a brand-new account at sign-up (scope §3.7).
//
// FIX-6 (BUG-435) — the copy is now two halves, and only the second runs in
// the transaction:
//   · prepareTemplateCopy — every READ: the template and its items, who owns
//     each meal, and the full graph of every meal that forks (built into rows
//     in memory by mealFork.prepareMealForks). Runs on the plain client.
//   · writeTemplateCopy — the writes, inside the caller's transaction: create
//     the instance, stamp first-plan-created, write the forks (one createMany
//     per table), mirror the items, bump the template's use counters, emit the
//     activity. A fixed handful of statements, however big the template.
// It used to fork meal by meal inside one interactive transaction (~6 queries
// per dish); a 15-dish featured week overran Prisma's 5 s default (P2028).

import { Prisma, type PrismaClient } from "@prisma/client";

import { prepareMealForks, writeMealForks, type PreparedForks } from "./mealFork";
import { todayFor } from "./planDayAssignment";
import { anchoredDatingFor, type AnchoredDating } from "./templateAnchor";
import { emitActivity } from "./userActivity";

export type CopyTemplateResult =
  | { kind: "not_found" }
  | {
      kind: "created";
      instance: { id: string; revisionId: number };
      /**
       * THX-2S (D-WS9-311) — the anchored window when the template's anchor
       * dated this copy (adopted on or before the anchor day); null = undated,
       * exactly as before. A caller that dates the copy itself must leave an
       * anchored one alone.
       */
      anchoredWindow: { startDate: Date; endDate: Date } | null;
    };

type Tx = Prisma.TransactionClient;

/** What the read half needs. A transaction client works too (tests). */
export type TemplateCopyReader = Pick<
  Tx,
  "mealPlanTemplate" | "meal" | "recipeInstructionStep" | "userPreferences"
>;

/** The client copyTemplateForUser takes: the reads plus `$transaction`. */
export type PlanFromTemplatePrisma = TemplateCopyReader & Pick<PrismaClient, "$transaction">;

type TemplateWithItems = Prisma.MealPlanTemplateGetPayload<{ include: { items: true } }>;

/** Everything the write half needs, read and built before the transaction. */
export interface PreparedTemplateCopy {
  kind: "prepared";
  templateId: string;
  userId: string;
  template: TemplateWithItems;
  dating: AnchoredDating | null;
  /** Source mealId → the mealId the plan item binds (the user's own, or its fork). */
  boundBySource: Map<string, string>;
  forks: PreparedForks;
}

/**
 * The read half: load the template, check visibility, and build the forks.
 *
 * Visibility: a template that is neither public nor the requester's own reads
 * as `not_found` — never 403, so the route cannot be used to probe ids.
 */
export async function prepareTemplateCopy(
  db: TemplateCopyReader,
  templateId: string,
  userId: string,
  opts: { today?: Date } = {},
): Promise<{ kind: "not_found" } | PreparedTemplateCopy> {
  const template = await db.mealPlanTemplate.findUnique({
    where: { id: templateId },
    include: { items: { orderBy: { positionIndex: "asc" } } },
  });
  // BUG-403 — an archived template cannot be adopted by id (use-template and
  // the sign-up templatePlanId both come through here).
  if (!template || template.isArchived) return { kind: "not_found" };
  if (!template.isPublic && template.userId !== userId) {
    return { kind: "not_found" };
  }

  const dating = anchoredDatingFor(template, opts.today ?? todayFor(undefined));

  // WS7-7-A B5 fix2 (D-WS7-139) — fork-on-acquire. Template items bind the
  // template's mealIds, which for a public/featured template are
  // curated/null-owner or another user's meals. Clone each not-already-owned
  // source meal into a user-owned copy so the new plan's meals are editable.
  // Dedup by source mealId: a meal that appears in two slots of the template
  // shares ONE forked copy (preserving the template's intra-plan sharing);
  // already-owned meals bind as-is.
  const distinctMealIds = [...new Set(template.items.map((it) => it.mealId))];
  const owners =
    distinctMealIds.length > 0
      ? await db.meal.findMany({
          where: { id: { in: distinctMealIds } },
          select: { id: true, userId: true },
        })
      : [];
  const ownerById = new Map(owners.map((m) => [m.id, m.userId]));
  const toFork = distinctMealIds.filter((id) => ownerById.get(id) !== userId);
  const forks = await prepareMealForks(db, toFork, userId);
  const boundBySource = new Map(
    distinctMealIds.map((id) => [id, forks.mealIdBySource.get(id) ?? id]),
  );

  return { kind: "prepared", templateId, userId, template, dating, boundBySource, forks };
}

/**
 * The write half, inside the caller's transaction. Reads nothing; every query
 * it issues is a write, and their number does not grow with the template.
 *
 * The new plan is UNDATED and therefore not "current": WS7-6 (E) removed the
 * stored isActiveThisWeek column, "active" is the date-range predicate, and
 * the caller dates it separately if it wants it to be this week's plan.
 *
 * THX-2S (D-WS9-311) — two exceptions, both from the template:
 *   · each item's servingsOverride is copied (a feast written for 10 stays 10;
 *     items without one follow the household size, as before);
 *   · an ANCHORED template adopted on or before its anchor day (`today`) is
 *     dated in the anchor's week by the items' own days (lib/templateAnchor.ts).
 *     It is not activated here — dating is not activation.
 */
export async function writeTemplateCopy(
  tx: Tx,
  prepared: PreparedTemplateCopy,
  markFirstPlanCreated: (tx: Tx, userId: string) => Promise<void>,
): Promise<Extract<CopyTemplateResult, { kind: "created" }>> {
  const { templateId, userId, template, dating, boundBySource, forks } = prepared;

  // WS7-6 (E): no demote-prior — the stored isActiveThisWeek column is gone.
  // The new row is created undated; the caller dates it, and the per-user
  // EXCLUDE constraint enforces single-current at that point.
  const instance = await tx.mealPlanInstance.create({
    data: {
      userId,
      mealPlanTemplateId: templateId,
      titleOverride: null,
      status: "draft",
      startDate: dating?.window.startDate ?? null,
      endDate: dating?.window.endDate ?? null,
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
    await writeMealForks(tx, forks);
    await tx.mealPlanItem.createMany({
      data: template.items.map((it, i) => ({
        mealPlanInstanceId: instance.id,
        mealId: boundBySource.get(it.mealId) ?? it.mealId,
        positionIndex: it.positionIndex,
        assignedDayOfWeek: it.assignedDayOfWeek,
        // THX-2S — the anchored date of this item's day (null when undated).
        assignedDate: dating?.itemDates[i] ?? null,
        servingsOverride: it.servingsOverride ?? null,
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
    anchoredWindow: dating?.window ?? null,
  };
}

/**
 * Copy a public (or the requester's own private) MealPlanTemplate into a new
 * undated MealPlanInstance for `userId`: the read half on `prisma`, then the
 * write half in its own transaction (Prisma's default budget is ample for it).
 * A caller with more to write in the same transaction (the guest claim's
 * adopt) calls the two halves itself.
 */
export async function copyTemplateForUser(
  prisma: PlanFromTemplatePrisma,
  templateId: string,
  userId: string,
  markFirstPlanCreated: (tx: Tx, userId: string) => Promise<void>,
  opts: { today?: Date } = {},
): Promise<CopyTemplateResult> {
  const prepared = await prepareTemplateCopy(prisma, templateId, userId, opts);
  if (prepared.kind === "not_found") return prepared;
  return prisma.$transaction((tx) => writeTemplateCopy(tx, prepared, markFirstPlanCreated));
}
