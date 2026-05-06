// Shared dish-list sort helper. Lives in components/ alongside
// mealSort.ts so it can import SortKey from SortDropdown without
// inverting layering.

import type { SortKey } from "@/components/SortDropdown";
import type { SavedDish } from "@/lib/types";

// Fallbacks for SavedDish optional sort fields keep the helper
// tolerant of legacy stub rows that predate the fields.
const FALLBACK_DATE = "1970-01-01T00:00:00.000Z";

export function sortDishes(list: SavedDish[], key: SortKey): SavedDish[] {
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
      // Dishes are sorted by mealUseCount (number of saved meals
      // containing the dish), not literal cook count. SortKey union
      // is shared with meals; the SortDropdown surface relabels this
      // to "Most used" in dish contexts via labelOverrides.
      out.sort((a, b) => b.mealUseCount - a.mealUseCount);
      return out;
    case "date_created":
      out.sort((a, b) =>
        (b.createdAt ?? FALLBACK_DATE).localeCompare(
          a.createdAt ?? FALLBACK_DATE,
        ),
      );
      return out;
    case "alpha":
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    case "cook_time":
      out.sort(
        (a, b) =>
          (a.estimatedTimeMinutes ?? 0) - (b.estimatedTimeMinutes ?? 0),
      );
      return out;
  }
  return out;
}
