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

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// ── row shapes (structural — accept Prisma's superset results) ──────────

export interface InstanceRow {
  id: string;
  titleOverride: string | null;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  isActiveThisWeek: boolean;
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

export function instanceToListItem(row: InstanceRow): PlanListItem {
  return {
    id: row.id,
    name: row.titleOverride ?? row.template?.title ?? "",
    description: row.template?.description ?? null,
    image: row.template?.imageUrl ?? null,
    tags: row.template?.tags ?? [],
    source: "instance",
    status: row.status,
    startDate: iso(row.startDate),
    endDate: iso(row.endDate),
    isActiveThisWeek: row.isActiveThisWeek,
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
    startDate: iso(row.startDate),
    endDate: iso(row.endDate),
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
    // NOTE: MealPlanInstance has no isArchived column, so `my_plans` filters
    // by ownership only. See WS7-3 A2 Phase 3 report §8 (F-A2-3).
    const rows = (await prisma.mealPlanInstance.findMany({
      where: { userId },
      include: INSTANCE_TEMPLATE_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: limit,
    })) as InstanceRow[];
    return rows.map(instanceToListItem);
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
