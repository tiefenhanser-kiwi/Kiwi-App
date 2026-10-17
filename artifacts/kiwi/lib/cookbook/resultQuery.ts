// BOOK-1C2 (item 3) — the Cookbook's two React Query reads as plain option
// objects, and the one rule for when a number on screen is final.
//
// Hans set Mexican + ≤30 + hands-on, saw "1 meal", set hands-on back to Any and
// STILL saw "1 meal" until 39 loaded. Nothing overwrote anything: every filter
// set is its own cache entry (the query string IS the key), so a late response
// for old filters lands in the old entry and never reaches the screen. What he
// saw was the previous filters' total held on screen (keepPreviousData, which
// stops the list flashing empty between filter sets) and presented as if it
// were the answer. Two fixes, both here:
//   • `cookbookResultView` — a held result is UPDATING, not final; the screen
//     dims the cards, dims the count and shows a spinner beside it (the sheet's
//     "Show N meals" too) until the new filters' own response lands;
//   • the AbortSignal reaches fetch, so React Query cancels the request for
//     filters the user has already left (it does that only when the signal is
//     read) instead of letting a stale request queue ahead of the live one.
//
// The hooks (hooks/useCookbook.ts) are these options and nothing else, so the
// test drives the real keys through a real QueryClient
// (lib/cookbook/__tests__/resultQuery.test.ts).

import { keepPreviousData } from "@tanstack/react-query";

import type { CookbookPage } from "@/lib/api/cookbook";

/** A browse is a read of the public catalog: a minute is fresh enough. */
export const COOKBOOK_STALE_MS = 60_000;

export type FetchCookbookPage = (queryString: string, signal?: AbortSignal) => Promise<CookbookPage>;

/** ["cookbook","meals",<queryString>] — AppContext.setSaved patches this prefix. */
export function cookbookMealsKey(base: string) {
  return ["cookbook", "meals", base] as const;
}

/** ["cookbook","count",<queryString>] — the sheet's "Show N meals". */
export function cookbookCountKey(qs: string) {
  return ["cookbook", "count", qs] as const;
}

/** The infinite result list for one filter set (`base` = buildCookbookQuery, no cursor). */
export function cookbookMealsOptions(base: string, fetchPage: FetchCookbookPage) {
  return {
    queryKey: cookbookMealsKey(base),
    queryFn: ({ pageParam, signal }: { pageParam: unknown; signal: AbortSignal }) => {
      const cursor = pageParam as string | undefined;
      return fetchPage(cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base, signal);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CookbookPage) => last.nextCursor ?? undefined,
    staleTime: COOKBOOK_STALE_MS,
    // Keep the last result on screen while the next filter set loads instead
    // of flashing empty — and say so (cookbookResultView), never as final.
    placeholderData: keepPreviousData,
  };
}

/** The total a filter set WOULD show (a limit-1 read). */
export function cookbookCountOptions(qs: string, fetchPage: FetchCookbookPage) {
  return {
    queryKey: cookbookCountKey(qs),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchPage(qs, signal),
    select: (page: CookbookPage) => page.total,
    staleTime: COOKBOOK_STALE_MS,
    placeholderData: keepPreviousData,
  };
}

export interface CookbookResultView {
  /** The number to print, or null before anything has loaded. */
  total: number | null;
  /**
   * True while what is on screen belongs to filters the user has left: dim
   * it, show the spinner, and never read the number as the answer.
   */
  updating: boolean;
}

/** What a result list or a count may claim, from its query state. */
export function cookbookResultView(state: {
  total: number | null | undefined;
  isPlaceholderData: boolean;
}): CookbookResultView {
  return { total: state.total ?? null, updating: state.isPlaceholderData };
}
