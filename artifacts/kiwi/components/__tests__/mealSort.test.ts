// WS9 3f-4d Part 1c (BUG-067) — the A–Z sort must order by the STRING THE USER
// SEES (displayTitle ?? title), not the canonical title. These tests pin that the
// alpha sort keys off resolveDisplayTitle, so a short display name reorders the
// list away from raw-title order.

import assert from "node:assert/strict";
import { test } from "node:test";

import { sortMeals } from "../mealSort";
import type { MealSummary } from "@/lib/types";

function meal(over: Partial<MealSummary> & { id: string; title: string }): MealSummary {
  return {
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    servingsDefault: 4,
    caloriesPerServing: 0,
    proteinGPerServing: 0,
    carbsGPerServing: 0,
    fatGPerServing: 0,
    source: "saved",
    ...over,
  };
}

test("BUG-067: alpha sort orders by displayTitle when present, not title", () => {
  // Title order (Apple… < Zebra…) is the OPPOSITE of displayTitle order
  // (Apple Pie < Zucchini Bread), so a title-keyed sort and a displayTitle-keyed
  // sort produce different orderings — this distinguishes the two.
  const a = meal({ id: "a", title: "Zebra-Named Casserole with Everything", displayTitle: "Apple Pie" });
  const b = meal({ id: "b", title: "Apple-Named Bake with Everything", displayTitle: "Zucchini Bread" });

  const sorted = sortMeals([b, a], "alpha");
  assert.deepEqual(
    sorted.map((m) => m.id),
    ["a", "b"],
    "ordered by displayTitle (Apple Pie < Zucchini Bread), not by title",
  );
});

test("BUG-067: alpha sort falls back to title when displayTitle is absent", () => {
  const a = meal({ id: "a", title: "Apple Bake" });
  const b = meal({ id: "b", title: "Zebra Bake" });

  const sorted = sortMeals([b, a], "alpha");
  assert.deepEqual(sorted.map((m) => m.id), ["a", "b"], "falls back to title order");
});
