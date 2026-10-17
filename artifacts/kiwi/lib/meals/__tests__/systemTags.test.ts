// BOOK-1C2 — BUG-416: system tags never render (lib/meals/systemTags.ts).

import assert from "node:assert/strict";
import { test } from "node:test";

import { cardPills } from "../cardPills";
import { isSystemTag, visibleMealTags } from "../systemTags";

test("the season's markers, the course tags and the dev seed marker are system tags", () => {
  for (const t of [
    "thanksgiving",
    "Thanksgiving",
    " thanksgiving ",
    "thanksgiving-alternate",
    "thanksgiving-feast",
    "thanksgiving-leftovers",
    "course-turkey",
    "course-cranberry",
    "Course-Dessert",
    "dev",
  ]) {
    assert.equal(isSystemTag(t), true, t);
  }
});

test("a person's tags are not (including ones that merely contain the words)", () => {
  for (const t of ["weeknight", "high-protein", "kid-friendly", "devilled", "thanksgiving leftovers soup", "main course", "american"]) {
    assert.equal(isSystemTag(t), false, t);
  }
});

test("visibleMealTags keeps the stored order and tolerates no tags", () => {
  assert.deepEqual(
    visibleMealTags(["american", "thanksgiving", "thanksgiving-alternate", "course-turkey", "comfort"]),
    ["american", "comfort"],
  );
  assert.deepEqual(visibleMealTags(null), []);
  assert.deepEqual(visibleMealTags(undefined), []);
});

test("cardPills never shows a system tag (the Pick card, the Recipes row, the Playlist)", () => {
  assert.deepEqual(
    cardPills({
      cuisineType: "American",
      difficulty: "medium",
      tags: ["american", "thanksgiving", "thanksgiving-alternate", "course-turkey", "dev", "weeknight"],
    }),
    ["American", "medium", "weeknight"],
  );
});
