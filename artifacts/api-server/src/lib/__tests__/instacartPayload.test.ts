// Row 8 · Block 1 — R2 composition. One fixture list, every precedence step,
// literal expected line items.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  composeInstacartPayload,
  type InstacartRowInput,
} from "../retailers/instacartPayload";

function row(overrides: Partial<InstacartRowInput> & { id: string }): InstacartRowInput {
  return {
    displayName: "thing",
    userResolvedTo: null,
    quantity: 1,
    unit: "",
    deletedAt: null,
    purchaseQuantity: null,
    purchaseUnit: null,
    purchaseDisplay: null,
    purchaseUnitOverride: null,
    purchaseQuantityOverride: null,
    purchaseDisplayOverride: null,
    ...overrides,
  };
}

const ROWS: InstacartRowInput[] = [
  // step 1 — client pack data, countable, per-pack size 1
  row({
    id: "r-beans",
    displayName: "canned black beans",
    quantity: 30,
    unit: "ounce",
    purchaseQuantity: 1,
    purchaseUnit: "can",
    purchaseDisplay: "1 can (15 oz)",
  }),
  // step 1 — client pack data, weighed: 2 packs × 1.5 lb → 3 pound
  row({
    id: "r-turkey",
    displayName: "1.5 lb ground turkey",
    quantity: 2.5,
    unit: "pound",
    purchaseQuantity: 1.5,
    purchaseUnit: "lb",
    purchaseDisplay: "1.5 lb pack",
  }),
  // step 1 — client pack data on a "2 cans" row: 2 packs × 2 cans → 4 can
  row({
    id: "r-tomatoes",
    displayName: "diced tomatoes",
    quantity: 58,
    unit: "ounce",
    purchaseQuantity: 2,
    purchaseUnit: "can",
    purchaseDisplay: "2 cans (14.5 oz each)",
  }),
  // step 2 — the user's stated buy (override), with a display override
  row({
    id: "r-milk",
    displayName: "milk",
    userResolvedTo: "whole milk",
    quantity: 3,
    unit: "cup",
    purchaseQuantity: 1,
    purchaseUnit: "bottle",
    purchaseDisplay: "1 bottle (half gallon)",
    purchaseQuantityOverride: 2,
    purchaseUnitOverride: "carton",
    purchaseDisplayOverride: "2 cartons (1 gal)",
  }),
  // step 2 — override quantity only; the unit comes from the derived pack
  row({
    id: "r-beef",
    displayName: "ground beef (80/20 chuck)",
    quantity: 2,
    unit: "pound",
    purchaseQuantity: 1,
    purchaseUnit: "lb",
    purchaseDisplay: "1 lb",
    purchaseQuantityOverride: 3,
  }),
  // step 3 — the stored pack, container word → each, size stays in display_text
  row({
    id: "r-lemon",
    displayName: "1 bottle (15 oz) lemon juice",
    quantity: 2,
    unit: "tablespoon",
    purchaseQuantity: 1,
    purchaseUnit: "bottle",
    purchaseDisplay: "1 bottle (15 oz)",
  }),
  // step 3 — stored pack in dozen → 12 each
  row({
    id: "r-eggs",
    displayName: "eggs",
    quantity: 6,
    unit: "each",
    purchaseQuantity: 1,
    purchaseUnit: "dozen",
    purchaseDisplay: "1 dozen",
  }),
  // step 4 — no pack; the need unit is an order unit
  row({
    id: "r-cilantro",
    displayName: "cilantro, chopped",
    quantity: 1,
    unit: "bunch",
  }),
  // step 5 — no pack; need unit is a measure, not an order unit → 1 each
  row({
    id: "r-cumin",
    displayName: "ground cumin",
    quantity: 2,
    unit: "teaspoon",
  }),
  // step 5 — no pack; need unit has NO Instacart equivalent at all
  row({
    id: "r-garlic",
    displayName: "garlic, minced",
    quantity: 3,
    unit: "clove",
  }),
  // step 3 — stored pack whose unit is not in the table → each, unmapped
  row({
    id: "r-lasagna",
    displayName: "lasagna sheets",
    quantity: 12,
    unit: "each",
    purchaseQuantity: 1,
    purchaseUnit: "sheet",
    purchaseDisplay: "1 sheet",
  }),
  // soft-deleted
  row({
    id: "r-gone",
    displayName: "ghost",
    deletedAt: new Date("2026-09-19T00:00:00Z"),
  }),
];

describe("composeInstacartPayload — R2", () => {
  it("composes every precedence step, skips deleted, reports unmapped", () => {
    const result = composeInstacartPayload(
      ROWS,
      [
        { groceryListItemId: "r-beans", packCount: 2, packUnit: "can", packSizeText: "(15 oz)" },
        { groceryListItemId: "r-turkey", packCount: 2, packUnit: "lb" },
        { groceryListItemId: "r-tomatoes", packCount: 2, packUnit: "cans" },
        { groceryListItemId: "r-milk" },
        { groceryListItemId: "r-beef" },
        { groceryListItemId: "r-lemon" },
        { groceryListItemId: "r-eggs" },
        { groceryListItemId: "r-cilantro" },
        { groceryListItemId: "r-cumin" },
        { groceryListItemId: "r-garlic" },
        { groceryListItemId: "r-lasagna" },
        { groceryListItemId: "r-gone" },
        { groceryListItemId: "r-missing" },
        // duplicate id — composed once
        { groceryListItemId: "r-beans", packCount: 9 },
      ],
      { title: "Week of Sep 21" },
    );

    assert.deepEqual(result.payload, {
      title: "Week of Sep 21",
      link_type: "shopping_list",
      expires_in: 30,
      line_items: [
        {
          name: "canned black beans",
          quantity: 2,
          unit: "can",
          display_text: "2 can (15 oz) canned black beans",
          line_item_measurements: [{ quantity: 30, unit: "ounce" }],
        },
        {
          name: "ground turkey",
          quantity: 3,
          unit: "pound",
          display_text: "3 lb ground turkey",
          line_item_measurements: [{ quantity: 2.5, unit: "pound" }],
        },
        {
          name: "diced tomatoes",
          quantity: 4,
          unit: "can",
          display_text: "4 cans diced tomatoes",
          line_item_measurements: [{ quantity: 58, unit: "ounce" }],
        },
        {
          name: "whole milk",
          quantity: 2,
          unit: "each",
          display_text: "2 cartons (1 gal) whole milk",
          line_item_measurements: [{ quantity: 3, unit: "cup" }],
        },
        {
          name: "ground beef",
          quantity: 3,
          unit: "pound",
          display_text: "3 lb ground beef",
          line_item_measurements: [{ quantity: 2, unit: "pound" }],
        },
        {
          name: "lemon juice",
          quantity: 1,
          unit: "each",
          display_text: "1 bottle (15 oz) lemon juice",
          line_item_measurements: [{ quantity: 2, unit: "tablespoon" }],
        },
        {
          name: "eggs",
          quantity: 12,
          unit: "each",
          display_text: "1 dozen eggs",
          line_item_measurements: [{ quantity: 6, unit: "each" }],
        },
        {
          name: "cilantro",
          quantity: 1,
          unit: "bunch",
          display_text: "cilantro, chopped",
          line_item_measurements: [{ quantity: 1, unit: "bunch" }],
        },
        {
          name: "ground cumin",
          quantity: 1,
          unit: "each",
          display_text: "ground cumin",
          line_item_measurements: [{ quantity: 2, unit: "teaspoon" }],
        },
        {
          name: "garlic",
          quantity: 1,
          unit: "each",
          display_text: "garlic, minced",
        },
        {
          name: "lasagna sheets",
          quantity: 1,
          unit: "each",
          display_text: "1 sheet lasagna sheets",
          line_item_measurements: [{ quantity: 12, unit: "each" }],
        },
      ],
    });

    assert.deepEqual(result.skipped, [
      { groceryListItemId: "r-gone", reason: "deleted" },
      { groceryListItemId: "r-missing", reason: "not_found" },
    ]);

    assert.deepEqual(result.unmappedUnits, [
      { groceryListItemId: "r-cumin", unit: "teaspoon" },
      { groceryListItemId: "r-garlic", unit: "clove" },
      { groceryListItemId: "r-lasagna", unit: "sheet" },
    ]);
  });

  it("a client packUnit the row does not know is taken at face value", () => {
    const result = composeInstacartPayload(
      [ROWS[1]!],
      [{ groceryListItemId: "r-turkey", packCount: 2, packUnit: "package" }],
      { title: "t" },
    );
    assert.deepEqual(result.payload.line_items, [
      {
        name: "ground turkey",
        quantity: 2,
        unit: "package",
        display_text: "2 package ground turkey",
        line_item_measurements: [{ quantity: 2.5, unit: "pound" }],
      },
    ]);
  });

  it("client packCount with no packUnit uses the row's pack unit and size", () => {
    const result = composeInstacartPayload(
      [ROWS[1]!],
      [{ groceryListItemId: "r-turkey", packCount: 3 }],
      { title: "t" },
    );
    assert.equal(result.payload.line_items[0]!.quantity, 4.5);
    assert.equal(result.payload.line_items[0]!.unit, "pound");
    assert.equal(result.payload.line_items[0]!.display_text, "4.5 lb ground turkey");
  });

  it("display_text elides the name when the pack line already says it (live +8 list shapes)", () => {
    const rows: InstacartRowInput[] = [
      row({ id: "limes", displayName: "Lime", quantity: 5, unit: "each", purchaseQuantity: 2, purchaseUnit: "each", purchaseDisplay: "2 limes" }),
      row({ id: "lime", displayName: "limes", quantity: 1, unit: "each", purchaseQuantity: 1, purchaseUnit: "each", purchaseDisplay: "1 lime" }),
      row({ id: "roma", displayName: "roma tomatoes", quantity: 2, unit: "each", purchaseQuantity: 4, purchaseUnit: "each", purchaseDisplay: "4 roma tomatoes" }),
      row({ id: "onion", displayName: "White onion", quantity: 2.25, unit: "each", purchaseQuantity: 1, purchaseUnit: "each", purchaseDisplay: "1 medium white onion" }),
      row({ id: "butter", displayName: "unsalted butter", quantity: 14, unit: "tablespoon", purchaseQuantity: 1, purchaseUnit: "lb", purchaseDisplay: "1 lb pack (4 sticks)" }),
    ];
    const result = composeInstacartPayload(
      rows,
      rows.map((r) => ({ groceryListItemId: r.id })),
      { title: "t" },
    );
    assert.deepEqual(
      result.payload.line_items.map((li) => li.display_text),
      ["2 limes", "1 lime", "4 roma tomatoes", "1 medium white onion", "1 lb pack (4 sticks) unsalted butter"],
    );
  });

  it("a blank title falls back to the default and expiresInDays is honoured", () => {
    const result = composeInstacartPayload(
      [ROWS[7]!],
      [{ groceryListItemId: "r-cilantro" }],
      { title: "   ", expiresInDays: 7 },
    );
    assert.equal(result.payload.title, "Kiwi grocery list");
    assert.equal(result.payload.expires_in, 7);
  });

  it("an empty selection composes an empty list (the route turns that into 400)", () => {
    const result = composeInstacartPayload(ROWS, [], { title: "t" });
    assert.deepEqual(result.payload.line_items, []);
    assert.deepEqual(result.skipped, []);
  });
});
