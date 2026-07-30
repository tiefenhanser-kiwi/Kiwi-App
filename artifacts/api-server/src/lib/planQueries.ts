// WS7-3 A2 — shared plan-discovery query logic for GET /plans + GET /home.
//
// The four Plan Discovery filter keys resolve against two tables:
//   my_plans                  → the user's own MealPlanInstance rows
//   featured / hosting_events  → public MealPlanTemplate rows, honoring the
//                                date-windowed featuring resolution
//                                (lib/featuring)
//   top_rated                  → public MealPlanTemplate rows ordered by the
//                                cached topRatedScore (lib/topRated)
//
// PlanListItem is a uniform shape spanning both row kinds so a discovery card
// or a /plans page can mix instances and templates.

import type { Prisma, PrismaClient } from "@prisma/client";

import { featuredWhere, hostingFeaturedWhere } from "./featuring";
import { resolveThisWeekWinnerId } from "./planDates";
import { getTopRatedSettings } from "./topRated";

export type PlanFilterKey =
  | "my_plans"
  | "featured"
  | "top_rated"
  | "hosting_events";

export const PLAN_FILTER_KEYS: readonly PlanFilterKey[] = [
  "my_plans",
  "featured",
  "top_rated",
  "hosting_events",
];

export interface PlanListItem {
  id: string;
  name: string;
  description: string | null;
  image: string | null;
  tags: string[];
  // Which table the row came from — instances are the user's saved plans,
  // templates are public catalog entries.
  source: "instance" | "template";
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  isActiveThisWeek: boolean;
  // WS9 3d Part 3b — the instance's backing template id, powering the plan-card
  // "⋯ → Use again" copy. Null for template rows (they have their own Use-Plan
  // flow) and for template-less instances (an empty POST /plans), which hides
  // the action.
  mealPlanTemplateId: string | null;
}

export interface PlanSummary {
  id: string;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  revisionId: number;
}

// WS7-4-D c16 — user-facing plan date fields cross the wire as calendar-date
// YYYY-MM-DD strings, symmetric with the write path (mobile emits YYYY-MM-DD
// to dodge toISOString TZ-shift; PATCH /plans/:id accepts it via planDateString
// per c11). Plan week boundaries are calendar dates per PRD §8 — moment-in-time
// ISO 8601 implies a precision the field doesn't carry. UTC extraction matches
// the store side, which canonicalizes via `new Date("YYYY-MM-DD")` (UTC midnight).
// Activity-event metadata stays ISO 8601 via isoOrNull in plans.ts — that path
// is a timestamped audit log, not a user-facing date.
export const toYmd = (d: Date | null): string | null => {
  if (!d) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

// Re-export the winner-id helper so route handlers have one import for
// "compute the resolver winner once for this request".
export { resolveThisWeekWinnerId };

// ── row shapes (structural — accept Prisma's superset results) ──────────

// WS7-6 (E) Block 1 REWORK: row shape no longer needs activatedAt for the
// list projection itself — the wire boolean is derived by comparing
// row.id against a pre-resolved winnerId. The caller (route handler)
// computes winnerId once per request via resolveThisWeekWinnerId and
// passes it to instanceToListItem. Memoization across the
// resolvePlansForFilter loop happens naturally — same winnerId reused.
export interface InstanceRow {
  id: string;
  titleOverride: string | null;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  revisionId: number;
  createdAt: Date;
  // WS9 3d Part 3b — returned by the unscoped my_plans findMany (all scalars);
  // powers the "⋯ → Use again" copy. Null on template-less instances.
  mealPlanTemplateId: string | null;
  template: {
    title: string;
    description: string | null;
    imageUrl: string | null;
    tags: string[];
  } | null;
}

interface TemplateRow {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  tags: string[];
}

// Prisma include/select fragments — exported so route handlers that load an
// instance for other reasons (e.g. GET /plans/:id) reuse the same projection.
export const INSTANCE_TEMPLATE_INCLUDE = {
  template: {
    select: { title: true, description: true, imageUrl: true, tags: true },
  },
} as const;

const TEMPLATE_SELECT = {
  id: true,
  title: true,
  description: true,
  imageUrl: true,
  tags: true,
} as const;

export function instanceToListItem(
  row: InstanceRow,
  winnerId: string | null,
): PlanListItem {
  return {
    id: row.id,
    name: row.titleOverride ?? row.template?.title ?? "",
    description: row.template?.description ?? null,
    image: row.template?.imageUrl ?? null,
    tags: row.template?.tags ?? [],
    source: "instance",
    status: row.status,
    startDate: toYmd(row.startDate),
    endDate: toYmd(row.endDate),
    isActiveThisWeek: winnerId !== null && row.id === winnerId,
    mealPlanTemplateId: row.mealPlanTemplateId,
  };
}

function templateToListItem(row: TemplateRow): PlanListItem {
  return {
    id: row.id,
    name: row.title,
    description: row.description,
    image: row.imageUrl,
    tags: row.tags,
    source: "template",
    status: null,
    startDate: null,
    endDate: null,
    isActiveThisWeek: false,
    // Template rows use the Use-Plan flow, not the "⋯ → Use again" copy.
    mealPlanTemplateId: null,
  };
}

export function instanceToSummary(row: InstanceRow): PlanSummary {
  return {
    id: row.id,
    name: row.titleOverride ?? row.template?.title ?? "",
    status: row.status,
    startDate: toYmd(row.startDate),
    endDate: toYmd(row.endDate),
    revisionId: row.revisionId,
  };
}

// Resolve a single filter key into PlanListItems. `limit` caps the row count
// (the /home discovery cards pass 5; /plans passes its page size).
//
// WS7-6 (E) Block 1 REWORK: `winnerId` is pre-computed once per request by
// the route handler via resolveThisWeekWinnerId and threaded through so
// the multi-filter loop does NOT re-query for each filter key. Pass null
// when no plan covers `now` (template filters ignore winnerId — templates
// are never "this week").
export async function resolvePlansForFilter(
  prisma: PrismaClient,
  filter: PlanFilterKey,
  userId: string,
  now: Date,
  limit: number,
  winnerId: string | null,
): Promise<PlanListItem[]> {
  if (filter === "my_plans") {
    // WS7-4-C c7: exclude soft-deleted (composted) plans. MealPlanInstance
    // gained isArchived as part of the soft-delete model; my_plans now
    // mirrors the same isArchived: false gate used for the template tables.
    //
    // WS7-4-D c12 audit: every Use-This-Plan tap creates a new Instance and
    // demote-prior-actives only flips isActiveThisWeek (status is orthogonal
    // per Q-P1-6). Three taps on the same Template -> three rows here. See
    // D-WS7-058 for the UX-grouping decision (collapse duplicates, filter to
    // active+upcoming only, or leave as-is).
    //
    // WS7-5a: exclude wizard pre-save drafts. Branch B of the two-step
    // wizard commit model writes a hidden MealPlanInstance on "View plan"
    // so an abandoned-but-liked plan can be resumed (GET /wizard/drafts);
    // it must NOT appear in the user's general plan list until "Save and
    // use" flips isWizardDraft -> false.
    const rows = (await prisma.mealPlanInstance.findMany({
      where: { userId, isArchived: false, isWizardDraft: false },
      include: INSTANCE_TEMPLATE_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: limit,
    })) as InstanceRow[];
    return rows.map((r) => instanceToListItem(r, winnerId));
  }

  if (filter === "featured" || filter === "hosting_events") {
    const where: Prisma.MealPlanTemplateWhereInput = {
      isPublic: true,
      isArchived: false,
      ...(filter === "featured"
        ? featuredWhere(now)
        : hostingFeaturedWhere(now)),
    };
    const rows = (await prisma.mealPlanTemplate.findMany({
      where,
      select: TEMPLATE_SELECT,
      orderBy: { createdAt: "desc" },
      take: limit,
    })) as TemplateRow[];
    return rows.map(templateToListItem);
  }

  // top_rated — order by the cached score, NULLS LAST, then useCount as the
  // tie-break while topRatedScore is still being populated by WS7-4/WS7-5.
  const settings = await getTopRatedSettings(prisma);
  const rows = (await prisma.mealPlanTemplate.findMany({
    where: { isPublic: true, isArchived: false },
    select: TEMPLATE_SELECT,
    orderBy: [
      { topRatedScore: { sort: "desc", nulls: "last" } },
      { useCount: "desc" },
      { createdAt: "desc" },
    ],
    take: Math.min(limit, settings.displayCount),
  })) as TemplateRow[];
  return rows.map(templateToListItem);
}
