// WS9 3c follow-up (BUG-053) — tests for the session re-roll accumulator.
// Pure function. Every fixture states the plans it feeds and the accumulation
// it expects. The dedup-by-title + same-ref-when-empty behaviors are the ones
// that keep the exclusion from double-counting a still-shown plan.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accumulateShownPlans,
  EMPTY_SESSION_EXCLUSION,
  type SessionExclusion,
} from "../sessionExclusion";

// Fixture: two distinct plans, each with two meal titles.
const PLAN_A = { title: "Grill Nights", mealTitles: ["Burgers", "Tacos"] };
const PLAN_B = { title: "Cozy One-Pots", mealTitles: ["Chili", "Stew"] };

test("accumulates a single shown plan (surprise: one candidate per generation)", () => {
  const next = accumulateShownPlans(EMPTY_SESSION_EXCLUSION, [PLAN_A]);
  assert.deepEqual(next.planTitles, ["Grill Nights"]);
  assert.deepEqual(next.mealTitles, ["Burgers", "Tacos"]);
});

test("accumulates all three at once (standard wizard: three candidates per attempt)", () => {
  const PLAN_C = { title: "Bright Mediterranean", mealTitles: ["Bowls"] };
  const next = accumulateShownPlans(EMPTY_SESSION_EXCLUSION, [
    PLAN_A,
    PLAN_B,
    PLAN_C,
  ]);
  assert.deepEqual(next.planTitles, [
    "Grill Nights",
    "Cozy One-Pots",
    "Bright Mediterranean",
  ]);
  assert.deepEqual(next.mealTitles, [
    "Burgers",
    "Tacos",
    "Chili",
    "Stew",
    "Bowls",
  ]);
});

test("session-scoped: a second re-roll adds to (does not replace) the first", () => {
  // Fixture: PLAN_A shown first, then PLAN_B on the next re-roll — the exclusion
  // must carry BOTH, not just the latest (the whole point of session scope).
  const afterFirst = accumulateShownPlans(EMPTY_SESSION_EXCLUSION, [PLAN_A]);
  const afterSecond = accumulateShownPlans(afterFirst, [PLAN_B]);
  assert.deepEqual(afterSecond.planTitles, ["Grill Nights", "Cozy One-Pots"]);
  assert.deepEqual(afterSecond.mealTitles, [
    "Burgers",
    "Tacos",
    "Chili",
    "Stew",
  ]);
});

test("dedups by plan title — a re-shown plan returns the SAME reference (skip write)", () => {
  // Fixture: PLAN_A already accumulated; feeding it again (the stale-data case
  // that must not double-count) yields the same object reference.
  const prev: SessionExclusion = accumulateShownPlans(
    EMPTY_SESSION_EXCLUSION,
    [PLAN_A],
  );
  const again = accumulateShownPlans(prev, [PLAN_A]);
  assert.equal(again, prev, "must return the same reference when nothing is new");
});

test("dedups meal titles shared across plans", () => {
  // Fixture: two plans that share a meal ("Tacos"); it appears once.
  const shared = { title: "Taco Week", mealTitles: ["Tacos", "Nachos"] };
  const next = accumulateShownPlans(
    accumulateShownPlans(EMPTY_SESSION_EXCLUSION, [PLAN_A]),
    [shared],
  );
  assert.deepEqual(next.planTitles, ["Grill Nights", "Taco Week"]);
  // "Tacos" already present from PLAN_A — not duplicated.
  assert.deepEqual(next.mealTitles, ["Burgers", "Tacos", "Nachos"]);
});

test("ignores blank titles", () => {
  const next = accumulateShownPlans(EMPTY_SESSION_EXCLUSION, [
    { title: "", mealTitles: ["X"] },
  ]);
  assert.equal(next, EMPTY_SESSION_EXCLUSION);
});
