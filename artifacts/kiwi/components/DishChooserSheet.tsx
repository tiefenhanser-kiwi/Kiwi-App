// WS7-6 C-fix Block 4 — Meal→Add-Dish sheet container.
//
// Wires the real /me/dishes catalog (the same shared `useDishes` infinite hook
// Recipes→Dishes and the Mode-C picker use) and adapts wire rows → SavedDish
// via the shared adapter, then hands everything to the presentational
// DishChooserSheetView. The stub `getSavedDishes()` + client-side sort the
// sheet used pre-Block-4 are gone; the sheet's SortDropdown now drives the
// SERVER ?sort= param.

import React, { useMemo, useState } from "react";

import {
  DishChooserSheetView,
  type DishChooserSheetProps,
} from "@/components/DishChooserSheetView";
import { type SortKey } from "@/components/SortDropdown";
import { useDishes } from "@/hooks/useDishes";
import { savedDishFromListItem } from "@/lib/dishes/savedDishFromListItem";
import { toDishSortKey } from "@/lib/dishes/sortMapping";
import type { SavedDish } from "@/lib/types";

export type { DishChooserSheetProps } from "@/components/DishChooserSheetView";

export function DishChooserSheet(props: DishChooserSheetProps) {
  // PRD: A-Z is the default sort across all sortable surfaces.
  const [sortKey, setSortKey] = useState<SortKey>("alpha");
  const dishesQuery = useDishes(["my_dishes"], toDishSortKey(sortKey));

  const dishes = useMemo<SavedDish[]>(
    () => dishesQuery.dishes.map(savedDishFromListItem),
    [dishesQuery.dishes],
  );

  return (
    <DishChooserSheetView
      {...props}
      dishes={dishes}
      sortKey={sortKey}
      onSortChange={setSortKey}
      dishesLoading={dishesQuery.isLoading}
      dishesError={dishesQuery.isError}
      hasNextPage={!!dishesQuery.hasNextPage}
      isFetchingNextPage={dishesQuery.isFetchingNextPage}
      onEndReached={() => {
        if (dishesQuery.hasNextPage && !dishesQuery.isFetchingNextPage) {
          void dishesQuery.fetchNextPage();
        }
      }}
      onRetryDishes={() => void dishesQuery.refetch()}
    />
  );
}
