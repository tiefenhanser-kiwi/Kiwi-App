// WS9 Redesign Arc Block 2a Part D (D-WS9-237) — the Pick screen's rules, as
// pure functions. The screen (components/PickMealsScreen.tsx) renders these;
// this pins the decisions themselves: rounds 4 / thin 2, exhausted, order of
// picks, over-cap counted-not-blocked, paging by exclusion, the param codec.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShelfMeal, WizardShelfResponse } from "@/lib/api/wizard";
import {
  appendPage,
  excludeIdsFor,
  initialPickState,
  isExhausted,
  isOverCap,
  overCapPickedCount,
  parsePickMealsParams,
  pickMealsRouteParams,
  ROUNDS_NORMAL,
  ROUNDS_THIN,
  roundsFor,
  THIN_SHELF_MAX,
  togglePick,
} from "../pickMeals";

function meal(id: string, total = 30, extra: Partial<ShelfMeal> = {}): ShelfMeal {
  return {
    id,
    title: `Meal ${id}`,
    description: null,
    cuisineType: "Italian",
    difficulty: "easy",
    estimatedTimeMinutes: total,
    activeTimeMinutes: Math.round(total / 2),
    macrosPerServing: { calories: 500, protein: 30, carbs: 40, fat: 20 },
    tags: [],
    dishCount: 2,
    isNewToYou: false,
    isPlaylist: false,
    isPinned: false,
    matchesCuisine: null,
    source: "shelf",
    ...extra,
  };
}
function shelf(
  meals: ShelfMeal[],
  totalEligible: number,
  hasMore = true,
): WizardShelfResponse {
  return { meals, totalEligible, hasMore, unmatchedNames: [] };
}

// ── rounds ─────────────────────────────────────────────────────────────────

test("roundsFor: a normal shelf gets 4 rounds, a THIN shelf (≤10 eligible) gets 2", () => {
  assert.equal(roundsFor(40), ROUNDS_NORMAL);
  assert.equal(roundsFor(11), ROUNDS_NORMAL);
  assert.equal(roundsFor(THIN_SHELF_MAX), ROUNDS_THIN);
  assert.equal(roundsFor(3), ROUNDS_THIN);
  assert.equal(roundsFor(0), ROUNDS_THIN);
  assert.equal(ROUNDS_NORMAL, 4);
  assert.equal(ROUNDS_THIN, 2);
});

test("initialPickState: rounds come from the FIRST response's totalEligible", () => {
  assert.equal(initialPickState(shelf([meal("a")], 40)).roundsLeft, 4);
  assert.equal(initialPickState(shelf([meal("a")], 8)).roundsLeft, 2);
});

// ── exhausted ──────────────────────────────────────────────────────────────

test("isExhausted: hasMore:false from the server ends the rounds early", () => {
  const s = initialPickState(shelf([meal("a")], 40, false));
  assert.equal(s.roundsLeft, 4, "rounds are still notionally there…");
  assert.equal(isExhausted(s), true, "…but the server said no more");
});

test("isExhausted: rounds used up ends it even when the server says hasMore", () => {
  let s = initialPickState(shelf([meal("a")], 8)); // thin → 2 rounds
  assert.equal(isExhausted(s), false);
  s = appendPage(s, shelf([meal("b")], 8, true));
  assert.equal(isExhausted(s), false);
  s = appendPage(s, shelf([meal("c")], 8, true));
  assert.equal(s.roundsLeft, 0);
  assert.equal(isExhausted(s), true);
});

test("a ZERO-result shelf is exhausted immediately", () => {
  const s = initialPickState(shelf([], 0, false));
  assert.equal(s.totalEligible, 0);
  assert.equal(isExhausted(s), true);
});

// ── paging ─────────────────────────────────────────────────────────────────

test("appendPage: appends, de-dupes, spends one round, keeps the picks", () => {
  let s = initialPickState(shelf([meal("a"), meal("b")], 40));
  s = togglePick(s, "b");
  s = appendPage(s, shelf([meal("b"), meal("c"), meal("d")], 40, true));
  assert.deepEqual(s.meals.map((m) => m.id), ["a", "b", "c", "d"], "b not duplicated");
  assert.deepEqual(s.pickedIds, ["b"], "selection preserved across a round");
  assert.equal(s.roundsLeft, 3);
  assert.equal(s.hasMore, true);
});

test("appendPage: an EMPTY page ends the rounds — nothing more will come", () => {
  let s = initialPickState(shelf([meal("a")], 40));
  s = appendPage(s, shelf([], 40, true));
  assert.equal(s.hasMore, false);
  assert.equal(isExhausted(s), true);
});

test("excludeIdsFor: EVERY shown id, so the next round cannot repeat a card", () => {
  let s = initialPickState(shelf([meal("a"), meal("b")], 40));
  s = appendPage(s, shelf([meal("c")], 40));
  assert.deepEqual(excludeIdsFor(s), ["a", "b", "c"]);
});

// ── picks ──────────────────────────────────────────────────────────────────

test("togglePick: order of picks is preserved; un-pick removes in place", () => {
  let s = initialPickState(shelf([meal("a"), meal("b"), meal("c")], 40));
  s = togglePick(s, "c");
  s = togglePick(s, "a");
  s = togglePick(s, "b");
  assert.deepEqual(s.pickedIds, ["c", "a", "b"], "the from-meals body's order");
  s = togglePick(s, "a");
  assert.deepEqual(s.pickedIds, ["c", "b"]);
});

// ── over cap: counted, never blocked (D-WS9-235) ───────────────────────────

test("isOverCap: strictly greater than the cap; no cap → never over", () => {
  assert.equal(isOverCap(meal("a", 45), 45), false);
  assert.equal(isOverCap(meal("a", 46), 45), true);
  assert.equal(isOverCap(meal("a", 120), null), false);
});

test("over-cap picks are COUNTED in the footer and still picked", () => {
  let s = initialPickState(shelf([meal("a", 20), meal("b", 60), meal("c", 90)], 40));
  s = togglePick(s, "b");
  s = togglePick(s, "c");
  s = togglePick(s, "a");
  assert.deepEqual(s.pickedIds, ["b", "c", "a"], "nothing blocked the over-cap picks");
  assert.equal(overCapPickedCount(s, 45), 2);
  assert.equal(overCapPickedCount(s, null), 0);
});

// ── the route-param codec ──────────────────────────────────────────────────

test("pickMealsRouteParams ↔ parsePickMealsParams round-trip", () => {
  const input = {
    shelf: shelf([meal("a", 30, { isPlaylist: true })], 12, true),
    request: {
      planDurationDays: 5,
      householdSize: 4,
      cuisines: ["Italian"],
      difficulty: "medium" as const,
      weeklyPacing: "mixed" as const,
      text: "tacos twice",
    },
    mode: "text" as const,
    planDurationDays: 5,
    householdSize: 4,
    capMinutes: 45,
  };
  const params = pickMealsRouteParams(input);
  for (const v of Object.values(params)) assert.equal(typeof v, "string");
  assert.deepEqual(parsePickMealsParams(params), input);
});

test("parsePickMealsParams: no cap encodes as '' and decodes as null", () => {
  const params = pickMealsRouteParams({
    shelf: shelf([], 0, false),
    request: { planDurationDays: 3, householdSize: 2, cuisines: [], difficulty: "easy", weeklyPacing: "mostly_easy" },
    mode: "prefs",
    planDurationDays: 3,
    householdSize: 2,
    capMinutes: null,
  });
  assert.equal(params.capMinutes, "");
  assert.equal(parsePickMealsParams(params)?.capMinutes, null);
});

test("parsePickMealsParams: missing or malformed params → null, never a throw", () => {
  assert.equal(parsePickMealsParams({}), null);
  assert.equal(parsePickMealsParams({ shelf: "{not json", request: "{}" }), null);
  assert.equal(parsePickMealsParams({ shelf: JSON.stringify({}), request: "{}" }), null);
});
