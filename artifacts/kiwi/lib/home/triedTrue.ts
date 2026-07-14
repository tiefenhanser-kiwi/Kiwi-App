// WS9 Block 3a — Tried & True rail model (net-new). The rail is the Take lane:
// publisher/featured discovery plans, Hosting & Events leading.
//
// Ordering is the SCREEN's job (the TriedTrueCard is deliberately dumb). We lead
// with Hosting & Events, then Featured, then Top Rated — i.e. TRIED_TRUE_BADGES
// order. The mockup's "seasonally nearest occasion first" is NOT honored: no
// occasion/seasonal date model exists on PlanListItem, so a real seasonal sort
// can't be built without faking it (D-WS9-027 — deferred to Hosting & Events).
//
// Reduced meta (D-WS9-027): the mockup's "★ 4.8 · 2.1k cooks" / "serves 12 · by
// Kiwi Kitchen" fields DON'T exist on PlanListItem — ratings/cook-counts are
// WS7-11's schema (sequenced right after WS9; the rail self-enriches then).
// Until then meta falls back to the plan's first tag, else nothing.

import type { PlanFilterKey, PlanListItem } from "@/lib/api/plans";

// Hosting leads (spec §5.1). All three are public-catalog badges → template
// rows, so the rail's tap uniformly opens the template-preview flow.
export const TRIED_TRUE_BADGES: readonly PlanFilterKey[] = [
  "hosting_events",
  "featured",
  "top_rated",
];

const OCCASION_LABEL: Record<string, string> = {
  hosting_events: "Hosting",
  featured: "Featured",
  top_rated: "Top Rated",
  my_plans: "My Plans",
};

export interface TriedTrueItem {
  id: string;
  occasion: string;
  title: string;
  image: string | null;
  meta: string | null;
}

// Flatten per-badge plan lists into ordered rail items. Badge order = lead
// order (Hosting first). Dedup by plan id across badges (first badge wins, so a
// plan that is both Hosting and Featured shows as Hosting). `perBadgeLimit`
// caps each badge's contribution so one badge can't dominate the rail.
export function buildTriedTrueRail(
  byBadge: { badge: PlanFilterKey; plans: readonly PlanListItem[] }[],
  perBadgeLimit = 4,
): TriedTrueItem[] {
  const seen = new Set<string>();
  const items: TriedTrueItem[] = [];
  for (const { badge, plans } of byBadge) {
    let taken = 0;
    for (const p of plans) {
      if (taken >= perBadgeLimit) break;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      items.push({
        id: p.id,
        occasion: OCCASION_LABEL[badge] ?? badge,
        title: p.name,
        image: p.image,
        meta: p.tags[0] ?? null,
      });
      taken += 1;
    }
  }
  return items;
}
