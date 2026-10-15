// BOOK-1C1 (D-WS9-312) — one saved state for every heart.
//
// The heart reads from two caches: meal detail and the old favorites facade
// read ["me","favorites"] (a list of meal ids), and a Cookbook card reads the
// server's `isSaved` on its page in ["cookbook","meals",…]. AppContext.setSaved
// writes BOTH optimistically, so a heart flipped on one surface shows flipped
// on the other without a refetch. This file is the pure half: how a Cookbook
// page chain is patched.

/** The infinite-query data shape the Cookbook list caches. */
export interface CookbookPagesLike<M extends { id: string; isSaved: boolean }> {
  pages: Array<{ meals: M[] } & Record<string, unknown>>;
  pageParams: unknown[];
}

/**
 * Set `isSaved` on every card for `mealId` across the loaded pages. Returns the
 * input unchanged (same reference) when no card matched, so React Query does
 * not re-render a list the change does not touch.
 */
export function patchSavedInPages<M extends { id: string; isSaved: boolean }>(
  data: CookbookPagesLike<M> | undefined,
  mealId: string,
  saved: boolean,
): CookbookPagesLike<M> | undefined {
  if (!data) return data;
  let touched = false;
  const pages = data.pages.map((page) => {
    if (!page.meals.some((m) => m.id === mealId && m.isSaved !== saved)) return page;
    touched = true;
    return {
      ...page,
      meals: page.meals.map((m) => (m.id === mealId ? { ...m, isSaved: saved } : m)),
    };
  });
  return touched ? { ...data, pages } : data;
}

/** The favorites id list with `mealId` set to `saved`. */
export function withFavorite(ids: readonly string[], mealId: string, saved: boolean): string[] {
  const without = ids.filter((id) => id !== mealId);
  return saved ? [...without, mealId] : without;
}
