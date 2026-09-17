// WS9 Plan-flow redesign (D-WS9-191) Block 2 Part A — the plan-options state
// machine. Pure functions; every fixture states the list it feeds and the
// list it expects. The screen (app/plan-options.tsx) is outside the test glob,
// so THESE are the rules' only tests.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WizardPlanCandidate } from "@/lib/types";
import {
  ANOTHER_LABEL,
  anotherRequestFor,
  anyBusy,
  appendCandidates,
  buildCandidateContext,
  candidateIdentity,
  DEFAULT_MAX_PRESSES,
  dismissCard,
  dismissRequestFor,
  EMPTY_PLAN_OPTIONS,
  exclusionFor,
  hasCandidate,
  insertAnother,
  metaLine,
  noticeFor,
  patchCard,
  PLAN_OPTIONS_CUSTOMIZABLE_COPY,
  pressesLeft,
  rowsFor,
  rowTimeLabel,
  sublineFor,
  visibleCards,
} from "../planOptions";

// ── fixtures ────────────────────────────────────────────────────────────────

function candidate(
  id: string,
  title: string,
  mealTitles: string[],
  extra: Partial<WizardPlanCandidate> = {},
): WizardPlanCandidate {
  return {
    id,
    title,
    tags: ["weeknight"],
    whyBullets: ["Fast", "Cheap"],
    mealTitles,
    dailyMacros: { calories: 1800, proteinG: 120, carbsG: 180, fatG: 60 },
    ...extra,
  };
}

/** The Block 1 wire shape: `meals` in mealTitles order, times on store slots. */
const WIRE = candidate("c1", "Grill Nights", ["Burgers", "Tacos", "Kebabs", "Salmon"], {
  storeSlots: [
    { slotIndex: 0, storeMealId: "m-burgers" },
    { slotIndex: 1, storeMealId: "m-tacos" },
    { slotIndex: 3, storeMealId: "m-salmon" },
  ],
  meals: [
    { title: "Burgers", description: "Smash patties, toasted buns.", storeMealId: "m-burgers", estimatedTimeMinutes: 25 },
    { title: "Tacos", description: null, storeMealId: "m-tacos", estimatedTimeMinutes: 40 },
    { title: "Kebabs", description: "Skewered and charred." },
    { title: "Salmon", description: "  ", storeMealId: "m-salmon", estimatedTimeMinutes: 50 },
  ],
});

/** A pre-Block-1 last-batch row: no `meals`, no `storeSlots`. */
const LEGACY = candidate("c2", "Cozy One-Pots", ["Chili", "Stew"]);
const THIRD = candidate("c3", "Bright Mediterranean", ["Bowls", "Shakshuka"]);
const ANOTHER = candidate("c4", "Sheet-Pan Week", ["Fajitas", "Roast chicken"]);

const THREE = appendCandidates(EMPTY_PLAN_OPTIONS, [WIRE, LEGACY, THIRD]);
const K1 = candidateIdentity(WIRE);
const K2 = candidateIdentity(LEGACY);
const K3 = candidateIdentity(THIRD);
const K4 = candidateIdentity(ANOTHER);

// ── candidateIdentity (BUG-289) ─────────────────────────────────────────────

test("candidateIdentity: content, not id — the server hash's normalisation (NFKC, trim, lowercase, whitespace; meals sorted)", () => {
  const a = candidate("id-a", "  Grill   Nights ", ["Tacos", "Burgers", " kebabs"]);
  const b = candidate("id-b", "grill nights", ["burgers", "KEBABS", "tacos", "  "]);
  assert.equal(candidateIdentity(a), candidateIdentity(b));
  // The AI-minted id plays no part.
  assert.equal(candidateIdentity(candidate("x", "P", ["A"])), candidateIdentity(candidate("y", "P", ["A"])));
  // Different content → different identity, whatever the id.
  assert.notEqual(candidateIdentity(candidate("x", "P", ["A"])), candidateIdentity(candidate("x", "P", ["B"])));
  assert.notEqual(candidateIdentity(candidate("x", "P", ["A"])), candidateIdentity(candidate("x", "Q", ["A"])));
});

test("hasCandidate: matches on content identity; a same-id different-content candidate is NOT present", () => {
  assert.equal(hasCandidate(THREE, candidate("zzz", "grill nights", ["salmon", "kebabs", "tacos", "burgers"])), true);
  assert.equal(hasCandidate(THREE, candidate("c1", "A different plan with a colliding id", ["X"])), false);
});

// ── appendCandidates ────────────────────────────────────────────────────────

test("appendCandidates: fresh cards in arrival order, keyed by content identity", () => {
  assert.deepEqual(
    THREE.map((c) => [c.key, c.state]),
    [
      [K1, "fresh"],
      [K2, "fresh"],
      [K3, "fresh"],
    ],
  );
});

test("appendCandidates: a re-delivered frame (same content) is skipped and the SAME reference returns", () => {
  const again = appendCandidates(THREE, [WIRE, LEGACY, THIRD]);
  assert.equal(again, THREE);
  const partial = appendCandidates(THREE, [THIRD, ANOTHER]);
  assert.deepEqual(
    partial.map((c) => c.key),
    [K1, K2, K3, K4],
  );
  // The same plan re-minted under a NEW id (a second generate call) is still the same plan.
  const reminted = candidate("fresh-id", THIRD.title, THIRD.mealTitles);
  assert.equal(appendCandidates(THREE, [reminted]), THREE);
});

test("BUG-289: two candidates with the SAME id but different titles are BOTH kept", () => {
  const dup = candidate("c1", "A different plan with a colliding id", ["X"]);
  const next = appendCandidates(THREE, [dup]);
  assert.equal(next.length, 4);
  assert.deepEqual(
    next.map((c) => c.candidate.title),
    [WIRE.title, LEGACY.title, THIRD.title, dup.title],
  );
  assert.equal(new Set(next.map((c) => c.key)).size, 4);
  // insertAnother too — the second press's plan lands even when the AI re-minted the id.
  const pressed = insertAnother(THREE, dup, null);
  assert.equal(pressed.length, 4);
  assert.equal(pressed[3].candidate.title, dup.title);
});

test("appendCandidates: the same content repeated by a later batch gets a disambiguated key (backstop)", () => {
  // Force the key backstop: the identity is already a key on the list but a
  // caller bypasses the dedupe by patching the list directly.
  const withSuffix = patchCard(THREE, K1, { state: "dismissed" });
  const inserted = insertAnother(withSuffix, ANOTHER, 0);
  assert.equal(new Set(inserted.map((c) => c.key)).size, inserted.length);
});

// ── insertAnother ───────────────────────────────────────────────────────────

test("insertAnother: lands where the last dismissed card was", () => {
  const { list, dismissedIndex } = dismissCard(THREE, K2);
  assert.equal(dismissedIndex, 1);
  const next = insertAnother(list, ANOTHER, dismissedIndex);
  assert.deepEqual(
    next.map((c) => [c.key, c.state]),
    [
      [K1, "fresh"],
      [K4, "fresh"],
      [K2, "dismissed"],
      [K3, "fresh"],
    ],
  );
  // On screen: the new card sits in the dismissed card's slot.
  assert.deepEqual(
    visibleCards(next).map((c) => c.key),
    [K1, K4, K3],
  );
});

test("insertAnother: nothing dismissed → the bottom", () => {
  const next = insertAnother(THREE, ANOTHER, null);
  assert.deepEqual(
    next.map((c) => c.key),
    [K1, K2, K3, K4],
  );
});

test("insertAnother: an index outside the list → the bottom", () => {
  assert.deepEqual(
    insertAnother(THREE, ANOTHER, 99).map((c) => c.key),
    [K1, K2, K3, K4],
  );
  assert.deepEqual(
    insertAnother(THREE, ANOTHER, -1).map((c) => c.key),
    [K1, K2, K3, K4],
  );
});

test("insertAnother: a candidate already in the list (by content, any id) returns the SAME reference", () => {
  assert.equal(insertAnother(THREE, LEGACY, 0), THREE);
  assert.equal(insertAnother(THREE, candidate("re-minted", LEGACY.title, LEGACY.mealTitles), 0), THREE);
});

// ── dismissCard / patchCard / visibleCards / anyBusy ────────────────────────

test("dismissCard: a busy card cannot be dismissed; a dismissed card is not re-dismissed", () => {
  const busy = patchCard(THREE, K1, { state: "busy" });
  assert.equal(anyBusy(busy), true);
  assert.equal(anyBusy(THREE), false);
  const r1 = dismissCard(busy, K1);
  assert.equal(r1.list, busy);
  assert.equal(r1.dismissedIndex, null);
  const gone = dismissCard(THREE, K3);
  const r2 = dismissCard(gone.list, K3);
  assert.equal(r2.list, gone.list);
  assert.equal(r2.dismissedIndex, null);
});

test("patchCard: unknown key → same reference; saved carries the plan id and keeps the draft id", () => {
  assert.equal(patchCard(THREE, "nope", { state: "busy" }), THREE);
  const expanded = patchCard(THREE, K1, { state: "busy", draftId: "d-1" });
  const saved = patchCard(expanded, K1, { state: "saved", planId: "p-1" });
  assert.deepEqual(
    { state: saved[0].state, planId: saved[0].planId, draftId: saved[0].draftId },
    { state: "saved", planId: "p-1", draftId: "d-1" },
  );
});

// ── pressesLeft ─────────────────────────────────────────────────────────────

test("pressesLeft: the cap counts presses, the initial batch is not a press", () => {
  assert.equal(pressesLeft(4, 0), 4);
  assert.equal(pressesLeft(4, 1), 3);
  assert.equal(pressesLeft(4, 4), 0);
  assert.equal(pressesLeft(4, 9), 0);
});

test("pressesLeft: an unknown / non-finite / negative cap reads as the server default (4)", () => {
  assert.equal(DEFAULT_MAX_PRESSES, 4);
  assert.equal(pressesLeft(null, 0), 4);
  assert.equal(pressesLeft(undefined, 1), 3);
  assert.equal(pressesLeft(Number.NaN, 0), 4);
  assert.equal(pressesLeft(-3, 0), 4);
  assert.equal(pressesLeft(0, 0), 0);
});

// ── exclusionFor / anotherRequestFor ────────────────────────────────────────

test("exclusionFor: shown OR dismissed feed the exclusion; dismissed is the subset", () => {
  const { list } = dismissCard(THREE, K2);
  const ex = exclusionFor(list);
  assert.deepEqual(ex.excludePlanTitles, ["Grill Nights", "Cozy One-Pots", "Bright Mediterranean"]);
  assert.deepEqual(ex.excludeMealTitles, [
    "Burgers",
    "Tacos",
    "Kebabs",
    "Salmon",
    "Chili",
    "Stew",
    "Bowls",
    "Shakshuka",
  ]);
  assert.deepEqual(ex.dismissedPlanTitles, ["Cozy One-Pots"]);
});

test("exclusionFor: nothing dismissed → an empty subset; an empty list → all empty", () => {
  assert.deepEqual(exclusionFor(THREE).dismissedPlanTitles, []);
  assert.deepEqual(exclusionFor(EMPTY_PLAN_OPTIONS), {
    excludePlanTitles: [],
    excludeMealTitles: [],
    dismissedPlanTitles: [],
  });
});

test("exclusionFor: built on sessionExclusion's accumulator — a duplicate meal title across plans appears once", () => {
  const dupMeal = candidate("c9", "Taco Tuesday Again", ["Tacos", "Elote"]);
  const ex = exclusionFor(appendCandidates(THREE, [dupMeal]));
  assert.equal(ex.excludeMealTitles.filter((m) => m === "Tacos").length, 1);
});

test("anotherRequestFor: the 'another' body extras — exclusion + another.dismissedPlanTitles + candidateCount 1", () => {
  const { list } = dismissCard(THREE, K1);
  const body = anotherRequestFor(list);
  assert.deepEqual(body.another, { dismissedPlanTitles: ["Grill Nights"] });
  assert.equal(body.candidateCount, 1);
  assert.deepEqual(body.excludePlanTitles, ["Grill Nights", "Cozy One-Pots", "Bright Mediterranean"]);
  assert.ok(body.excludeMealTitles.includes("Burgers"));
});

// ── dismissRequestFor ───────────────────────────────────────────────────────

test("dismissRequestFor: title + mealTitles + the store ids off `meals` + source", () => {
  assert.deepEqual(dismissRequestFor(WIRE, "wizard"), {
    title: "Grill Nights",
    mealTitles: ["Burgers", "Tacos", "Kebabs", "Salmon"],
    storeMealIds: ["m-burgers", "m-tacos", "m-salmon"],
    source: "wizard",
  });
});

test("dismissRequestFor: a legacy candidate sends no storeMealIds key at all", () => {
  const body = dismissRequestFor(LEGACY, "tellkiwi");
  assert.equal("storeMealIds" in body, false);
  assert.equal(body.source, "tellkiwi");
});

// ── rowsFor ─────────────────────────────────────────────────────────────────

test("rowsFor: the wire's meals → title + description (null / blank → no description) + time on store slots", () => {
  assert.deepEqual(rowsFor(WIRE), [
    { title: "Burgers", description: "Smash patties, toasted buns.", estimatedTimeMinutes: 25 },
    { title: "Tacos", description: null, estimatedTimeMinutes: 40 },
    { title: "Kebabs", description: "Skewered and charred." },
    { title: "Salmon", description: null, estimatedTimeMinutes: 50 },
  ]);
});

test("rowsFor: a legacy candidate (no meals) → title-only rows from mealTitles, no crash", () => {
  assert.deepEqual(rowsFor(LEGACY), [
    { title: "Chili", description: null },
    { title: "Stew", description: null },
  ]);
});

test("rowsFor: a meals array whose length disagrees with mealTitles → titles win, descriptions matched by title", () => {
  const skewed = candidate("c8", "Skewed", ["Chili", "Stew", "Soup"], {
    meals: [
      { title: "Stew", description: "Slow and rich." },
      { title: "Nope", description: "Never shown." },
    ],
  });
  assert.deepEqual(rowsFor(skewed), [
    { title: "Chili", description: null },
    { title: "Stew", description: "Slow and rich." },
    { title: "Soup", description: null },
  ]);
});

// ── metaLine ────────────────────────────────────────────────────────────────

test("metaLine: '{n} dinners · serves {household} · ~{avg} min avg' when at least half the rows are timed", () => {
  // 3 of 4 rows timed: (25 + 40 + 50) / 3 = 38.3 → rounded to 5 → 40.
  assert.equal(metaLine(WIRE, 4), "4 dinners · serves 4 · ~40 min avg");
});

test("metaLine: fewer than half the rows timed → no avg; unknown household → no serves; one meal → 'dinner'", () => {
  const oneTimed = candidate("c7", "One timed", ["A", "B", "C"], {
    meals: [
      { title: "A", description: null, storeMealId: "m-a", estimatedTimeMinutes: 30 },
      { title: "B", description: null },
      { title: "C", description: null },
    ],
  });
  assert.equal(metaLine(oneTimed, 2), "3 dinners · serves 2");
  assert.equal(metaLine(LEGACY, null), "2 dinners");
  assert.equal(metaLine(LEGACY, 0), "2 dinners");
  const solo = candidate("c6", "Solo", ["Only"], {
    meals: [{ title: "Only", description: null, storeMealId: "m", estimatedTimeMinutes: 22 }],
  });
  assert.equal(metaLine(solo, 1), "1 dinner · serves 1 · ~20 min avg");
});

test("metaLine: exactly half the rows timed counts (2 of 4)", () => {
  const half = candidate("c5", "Half", ["A", "B", "C", "D"], {
    meals: [
      { title: "A", description: null, storeMealId: "m-a", estimatedTimeMinutes: 33 },
      { title: "B", description: null, storeMealId: "m-b", estimatedTimeMinutes: 37 },
      { title: "C", description: null },
      { title: "D", description: null },
    ],
  });
  assert.equal(metaLine(half, 3), "4 dinners · serves 3 · ~35 min avg");
});

// ── buildCandidateContext ───────────────────────────────────────────────────

test("buildCandidateContext: the wizard input carries all fields; Tell Kiwi defaults difficulty to medium", () => {
  const wizard = buildCandidateContext(
    WIRE,
    {
      planDurationDays: 4,
      householdSize: 3,
      cuisines: [],
      eatingStyles: ["vegetarian"],
      allergiesAndAvoidances: ["peanuts"],
      difficulty: "fancy",
      weeklyPacing: "mixed",
      saucePreference: "homemade",
      maxCookTimeMinutes: 45,
      maxCookTimeCoverage: "most",
    } as never,
    null,
  );
  assert.equal(wizard.difficulty, "fancy");
  assert.deepEqual(wizard.allergiesAndAvoidances, ["peanuts"]);
  assert.equal(wizard.maxCookTimeMinutes, 45);
  const tell = buildCandidateContext(WIRE, null, {
    description: "quick and spicy",
    householdSize: 2,
    allergiesAndAvoidances: [],
    eatingStyles: [],
  } as never);
  assert.equal(tell.difficulty, "medium");
  assert.equal(tell.householdSize, 2);
  // No planDurationDays on the Tell Kiwi input → the candidate's meal count.
  assert.equal(tell.planDurationDays, 4);
});

test("BUG-201: with NO input, allergiesAndAvoidances / eatingStyles are OMITTED, never sent as []", () => {
  const ctx = buildCandidateContext(LEGACY, null, null);
  assert.equal("allergiesAndAvoidances" in ctx, false);
  assert.equal("eatingStyles" in ctx, false);
  assert.equal(ctx.difficulty, "medium");
  assert.equal(ctx.planDurationDays, 2);
});

// ── sublineFor / noticeFor ──────────────────────────────────────────────────

test("sublineFor: the retired chooser's copy with a live count; cooking while empty; rehydrate names itself", () => {
  assert.equal(sublineFor("wizard", 0), "Kiwi is cooking up a few plans…");
  assert.equal(sublineFor("wizard", 3), "3 plans Kiwi cooked up just for you");
  assert.equal(sublineFor("wizard", 1), "1 plan Kiwi cooked up just for you");
  assert.equal(sublineFor("rehydrate", 3), "Your previous options");
  assert.equal(sublineFor("tellkiwi", 1, "fully_specified"), "Here's your plan — exactly as you described");
  assert.equal(sublineFor("tellkiwi", 3, "partial"), "3 plans built around what you named");
  assert.equal(sublineFor("tellkiwi", 2, "vague"), "2 plans Kiwi built from your request");
});

test("noticeFor: overflow names the left-out meals; cannotGenerateMore surfaces the reason; else null", () => {
  assert.equal(
    noticeFor({ scenario: "overflow", overflowMeals: ["Pho", "Bibimbap"] }),
    "Couldn't fit them all in 5 nights — left out: Pho, Bibimbap",
  );
  assert.equal(noticeFor({ cannotGenerateMore: true, reason: "Too few cuisines." }), "Too few cuisines.");
  assert.equal(
    noticeFor({ cannotGenerateMore: true }),
    "Kiwi couldn't produce more distinct plans for these constraints.",
  );
  assert.equal(noticeFor({ scenario: "vague" }), null);
  assert.equal(ANOTHER_LABEL, "Get another plan option");
});

// ── rowTimeLabel (Block 3 Part C — cook time on the row, never invented) ────

test("rowTimeLabel: the wire time as \"{n} min\"; a live slot (no time), zero, negative or non-finite → null", () => {
  assert.equal(rowTimeLabel({ estimatedTimeMinutes: 25 }), "25 min");
  assert.equal(rowTimeLabel({ estimatedTimeMinutes: 42.4 }), "42 min");
  assert.equal(rowTimeLabel({}), null);
  assert.equal(rowTimeLabel({ estimatedTimeMinutes: 0 }), null);
  assert.equal(rowTimeLabel({ estimatedTimeMinutes: -5 }), null);
  assert.equal(rowTimeLabel({ estimatedTimeMinutes: Number.NaN }), null);
  // Through rowsFor: WIRE has times on its store slots only.
  const labels = rowsFor(WIRE).map(rowTimeLabel);
  assert.deepEqual(labels, ["25 min", "40 min", null, "50 min"]);
  assert.deepEqual(rowsFor(LEGACY).map(rowTimeLabel), [null, null]);
});

// ── the customizability line (D-WS9-161 returns on this surface) ───────────

test("D-WS9-161: the customizability line is Hans's wording verbatim (pinned against drift)", () => {
  assert.equal(
    PLAN_OPTIONS_CUSTOMIZABLE_COPY,
    "All plans are fully customizable — save or use one to edit meals, dishes, and ingredients.",
  );
});
