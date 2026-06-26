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
  shouldShowCanonicalSaveServings,
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

test("the non-plan (canonical) path never shows the INSTANCE Save, even when stepped", () => {
  // canPersist === false: dirty or not, no instance Save → nothing to persist.
  // (The CANONICAL gate below is what fires here instead.)
  assert.equal(shouldShowSaveServings(false, 6, 4), false);
  assert.equal(shouldShowSaveServings(false, 4, 4), false);
  assert.equal(shouldShowSaveServings(false, 1, 12), false);
});

// ── shouldShowCanonicalSaveServings — the CANONICAL gate (B2.3) ───────────────
// Distinct truth table from the instance gate: fires ONLY in the non-plan,
// owner-owned, dirty-vs-servingsDefault corner. The two gates are mutually
// exclusive on the canPersist axis, so a screen render shows at most one Save.

test("canonical Save shows ONLY in the non-plan, owner, dirty corner", () => {
  // !canPersist && isOwner && dirty vs servingsDefault → show.
  assert.equal(shouldShowCanonicalSaveServings(false, true, 6, 4), true);
  assert.equal(shouldShowCanonicalSaveServings(false, true, 2, 4), true);
});

test("canonical Save hides when clean (display === servingsDefault)", () => {
  assert.equal(shouldShowCanonicalSaveServings(false, true, 4, 4), false);
});

test("canonical Save hides on a non-owned (curated/foreign) meal even when dirty", () => {
  assert.equal(shouldShowCanonicalSaveServings(false, false, 6, 4), false);
});

test("canonical Save never fires in a plan context (that's the instance gate's job)", () => {
  // canPersist === true: even owner + dirty must NOT show the canonical Save,
  // so the two gates can never both fire on the same render.
  assert.equal(shouldShowCanonicalSaveServings(true, true, 6, 4), false);
  assert.equal(shouldShowCanonicalSaveServings(true, true, 4, 4), false);
});

test("the two gates are mutually exclusive across the canPersist axis", () => {
  // Same dirty values, flip canPersist: exactly one gate is ever true.
  // Plan context → instance gate true, canonical false.
  assert.equal(shouldShowSaveServings(true, 6, 4), true);
  assert.equal(shouldShowCanonicalSaveServings(true, true, 6, 4), false);
  // Library context → canonical gate true (owner), instance false.
  assert.equal(shouldShowSaveServings(false, 6, 4), false);
  assert.equal(shouldShowCanonicalSaveServings(false, true, 6, 4), true);
});
