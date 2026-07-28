// Plan-Gen Arc Block 4b-3 (D-WS9-072) — "See Previous Options" helper tests.
// Pins the link's show/hide rule and the wizard-results rehydrate params so the
// three source branches (wizard / tellkiwi / surprise) navigate correctly and a
// rehydrated candidate round-trips VERBATIM (which is what makes its server hash
// match, so re-expand reuses the draft instead of calling the AI).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRehydrateParams,
  shouldShowPreviousOptions,
} from "../previousOptions";
import type { WizardLastBatch } from "../../api/wizard";

const CANDIDATES = [
  {
    id: "c1",
    title: "Cozy Comfort Week",
    tags: ["Comfort"],
    whyBullets: ["one-pot meals"],
    mealTitles: ["Soup", "Chili", "Stew"],
    dailyMacros: { calories: 540, proteinG: 28, carbsG: 56, fatG: 22 },
  },
];

function batch(overrides: Partial<WizardLastBatch> = {}): WizardLastBatch {
  return {
    source: "wizard",
    candidates: CANDIDATES,
    input: { planDurationDays: 5 },
    createdAt: "2026-07-27T12:00:00.000Z",
    ...overrides,
  } as WizardLastBatch;
}

test("shouldShowPreviousOptions — hidden with no batch", () => {
  assert.equal(shouldShowPreviousOptions(null), false);
  assert.equal(shouldShowPreviousOptions(undefined), false);
});

test("shouldShowPreviousOptions — hidden for a degenerate empty batch", () => {
  assert.equal(shouldShowPreviousOptions(batch({ candidates: [] })), false);
});

test("shouldShowPreviousOptions — shown when a batch has candidates", () => {
  assert.equal(shouldShowPreviousOptions(batch()), true);
});

test("buildRehydrateParams — wizard replays input, flags rehydrate", () => {
  const p = buildRehydrateParams(batch({ source: "wizard" }));
  assert.equal(p.rehydrate, "1");
  assert.equal(p.source, undefined); // wizard is the default results path
  assert.equal(JSON.parse(p.input).planDurationDays, 5);
  // Candidates round-trip VERBATIM — same title + mealTitles the server hashed.
  assert.deepEqual(JSON.parse(p.rehydratedCandidates), CANDIDATES);
});

test("buildRehydrateParams — tellkiwi carries source + tellKiwiInput", () => {
  const p = buildRehydrateParams(
    batch({ source: "tellkiwi", input: { description: "easy week" } }),
  );
  assert.equal(p.rehydrate, "1");
  assert.equal(p.source, "tellkiwi");
  assert.equal(JSON.parse(p.tellKiwiInput).description, "easy week");
  assert.equal(p.input, undefined);
});

test("buildRehydrateParams — surprise carries source, NO input", () => {
  const p = buildRehydrateParams(batch({ source: "surprise", input: null }));
  assert.equal(p.rehydrate, "1");
  assert.equal(p.source, "surprise");
  assert.equal(p.input, undefined);
  assert.equal(p.tellKiwiInput, undefined);
});

test("buildRehydrateParams — omits input when a wizard batch has none", () => {
  const p = buildRehydrateParams(batch({ source: "wizard", input: null }));
  assert.equal(p.rehydrate, "1");
  assert.equal(p.input, undefined);
});
