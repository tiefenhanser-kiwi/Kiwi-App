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
import { isInstanceActiveThisWeek } from "./planDates";
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

// ── row shapes (structural — accept Prisma's superset results) ──────────

// WS7-6 (E): isActiveThisWeek dropped from the row shape; it is computed
// from startDate/endDate via isInstanceActiveThisWeek at projection time
// (instanceToListItem) so the wire shape still ships a boolean.
export interface InstanceRow {
  id: string;
  titleOverride: string | null;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  revisionId: number;
  createdAt: Date;
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
  now: Date = new Date(),
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
    isActiveThisWeek: isInstanceActiveThisWeek(row, now),
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
export async function resolvePlansForFilter(
  prisma: PrismaClient,
  filter: PlanFilterKey,
  userId: string,
  now: Date,
  limit: number,
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
    return rows.map((r) => instanceToListItem(r, now));
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
