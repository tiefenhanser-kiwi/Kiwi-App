// Shared meal-list sort helper for picker sheets (ChangeMealSheet,
// FindSimilarSheet, AddMealsSheet). Lives in components/ so it can
// import SortKey from SortDropdown without inverting layering.

import type { SortKey } from "@/components/SortDropdown";
import type { MealSummary } from "@/lib/types";

const FALLBACK_DATE = "1970-01-01T00:00:00.000Z";

export function sortMeals(list: MealSummary[], key: SortKey): MealSummary[] {
  const out = [...list];
  switch (key) {
    case "last_cooked":
      out.sort((a, b) => {
        const av = a.lastCookedAt ?? "";
        const bv = b.lastCookedAt ?? "";
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return bv.localeCompare(av);
      });
      return out;
    case "times_cooked":
      out.sort((a, b) => (b.timesCooked ?? 0) - (a.timesCooked ?? 0));
      return out;
    case "date_created":
      out.sort((a, b) =>
        (b.createdAt ?? FALLBACK_DATE).localeCompare(
          a.createdAt ?? FALLBACK_DATE,
        ),
      );
      return out;
    case "alpha":
      out.sort((a, b) => a.title.localeCompare(b.title));
      return out;
    case "cook_time":
      out.sort((a, b) => a.estimatedTimeMinutes - b.estimatedTimeMinutes);
      return out;
  }
  return out;
}
