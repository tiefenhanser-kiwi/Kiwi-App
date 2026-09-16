// WS9 Redesign Arc Block 1 (D-WS9-245) — "new to you". There is no column for
// it; a catalog meal is FAMILIAR to a user when one of the user's own meals
// that has been in a plan carries it as lineage (`sourceStoreMealId`, the
// D-WS7-139 fork stamp) — with a title-match fallback for live-built meals
// that never had lineage. The shape buildRecentRotation (planningContext.ts)
// already uses, applied to the whole plan history rather than the last three.
//
// ⚠️ NOT cook history. `hiddenContext.recentMealIds` is fed from `cook_meal`
// activities that are never emitted (BUG-275), so "served" here means "was in
// a plan the user kept", the only signal that exists.

import type { PrismaClient } from "@prisma/client";

export interface CatalogRef {
  id: string;
  title: string;
}

/**
 * The subset of `catalog` ids this user has already been served. Batch: one
 * query for the whole list. Titles compare case-insensitively after trim.
 */
export async function servedCatalogIds(
  prisma: Pick<PrismaClient, "meal">,
  userId: string,
  catalog: CatalogRef[],
): Promise<Set<string>> {
  if (catalog.length === 0) return new Set();
  const ids = catalog.map((c) => c.id);
  const titles = [...new Set(catalog.map((c) => c.title.trim()))];
  const own = await prisma.meal.findMany({
    where: {
      userId,
      planItems: { some: {} },
      OR: [
        { sourceStoreMealId: { in: ids } },
        { title: { in: titles, mode: "insensitive" } },
      ],
    },
    select: { sourceStoreMealId: true, title: true },
  });
  const servedSources = new Set<string>();
  const servedTitles = new Set<string>();
  for (const m of own) {
    if (m.sourceStoreMealId) servedSources.add(m.sourceStoreMealId);
    servedTitles.add(m.title.trim().toLowerCase());
  }
  const served = new Set<string>();
  for (const c of catalog) {
    if (servedSources.has(c.id) || servedTitles.has(c.title.trim().toLowerCase())) {
      served.add(c.id);
    }
  }
  return served;
}
