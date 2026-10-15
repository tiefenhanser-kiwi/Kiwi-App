// BOOK-1C1 (D-WS9-312) — React Query hooks for the in-app Cookbook.
//
// Keys live under ["cookbook", …]:
//   ["cookbook","meals",<queryString>]   the infinite result list
//   ["cookbook","count",<queryString>]   the filter sheet's "Show N meals"
//   ["cookbook","seasons"]               the live seasonal collections
// The query string (lib/cookbook/query.ts) is the whole request, so equal
// filters share a cache entry. AppContext.setSaved patches ["cookbook","meals"]
// when a heart flips anywhere in the app.

import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { getCookbookSeasons, searchCookbook, type CookbookMeal, type CookbookPage } from "@/lib/api/cookbook";
import {
  buildCookbookQuery,
  COOKBOOK_PAGE_SIZE,
  type CookbookQueryInput,
} from "@/lib/cookbook/query";

/** A browse is a read of the public catalog: a minute is fresh enough. */
const COOKBOOK_STALE_MS = 60_000;

export function useCookbookMeals(input: Omit<CookbookQueryInput, "cursor" | "limit">) {
  const base = buildCookbookQuery({ ...input, limit: COOKBOOK_PAGE_SIZE });
  const query = useInfiniteQuery<CookbookPage>({
    queryKey: ["cookbook", "meals", base],
    queryFn: ({ pageParam }) => {
      const cursor = pageParam as string | undefined;
      return searchCookbook(cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: COOKBOOK_STALE_MS,
    // Typing in the search box swaps the key every debounce; keep the last
    // result on screen until the new one lands instead of flashing empty.
    placeholderData: keepPreviousData,
  });

  const meals = useMemo<CookbookMeal[]>(
    () => query.data?.pages.flatMap((p) => p.meals) ?? [],
    [query.data],
  );
  const first = query.data?.pages[0];
  return { ...query, meals, total: first?.total ?? null, facets: first?.facets ?? null };
}

/** The total a filter set WOULD show — the sheet's "Show N meals" (limit 1). */
export function useCookbookCount(input: Omit<CookbookQueryInput, "cursor" | "limit">, enabled: boolean) {
  const qs = buildCookbookQuery({ ...input, limit: 1 });
  return useQuery({
    queryKey: ["cookbook", "count", qs],
    queryFn: () => searchCookbook(qs),
    select: (page) => page.total,
    enabled,
    staleTime: COOKBOOK_STALE_MS,
    placeholderData: keepPreviousData,
  });
}

export function useCookbookSeasons() {
  return useQuery({
    queryKey: ["cookbook", "seasons"],
    queryFn: getCookbookSeasons,
    staleTime: COOKBOOK_STALE_MS,
  });
}
