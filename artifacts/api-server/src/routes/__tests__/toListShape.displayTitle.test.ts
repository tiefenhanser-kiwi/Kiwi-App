// WS9 3f-4d Part 1c (D-WS9-123/124) — displayTitle + description must survive
// the meal LIST DTO. Part 1 stripped both server-side (MealListItem had neither),
// so list rows could never render the short name or the sub-text. These tests pin
// that toListShape now carries both fields through with null-passthrough.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toListShape } from "../meals";

const BASE = {
  id: "m-1",
  title: "Braised Beef Short Ribs with Creamy Mashed Potatoes and Roasted Carrots",
  cuisineType: "American",
  estimatedTimeMinutes: 45,
  servingsDefault: 4,
  authoredServingsDefault: 4,
  caloriesPerServing: 600,
  proteinGPerServing: 40,
  carbsGPerServing: 30,
  fatGPerServing: 25,
  tags: ["beef"],
  imageUrl: null,
};

describe("toListShape — displayTitle + description round-trip", () => {
  it("carries displayTitle and description through to the list row", () => {
    const row = toListShape({
      ...BASE,
      displayTitle: "Braised Beef Short Ribs",
      description: "Fall-off-the-bone short ribs over mashed potatoes with roasted carrots.",
    });
    assert.equal(row.displayTitle, "Braised Beef Short Ribs");
    assert.equal(
      row.description,
      "Fall-off-the-bone short ribs over mashed potatoes with roasted carrots.",
    );
    // title stays the long canonical identity — never shortened by the DTO.
    assert.equal(row.title, BASE.title);
  });

  it("passes null through for both fields (no coercion)", () => {
    const row = toListShape({ ...BASE, displayTitle: null, description: null });
    assert.equal(row.displayTitle, null);
    assert.equal(row.description, null);
  });
});

// WS9 3f-4d Part 1d (D-WS9-125) — toListShape derives dishTitles (main first)
// from the MealDishLink relation for the multi-dish sub-line.
describe("toListShape — dishTitles derivation", () => {
  it("orders the main dish first, then authoring order", () => {
    const row = toListShape({
      ...BASE,
      displayTitle: null,
      description: null,
      // Deliberately out of order: main is not first in the input array.
      dishLinks: [
        { roleLabel: "base", dish: { title: "Creamy Mashed Potatoes" } },
        { roleLabel: "side", dish: { title: "Roasted Carrots" } },
        { roleLabel: "main", dish: { title: "Braised Beef Short Ribs" } },
      ],
    });
    assert.deepEqual(row.dishTitles, [
      "Braised Beef Short Ribs", // main hoisted to front
      "Creamy Mashed Potatoes",
      "Roasted Carrots",
    ]);
  });

  it("defaults to an empty array when the relation was not selected", () => {
    const row = toListShape({ ...BASE, displayTitle: null, description: null });
    assert.deepEqual(row.dishTitles, []);
  });
});
