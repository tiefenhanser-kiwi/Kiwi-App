// WS7-3 Block C3 Commit 2 — per-chip empty-state copy for the Dishes sub-tab.
// Pure 3-way switch matching the Meals tone (D1).

import type { DishFilterKey } from "@/lib/api/dishes";

const COPY: Record<DishFilterKey, string> = {
  my_dishes:
    "Your dishes show up here. Add one with + Add Dish, or browse Featured to get started.",
  featured:
    "No featured dishes yet — Kiwi's catalog is still growing. Add your own with + Add Dish, or check My Dishes.",
  top_rated:
    "No top-rated dishes yet — favorites show up here as the Kiwi community starts cooking. Add your own with + Add Dish.",
};

export function dishesEmptyCopy(chip: DishFilterKey): string {
  return COPY[chip];
}
