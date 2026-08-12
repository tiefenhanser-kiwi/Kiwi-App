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

// WS9-2 2c Commit 1 — the select↔row-shape guard.
//
// Dropping a column from one of these projections while a shared mapper still
// reads it is the BUG-068 / BUG-076 / BUG-083 defect class: it typechecks, CI
// stays green, and the field silently vanishes in production. Removing the old
// `as TemplateRow[]` assertions was NOT enough on its own — `rows.map(mapper)`
// checks the callback's parameter BIVARIANTLY (Array.map is method-declared in
// lib.es5.d.ts), so a narrower row type still slides into a wider mapper param.
// Verified empirically: commenting out `imageUrl` below with the assertions
// already gone still compiled clean.
//
// `satisfies Record<keyof XRow, true>` closes it directly — the select must name
// EVERY key its row type declares, so a dropped column is a compile error at the
// projection itself, which is where the mistake is actually made. The call sites
// additionally arrow-wrap their mappers so the row→mapper hop is checked
// strictly rather than bivariantly. Both guards are cheap; keep both.
//
// ⚠️ The Tried & True rail's images ride TEMPLATE_SELECT.imageUrl through eight
// hops; this is hop 1. Do not replace it with a fresh inline select.
type SelectFor<Row> = Record<keyof Row, true>;

// Prisma include/select fragments — exported so route handlers that load an
// instance for other reasons (e.g. GET /plans/:id) reuse the same projection.
export const INSTANCE_TEMPLATE_INCLUDE = {
  template: {
    select: {
      title: true,
      description: true,
      imageUrl: true,
      tags: true,
    } satisfies SelectFor<NonNullable<InstanceRow["template"]>>,
  },
} as const;

const TEMPLATE_SELECT = {
  id: true,
  title: true,
  description: true,
  imageUrl: true,
  tags: true,
} satisfies SelectFor<TemplateRow>;

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
    // WS9-2 2c Commit 1 — NO `as InstanceRow[]` assertion. Prisma's inferred
    // row type flows straight into instanceToListItem, so dropping a field from
    // INSTANCE_TEMPLATE_INCLUDE becomes a COMPILE error instead of an
    // undefined at runtime (the BUG-068/076 defect class).
    const rows = await prisma.mealPlanInstance.findMany({
      where: { userId, isArchived: false, isWizardDraft: false },
      include: INSTANCE_TEMPLATE_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
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
    // WS9-2 2c Commit 1 — NO `as TemplateRow[]` assertion (see my_plans above).
    // TEMPLATE_SELECT is the single source of the projection; an inline select
    // that omitted `imageUrl` here would now fail to typecheck against
    // templateToListItem instead of silently blanking the Tried & True rail.
    const rows = await prisma.mealPlanTemplate.findMany({
      where,
      select: TEMPLATE_SELECT,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    // Arrow-wrapped so the row→mapper hop is a strict call check, not Array.map's
    // bivariant callback check (see the SelectFor guard above).
    return rows.map((r) => templateToListItem(r));
  }

  // top_rated — order by the cached score, NULLS LAST, then useCount as the
  // tie-break while topRatedScore is still being populated by WS7-4/WS7-5.
  const settings = await getTopRatedSettings(prisma);
  // WS9-2 2c Commit 1 — NO `as TemplateRow[]` assertion (see above).
  const rows = await prisma.mealPlanTemplate.findMany({
    where: { isPublic: true, isArchived: false },
    select: TEMPLATE_SELECT,
    orderBy: [
      { topRatedScore: { sort: "desc", nulls: "last" } },
      { useCount: "desc" },
      { createdAt: "desc" },
    ],
    take: Math.min(limit, settings.displayCount),
  });
  return rows.map(templateToListItem);
}
