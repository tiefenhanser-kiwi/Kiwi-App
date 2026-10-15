// BOOK-1C1 (D-WS9-312) — one saved state for every heart: the Cookbook page
// patch and the favorites id list AppContext.setSaved writes together.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { patchSavedInPages, withFavorite } from "../savedCache";

const card = (id: string, isSaved = false) => ({ id, isSaved });

describe("patchSavedInPages", () => {
  test("sets isSaved on the card for that meal, on every page it appears", () => {
    const data = {
      pages: [{ meals: [card("a"), card("b")] }, { meals: [card("c"), card("a")] }],
      pageParams: [undefined, "x"],
    };
    const next = patchSavedInPages(data, "a", true)!;
    assert.deepEqual(
      next.pages.map((p) => p.meals.map((m) => `${m.id}:${m.isSaved}`)),
      [["a:true", "b:false"], ["c:false", "a:true"]],
    );
    assert.deepEqual(next.pageParams, data.pageParams);
  });

  test("an un-save clears it", () => {
    const data = { pages: [{ meals: [card("a", true)] }], pageParams: [undefined] };
    assert.equal(patchSavedInPages(data, "a", false)!.pages[0].meals[0].isSaved, false);
  });

  test("no card for that meal, or already in that state: the same reference back", () => {
    const data = { pages: [{ meals: [card("a", true)] }], pageParams: [undefined] };
    assert.equal(patchSavedInPages(data, "zzz", true), data);
    assert.equal(patchSavedInPages(data, "a", true), data);
    assert.equal(patchSavedInPages(undefined, "a", true), undefined);
  });
});

describe("withFavorite", () => {
  test("adds once, removes all", () => {
    assert.deepEqual(withFavorite(["a"], "b", true), ["a", "b"]);
    assert.deepEqual(withFavorite(["a", "b"], "b", true), ["a", "b"]);
    assert.deepEqual(withFavorite(["a", "b"], "a", false), ["b"]);
    assert.deepEqual(withFavorite([], "a", false), []);
  });
});
