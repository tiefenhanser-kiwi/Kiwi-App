// BOOK-1C1 (D-WS9-312) — React Query hooks for the in-app Cookbook.
//
// Keys live under ["cookbook", …]:
//   ["cookbook","meals",<queryString>]   the infinite result list
//   ["cookbook","count",<queryString>]   the filter sheet's "Show N meals"
//   ["cookbook","seasons"]               the live seasonal collections
// The query string (lib/cookbook/query.ts) is the whole request, so equal
// filters share a cache entry. AppContext.setSaved patches ["cookbook","meals"]
// when a heart flips anywhere in the app.
//
// BOOK-1C2 — the two filter reads are lib/cookbook/resultQuery.ts's options
// (tested there against a real QueryClient), and each hook also says whether
// what it holds is UPDATING: the previous filters' result kept on screen while
// the new filters load, which the screen dims rather than presents as final.

import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { getCookbookSeasons, searchCookbook, type CookbookMeal, type CookbookPage } from "@/lib/api/cookbook";
import {
  buildCookbookQuery,
  COOKBOOK_PAGE_SIZE,
  type CookbookQueryInput,
} from "@/lib/cookbook/query";
import {
  COOKBOOK_STALE_MS,
  cookbookCountOptions,
  cookbookMealsOptions,
  cookbookResultView,
} from "@/lib/cookbook/resultQuery";

export function useCookbookMeals(input: Omit<CookbookQueryInput, "cursor" | "limit">) {
  const base = buildCookbookQuery({ ...input, limit: COOKBOOK_PAGE_SIZE });
  const query = useInfiniteQuery<CookbookPage>(cookbookMealsOptions(base, searchCookbook));

  const meals = useMemo<CookbookMeal[]>(
    () => query.data?.pages.flatMap((p) => p.meals) ?? [],
    [query.data],
  );
  const first = query.data?.pages[0];
  const view = cookbookResultView({ total: first?.total, isPlaceholderData: query.isPlaceholderData });
  return { ...query, meals, total: view.total, updating: view.updating, facets: first?.facets ?? null };
}

/** The total a filter set WOULD show — the sheet's "Show N meals" (limit 1). */
export function useCookbookCount(input: Omit<CookbookQueryInput, "cursor" | "limit">, enabled: boolean) {
  const qs = buildCookbookQuery({ ...input, limit: 1 });
  const query = useQuery({ ...cookbookCountOptions(qs, searchCookbook), enabled });
  const view = cookbookResultView({ total: query.data, isPlaceholderData: query.isPlaceholderData });
  return { ...query, updating: view.updating };
}

export function useCookbookSeasons() {
  return useQuery({
    queryKey: ["cookbook", "seasons"],
    queryFn: getCookbookSeasons,
    staleTime: COOKBOOK_STALE_MS,
  });
}
