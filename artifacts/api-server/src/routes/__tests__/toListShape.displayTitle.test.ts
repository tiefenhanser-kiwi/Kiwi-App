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

// WS9 3f-4d Part 1e (D-WS9-126) — toListShape derives dishTitles as the SIDE
// dishes only (main excluded), gated on the FULL dish count > 1, in authoring
// order. The main title nearly duplicates the meal title, so it is dropped.
describe("toListShape — dishTitles derivation (sides only)", () => {
  it("excludes the main dish and preserves authoring order for the sides", () => {
    const row = toListShape({
      ...BASE,
      displayTitle: null,
      description: null,
      dishLinks: [
        { roleLabel: "main", dish: { title: "Braised Beef Short Ribs" } },
        { roleLabel: "base", dish: { title: "Creamy Mashed Potatoes" } },
        { roleLabel: "side", dish: { title: "Roasted Carrots" } },
      ],
    });
    assert.deepEqual(row.dishTitles, [
      "Creamy Mashed Potatoes",
      "Roasted Carrots",
    ]);
  });

  it("shows the single side of a 2-dish meal (gate is full dish count > 1)", () => {
    const row = toListShape({
      ...BASE,
      displayTitle: null,
      description: null,
      dishLinks: [
        { roleLabel: "main", dish: { title: "Thai Red Curry with Chicken" } },
        { roleLabel: "base", dish: { title: "Warm Store-Bought Roti" } },
      ],
    });
    assert.deepEqual(row.dishTitles, ["Warm Store-Bought Roti"]);
  });

  it("returns [] for a single-dish meal (no sub-line — falls back to description)", () => {
    const row = toListShape({
      ...BASE,
      displayTitle: null,
      description: null,
      dishLinks: [{ roleLabel: "main", dish: { title: "Baked Salmon" } }],
    });
    assert.deepEqual(row.dishTitles, []);
  });

  it("returns [] for a multi-dish meal that is somehow all-main", () => {
    const row = toListShape({
      ...BASE,
      displayTitle: null,
      description: null,
      dishLinks: [
        { roleLabel: "main", dish: { title: "Main A" } },
        { roleLabel: "main", dish: { title: "Main B" } },
      ],
    });
    assert.deepEqual(row.dishTitles, []);
  });

  it("defaults to an empty array when the relation was not selected", () => {
    const row = toListShape({ ...BASE, displayTitle: null, description: null });
    assert.deepEqual(row.dishTitles, []);
  });
});
