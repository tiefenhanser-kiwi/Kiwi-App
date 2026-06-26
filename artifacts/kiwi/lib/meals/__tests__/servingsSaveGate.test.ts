// WS7-8 BUG-003 B2.2 (PRD §10.6.1) — unit tests for the plan-instance servings
// Save gate predicates. Pure functions, no React / no JSX. These pin the
// behavioral contract the Meal Detail screen wires to:
//   (b) Save appears iff canPersist && dirty
//   (d) the non-plan/canonical path never offers Save (persists nothing)
//   + the stepper clamp and dirty signal.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampServings,
  isServingsDirty,
  shouldShowSaveServings,
} from "../servingsSaveGate";

const MIN = 1;
const MAX = 12;

// ── clampServings ────────────────────────────────────────────────────────────

test("clampServings keeps an in-range value untouched", () => {
  assert.equal(clampServings(4, MIN, MAX), 4);
});

test("clampServings floors at min and ceils at max", () => {
  assert.equal(clampServings(0, MIN, MAX), MIN);
  assert.equal(clampServings(-3, MIN, MAX), MIN);
  assert.equal(clampServings(99, MIN, MAX), MAX);
});

// ── isServingsDirty ──────────────────────────────────────────────────────────

test("isServingsDirty is false when display matches the saved value", () => {
  assert.equal(isServingsDirty(4, 4), false);
});

test("isServingsDirty is true when display diverges from the saved value", () => {
  assert.equal(isServingsDirty(6, 4), true);
  assert.equal(isServingsDirty(2, 4), true);
});

// ── shouldShowSaveServings — the gate (b) ────────────────────────────────────

test("Save appears only in a plan context AND only when dirty", () => {
  // canPersist && dirty → show.
  assert.equal(shouldShowSaveServings(true, 6, 4), true);
  // canPersist but clean → hide.
  assert.equal(shouldShowSaveServings(true, 4, 4), false);
});

// ── scope guard (d) — the non-plan/canonical path never offers Save ──────────

test("the non-plan (canonical) path never shows Save, even when stepped", () => {
  // canPersist === false: dirty or not, no Save affordance → nothing to persist.
  assert.equal(shouldShowSaveServings(false, 6, 4), false);
  assert.equal(shouldShowSaveServings(false, 4, 4), false);
  assert.equal(shouldShowSaveServings(false, 1, 12), false);
});
