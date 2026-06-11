// WS7-6 G3 Scope E / #3 — dish post-save nav contract. The Dish Builder save
// handler can't render in the node harness (it pulls react-native-draggable-
// flatlist), so the destination decision lives in a pure helper tested here.

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveDishPostSaveNav } from "../dishPostSaveNav";

test("create save lands on the new dish's Dish Detail page", () => {
  const nav = resolveDishPostSaveNav({ newDishId: "dish-123", isEdit: false });
  assert.deepEqual(nav, { kind: "dish-detail", dishId: "dish-123" });
});

test("the new dish id threads through to the Dish Detail target", () => {
  const nav = resolveDishPostSaveNav({ newDishId: "abc-xyz", isEdit: false });
  assert.equal(nav.kind === "dish-detail" ? nav.dishId : null, "abc-xyz");
});

test("edit save keeps its contextual back (no forced Dish Detail jump)", () => {
  const nav = resolveDishPostSaveNav({ newDishId: "dish-9", isEdit: true });
  assert.deepEqual(nav, { kind: "back" });
});
