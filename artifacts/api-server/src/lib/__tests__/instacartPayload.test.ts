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
        // E2 — count needs carry no measurement; the order line is the count.
        { name: "eggs", quantity: 12, unit: "each", display_text: "1 dozen eggs" },
        { name: "cilantro", quantity: 1, unit: "bunch", display_text: "cilantro, chopped" },
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
        { name: "lasagna sheets", quantity: 1, unit: "each", display_text: "1 sheet lasagna sheets" },
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
    // Part E1 scales the same-token rows here too (limes 5 vs 2 → 6; onion
    // 2.25 vs 1 → 3); the elide still holds on the rewritten line.
    assert.deepEqual(
      result.payload.line_items.map((li) => li.display_text),
      ["6 limes", "1 lime", "4 roma tomatoes", "3 medium white onion", "1 lb pack (4 sticks) unsalted butter"],
    );
    assert.deepEqual(
      result.payload.line_items.map((li) => [li.quantity, li.unit]),
      [[6, "each"], [1, "each"], [4, "each"], [3, "each"], [1, "pound"]],
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

// ── Part E — E1 same-token pack scaling on the fallback path · E2 measures ──
//
// Every expectation is a literal. E1 is the phone's packsToCoverNeed rule 1
// (artifacts/kiwi/lib/format/grocery.ts:606-610) and NOTHING more: only a need
// and a pack that carry the same unit token scale; a cross-system pair (a
// weight need against a container pack) stays one pack, because that
// arithmetic lives on the phone by ruling.

describe("composeInstacartPayload — Part E (E1 same-token scaling, E2 true measures)", () => {
  function one(r: InstacartRowInput, client: Partial<import("../retailers/instacartPayload").InstacartClientItem> = {}) {
    return composeInstacartPayload([r], [{ groceryListItemId: r.id, ...client }], { title: "t" })
      .payload.line_items[0]!;
  }

  it("limes — need 5 each, pack 2 each → 6 each, no measurement (the live under-order)", () => {
    assert.deepEqual(
      one(row({ id: "limes", displayName: "Lime", quantity: 5, unit: "each", purchaseQuantity: 2, purchaseUnit: "each", purchaseDisplay: "2 limes" })),
      { name: "Lime", quantity: 6, unit: "each", display_text: "6 limes" },
    );
  });

  it("roma tomatoes — need 9 each, pack 4 each → 12 each", () => {
    assert.deepEqual(
      one(row({ id: "roma", displayName: "roma tomatoes", quantity: 9, unit: "each", purchaseQuantity: 4, purchaseUnit: "each", purchaseDisplay: "4 roma tomatoes" })),
      { name: "roma tomatoes", quantity: 12, unit: "each", display_text: "12 roma tomatoes" },
    );
  });

  it("chicken thighs — need 1.5 pound, pack 1.5 lb → 1.5 pound + [1.5 pound] (unchanged; exactly one pack)", () => {
    assert.deepEqual(
      one(row({ id: "thighs", displayName: "boneless skinless chicken thighs", quantity: 1.5, unit: "pound", purchaseQuantity: 1.5, purchaseUnit: "lb", purchaseDisplay: "1.5 lb pack" })),
      {
        name: "boneless skinless chicken thighs",
        quantity: 1.5,
        unit: "pound",
        display_text: "1.5 lb pack boneless skinless chicken thighs",
        line_item_measurements: [{ quantity: 1.5, unit: "pound" }],
      },
    );
  });

  it("chicken thighs — need 2.5 pound against a 1.5 lb pack → 2 packs = 3 pound (same token, different spelling)", () => {
    assert.deepEqual(
      one(row({ id: "thighs2", displayName: "bone-in chicken thighs", quantity: 2.5, unit: "pound", purchaseQuantity: 1.5, purchaseUnit: "lb", purchaseDisplay: "1.5 lb pack" })),
      {
        name: "bone-in chicken thighs",
        quantity: 3,
        unit: "pound",
        display_text: "3 lb pack bone-in chicken thighs",
        line_item_measurements: [{ quantity: 2.5, unit: "pound" }],
      },
    );
  });

  it("ground cumin — need 4 teaspoon, pack 1 container (1.7 oz) → 1 each + [4 teaspoon] (different tokens)", () => {
    assert.deepEqual(
      one(row({ id: "cumin", displayName: "ground cumin", quantity: 4, unit: "teaspoon", purchaseQuantity: 1, purchaseUnit: "container", purchaseDisplay: "1 container (1.7 oz)" })),
      {
        name: "ground cumin",
        quantity: 1,
        unit: "each",
        display_text: "1 container (1.7 oz) ground cumin",
        line_item_measurements: [{ quantity: 4, unit: "teaspoon" }],
      },
    );
  });

  it("a weight need against a container pack stays ONE pack — cross-system conversion is the phone's, by ruling", () => {
    // 2 pound against "1 package (12 oz)" is ~2.7 packs on the phone (rule 3,
    // the size hint); the server has no size-hint arithmetic and must not
    // guess, so it sends the stored pack unscaled and the true measure.
    assert.deepEqual(
      one(row({ id: "sausage", displayName: "breakfast sausage", quantity: 2, unit: "pound", purchaseQuantity: 1, purchaseUnit: "package", purchaseDisplay: "1 package (12 oz)" })),
      {
        name: "breakfast sausage",
        quantity: 1,
        unit: "package",
        display_text: "1 package (12 oz) breakfast sausage",
        line_item_measurements: [{ quantity: 2, unit: "pound" }],
      },
    );
  });

  it("chipotle — need 2 each, pack 1 can (7 oz) → 1 can, NO measurement (E2)", () => {
    assert.deepEqual(
      one(row({ id: "chipotle", displayName: "chipotle peppers in adobo sauce", quantity: 2, unit: "each", purchaseQuantity: 1, purchaseUnit: "can", purchaseDisplay: "1 can (7 oz)" })),
      { name: "chipotle peppers in adobo sauce", quantity: 1, unit: "can", display_text: "1 can (7 oz) chipotle peppers in adobo sauce" },
    );
  });

  it("a scaled count pack pluralises the noun it rewrites: need 3 can, pack 1 can (15 oz) → 3 cans (15 oz)", () => {
    assert.deepEqual(
      one(row({ id: "beans", displayName: "black beans", quantity: 3, unit: "can", purchaseQuantity: 1, purchaseUnit: "can", purchaseDisplay: "1 can (15 oz)" })),
      { name: "black beans", quantity: 3, unit: "can", display_text: "3 cans (15 oz) black beans" },
    );
  });

  it("purchaseQuantityOverride set → E1 does not apply; the stated buy wins", () => {
    assert.deepEqual(
      one(row({ id: "limes-ovr", displayName: "Lime", quantity: 5, unit: "each", purchaseQuantity: 2, purchaseUnit: "each", purchaseDisplay: "2 limes", purchaseQuantityOverride: 3 })),
      { name: "Lime", quantity: 3, unit: "each", display_text: "3 each Lime" },
    );
  });

  it("client packCount supplied → E1 does not apply; the phone's count wins", () => {
    assert.deepEqual(
      one(
        row({ id: "limes-cli", displayName: "Lime", quantity: 5, unit: "each", purchaseQuantity: 2, purchaseUnit: "each", purchaseDisplay: "2 limes" }),
        { packCount: 1, packUnit: "each" },
      ),
      { name: "Lime", quantity: 2, unit: "each", display_text: "2 each Lime" },
    );
  });

  it("a need of exactly one pack does not ceil to two on float noise (epsilon)", () => {
    assert.equal(
      one(row({ id: "eps", displayName: "rice", quantity: 0.1 + 0.2, unit: "pound", purchaseQuantity: 0.3, purchaseUnit: "lb", purchaseDisplay: "0.3 lb bag" })).quantity,
      0.3,
    );
  });
});
