// WS7-3 Block C3 Commit 1 — per-chip empty-state copy for the Meals sub-tab
// (Phase 2 Ruling D1). Pure 4-way switch so the meals screen has no inline
// magic strings and the copy unit-tests cheaply.

import type { MealFilterKey } from "@/lib/api/meals";

const COPY: Record<MealFilterKey, string> = {
  my_meals:
    "Your meals show up here. Add one with + Add Meal, or browse Featured to get started.",
  featured:
    "No featured meals yet — Kiwi's catalog is still growing. Add your own with + Add Meal, or check My Meals.",
  top_rated:
    "No top-rated meals yet — favorites show up here as the Kiwi community starts cooking. Add your own with + Add Meal.",
  hosting:
    "No hosting & events meals yet — Kiwi's hosting catalog is still growing. Add your own with + Add Meal.",
};

export function mealsEmptyCopy(chip: MealFilterKey): string {
  return COPY[chip];
}
