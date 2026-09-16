// Plan-Gen Arc Block 4b-3 (D-WS9-072) — "See Previous Options" helper tests.
// Pins the link's show/hide rule and the wizard-results rehydrate params so the
// two source branches (wizard / tellkiwi — surprise went with Surprise Me in
// Redesign Arc Block 2a) navigate correctly and a
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
    // BUG-049/050 regression guard — storeSlots must survive the rehydrate JSON
    // round trip (an omitted-field fixture was structurally blind to it). These
    // carry REAL Meal.ids, as the server now commits post-reconcile (BUG-050).
    storeSlots: [{ slotIndex: 0, storeMealId: "meal-real-abc123" }],
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

test("buildRehydrateParams — storeSlots survive the round trip (BUG-049/050)", () => {
  const p = buildRehydrateParams(batch({ source: "wizard" }));
  const round = JSON.parse(p.rehydratedCandidates) as Array<{
    storeSlots?: Array<{ slotIndex: number; storeMealId: string }>;
  }>;
  // The field is preserved AND still carries the real Meal.id, not an alias.
  assert.deepEqual(round[0].storeSlots, [
    { slotIndex: 0, storeMealId: "meal-real-abc123" },
  ]);
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

test("buildRehydrateParams — omits input when a wizard batch has none", () => {
  const p = buildRehydrateParams(batch({ source: "wizard", input: null }));
  assert.equal(p.rehydrate, "1");
  assert.equal(p.input, undefined);
});

// ── Block 2b (2a CANDIDATE-1, ruled) — legacy Surprise Me rows ──────────────

test("a pre-Block-2 source:'surprise' row parses (read-tolerant) and the link HIDES", () => {
  // The server tolerates the retired value on read (WizardBatchSourceOnRead);
  // so does the mobile union — a schema error here would hide the link for
  // the wrong reason (and log an ApiSchemaError for a row that is merely old).
  const legacy = batch({ source: "surprise" as WizardLastBatch["source"], input: null });
  assert.equal(shouldShowPreviousOptions(legacy), false);
  // …and a real batch still shows.
  assert.equal(shouldShowPreviousOptions(batch()), true);
});

// ── Block 2c Part E — a SHELF batch ("Meals to choose from") ────────────────

const SHELF_MEALS = [
  {
    id: "m1", title: "Miso Salmon", description: null, cuisineType: "Japanese", difficulty: "easy",
    estimatedTimeMinutes: 30, activeTimeMinutes: 15,
    macrosPerServing: { calories: 500, protein: 30, carbs: 40, fat: 20 }, tags: ["quick"], dishCount: 2,
    isNewToYou: true, isPlaylist: false, isPinned: false, matchesCuisine: true, source: "catalog",
  },
  {
    id: "m2", title: "Chicken Tacos", description: null, cuisineType: "Mexican", difficulty: "easy",
    estimatedTimeMinutes: 25, activeTimeMinutes: 20,
    macrosPerServing: { calories: 600, protein: 35, carbs: 50, fat: 25 }, tags: [], dishCount: 1,
    isNewToYou: false, isPlaylist: true, isPinned: false, matchesCuisine: false, source: "playlist",
  },
];
const SHELF_INPUT = {
  planDurationDays: 4, householdSize: 3, cuisines: ["Japanese"], difficulty: "medium",
  weeklyPacing: "mixed", maxCookTimeMinutes: 40,
};
function shelfBatch(overrides: Partial<WizardLastBatch> = {}): WizardLastBatch {
  return {
    source: "shelf",
    candidates: [],
    meals: SHELF_MEALS,
    mealIds: ["m1", "m2"],
    input: SHELF_INPUT,
    createdAt: "2026-09-16T12:00:00.000Z",
    ...overrides,
  } as WizardLastBatch;
}

test("shelf batch - shown when it still has cards; an empty / fully-stale one hides", async () => {
  const { buildShelfRehydrateParams, previousOptionsSubtitle } = await import("../previousOptions");
  assert.equal(shouldShowPreviousOptions(shelfBatch()), true);
  assert.equal(shouldShowPreviousOptions(shelfBatch({ meals: [] })), false, "empty");
  assert.equal(
    shouldShowPreviousOptions(shelfBatch({ meals: undefined, mealIds: ["gone-1"] })),
    false,
    "ids with no cards = fully stale, hidden",
  );
  assert.equal(previousOptionsSubtitle(shelfBatch()), "Your last 2 suggested meals");
  assert.equal(previousOptionsSubtitle(batch()), "Your last generated plan");
  assert.equal(buildShelfRehydrateParams(batch()), null, "a plans batch is not a shelf");
});

test("shelf batch - Pick params: the stored cards IN ORDER as the shelf, the stored request as the body, no selection, cap from the input", async () => {
  const { buildShelfRehydrateParams } = await import("../previousOptions");
  const p = buildShelfRehydrateParams(shelfBatch());
  assert.ok(p, "params");
  const shelf = JSON.parse(p!.shelf);
  assert.deepEqual(shelf.meals.map((m: { id: string }) => m.id), ["m1", "m2"]);
  assert.equal(shelf.totalEligible, 2);
  assert.equal(shelf.hasMore, true, "the user can page on from here");
  assert.deepEqual(JSON.parse(p!.request), SHELF_INPUT, "the request round-trips verbatim");
  assert.equal(p!.mode, "prefs");
  assert.equal(p!.planDurationDays, "4");
  assert.equal(p!.householdSize, "3");
  assert.equal(p!.capMinutes, "40");
  // A text-mode shelf: the text in the input flips the mode.
  const t = buildShelfRehydrateParams(shelfBatch({ input: { ...SHELF_INPUT, text: "tacos week" } }));
  assert.equal(t!.mode, "text");
});
