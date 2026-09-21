// Row 8 — the measured grocery list, as a fixture: 60 rows, all unchecked,
// 7 universal staples of which ONE is opted in. R1 sends 54; the six
// not-opted-in staples stay home. Lifted out of instacartOrder.test.ts in
// Block 3 Part D so the panel test renders the count line off the SAME rows
// the selection test counts.

import type { GroceryListItem } from "@/lib/types";

export function row(over: Partial<GroceryListItem> & { id: string }): GroceryListItem {
  return {
    name: over.id,
    quantity: "1",
    quantityAmount: "1",
    quantityUnit: "each",
    sectionKey: "produce",
    isUniversalStaple: false,
    stapleOptedIn: false,
    isRecurringItem: false,
    isAmbiguous: false,
    isOptional: false,
    isCompleted: false,
    ...over,
  };
}

export const NOT_OPTED_STAPLES = [
  "kosher salt",
  "black pepper",
  "olive oil",
  "all-purpose flour",
  "sugar",
  "soy sauce",
];

export function measuredList(): GroceryListItem[] {
  return [
    ...NOT_OPTED_STAPLES.map((name) =>
      row({
        id: `staple-${name}`,
        name,
        isUniversalStaple: true,
        stapleOptedIn: false,
        purchaseUnit: "container",
        purchaseDisplay: "1 container (26 oz)",
      }),
    ),
    row({
      id: "staple-butter",
      name: "butter",
      isUniversalStaple: true,
      stapleOptedIn: true,
      purchaseUnit: "lb",
      purchaseDisplay: "1 lb",
    }),
    ...Array.from({ length: 53 }, (_, i) =>
      row({ id: `r${String(i + 1).padStart(2, "0")}`, name: `item ${i + 1}` }),
    ),
  ];
}
