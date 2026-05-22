// React Query hook for GET /grocery-lists — the Grocery Lists screen read.
// WS7-3 Block C1: API + hook foundation; the screen migrates in a later
// C-block.
//
// Query key ["groceries", "list", <filter>] — the active/past filter is part
// of the key. staleTime uses the global personal-mutable default (60_000).

import { useQuery } from "@tanstack/react-query";

import {
  getGroceryLists,
  type GroceryListFilterKey,
  type GroceryListListItem,
} from "@/lib/api/groceries";

export function useGroceryLists(filter?: GroceryListFilterKey) {
  return useQuery<GroceryListListItem[]>({
    queryKey: ["groceries", "list", filter ?? null],
    queryFn: () => getGroceryLists(filter),
  });
}
