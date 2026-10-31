// CLIENT-9 E (BUG-467) — All Your Plans: the Plans tab pages through every plan.
//
// GET /plans pages by cursor (SERVER-13 B: the user's own plans in the database,
// newest first, no cap; before it each filter was fetched `take: 100`, so plan 101
// on was unreachable). The tab keeps an infinite query of pages
// (hooks/usePlanPages.ts) and asks for the next one as the list nears its end.
// `?q=` is searched server side, over every plan, instead of filtering page one.
//
// Pure and in lib/ because app/** is outside the test glob (D-WS9-164).

import type { PlanListItem, PlanListResponse } from "../api/plans";

/** The page size the Plans tab asks for (the server's default, said out loud). */
export const PLAN_PAGE_SIZE = 20;

/** Every loaded page's plans in server order, each plan once (a row seen on an
 *  earlier page wins: the server's facets are de-duplicated across a seam, but a
 *  plan created between two reads must not show twice). */
export function flattenPlanPages(pages: readonly PlanListResponse[] | undefined): PlanListItem[] {
  const seen = new Set<string>();
  const out: PlanListItem[] = [];
  for (const page of pages ?? []) {
    for (const p of page.plans) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

/** How close to the end (px) the list asks for the next page. */
export const LOAD_MORE_THRESHOLD = 600;

/**
 * True when the visible window is within `threshold` of the content's end. Also
 * true when the content does not fill the window at all, so a short first page
 * (or a tall web window) still loads the next one with no scroll to fire.
 */
export function nearListEnd(
  m: { contentHeight: number; viewportHeight: number; offsetY: number },
  threshold = LOAD_MORE_THRESHOLD,
): boolean {
  if (!(m.contentHeight > 0) || !(m.viewportHeight > 0)) return false;
  return m.offsetY + m.viewportHeight >= m.contentHeight - threshold;
}

/** The trimmed search sent as `?q=`; empty means no search. */
export function planSearchParam(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}
