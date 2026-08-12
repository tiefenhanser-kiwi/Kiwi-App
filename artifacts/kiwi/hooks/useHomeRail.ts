// WS9-2 2c (D-WS9-154) — React Query hook for GET /home/rail.
//
// Replaces the three usePlans(["hosting_events"]) / (["featured"]) /
// (["top_rated"]) calls the rail used to make. Home now issues TWO plan-ish
// reads, not one: this, plus usePlans(["my_plans"]) at index.tsx, which is NOT
// part of the rail — it feeds resolveGroceryRoute's no-active-plan fallback.
//
// Query key ["home", "rail"] sits under the same "home" prefix as
// useHomePayload, so an invalidation of ["home"] refreshes both.
//
// NOTE the cache-warming this gives up: the old three-query shape shared its
// React Query cache with the Plans tab's Featured / Top Rated / Hosting & Events
// chips (same ["plans","list",filter] keys), so those chips used to render
// instantly on first tap. They now fetch on tap like any other chip. Nothing
// breaks — plans.tsx issues its own query — but the first tap shows a spinner
// where it previously did not.

import { useQuery } from "@tanstack/react-query";

import { getHomeRail, type RailPlanItem } from "@/lib/api/home";

export function useHomeRail() {
  return useQuery<RailPlanItem[]>({
    queryKey: ["home", "rail"],
    queryFn: getHomeRail,
  });
}
