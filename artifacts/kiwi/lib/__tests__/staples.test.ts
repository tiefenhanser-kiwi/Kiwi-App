// CLIENT-9 D (BUG-472) — "I always have this": which rows can be marked, the list
// as the server leaves it, the cart without them, and the copy.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canMarkStaple, MARK_STAPLE_LABEL, STAPLES_COPY, withStapleMarked } from "../staples";
import { selectInstacartRows } from "../instacartOrder";
import type { GroceryListItem } from "../types";

const row = (id: string, o: Partial<GroceryListItem> = {}): GroceryListItem => ({
  id,
  name: id,
  quantity: "1",
  sectionKey: "pantry",
  isUniversalStaple: false,
  isRecurringItem: false,
  isAmbiguous: false,
  isOptional: false,
  isCompleted: false,
  ...o,
});

describe("CLIENT-9 D — which grocery rows offer “I always have this”", () => {
  it("a catalog ingredient that is not a staple yet", () => {
    assert.equal(canMarkStaple(row("garlic powder", { ingredientId: "ing-gp" })), true);
  });

  it("not a staple already (a default one or the user's own), not a typed-in item, not an older wire", () => {
    assert.equal(canMarkStaple(row("salt", { ingredientId: "ing-salt", isUniversalStaple: true })), false);
    assert.equal(canMarkStaple(row("paper towels", { ingredientId: null })), false);
    assert.equal(canMarkStaple(row("old wire")), false);
    assert.equal(canMarkStaple(row("blank", { ingredientId: "" })), false);
  });
});

describe("CLIENT-9 D — the list after a mark", () => {
  const list = [
    row("gp-a", { ingredientId: "ing-gp", stapleOptedIn: true }),
    row("oil", { ingredientId: "ing-oil" }),
    row("gp-b", { ingredientId: "ing-gp", isCompleted: true }),
    row("typed", { ingredientId: null }),
  ];

  it("every row of that ingredient is a staple, not opted in; the others are untouched", () => {
    const after = withStapleMarked(list, list[0]);
    assert.deepEqual(after.map((it) => [it.id, it.isUniversalStaple, it.stapleOptedIn ?? false]), [
      ["gp-a", true, false],
      ["oil", false, false],
      ["gp-b", true, false],
      ["typed", false, false],
    ]);
    assert.equal(after[1], list[1], "an unmarked row is the same object");
    assert.equal(list[0].isUniversalStaple, false, "the input is not mutated");
  });

  it("the row pressed always moves; a null ingredient matches nothing else", () => {
    const after = withStapleMarked(list, list[3]);
    assert.deepEqual(after.filter((it) => it.isUniversalStaple).map((it) => it.id), ["typed"]);
  });

  it("a marked row leaves the Instacart cart (the app already holds back a staple not opted in)", () => {
    assert.deepEqual(selectInstacartRows(list).map((it) => it.id), ["gp-a", "oil", "typed"]);
    assert.deepEqual(selectInstacartRows(withStapleMarked(list, list[0])).map((it) => it.id), ["oil", "typed"]);
  });
});

describe("CLIENT-9 D — the copy", () => {
  it("is Hans's, verbatim", () => {
    assert.equal(MARK_STAPLE_LABEL, "I always have this");
    assert.equal(STAPLES_COPY, "Staples are things you always have, like garlic powder or olive oil. Kiwi keeps them off your list.");
  });
});
