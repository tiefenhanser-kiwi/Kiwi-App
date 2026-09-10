// WS9 BUG-249 — the per-generation cross-candidate repeat check.
//
// The check observes; it never changes a response. These tests pin the three
// verdicts a line can carry (a repeat, an exempted user-named repeat, clean),
// the shape the follow-up decision will be read from, and that a throw inside
// the check costs one warn line and nothing else.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { WizardPlanCandidate } from "../ai/schemas/wizard";
import { logger } from "../logger";
import {
  computeCandidateRepeats,
  logCandidateRepeatCheck,
  normalizeMealTitle,
} from "../wizardRepeatCheck";

function cand(
  id: string,
  mealTitles: string[],
  storeSlots?: { slotIndex: number; storeMealId: string }[],
): WizardPlanCandidate {
  return {
    id,
    title: `Plan ${id}`,
    tags: [],
    whyBullets: ["b"],
    mealTitles,
    dailyMacros: { calories: 500, proteinG: 30, carbsG: 40, fatG: 20 },
    ...(storeSlots ? { storeSlots } : {}),
  };
}

/** Capture every info/warn object the helper emits, restoring the real logger after. */
async function captureLogs(run: () => void | Promise<void>) {
  const lines: Array<{ level: "info" | "warn"; obj: Record<string, unknown> }> = [];
  const realInfo = logger.info.bind(logger);
  const realWarn = logger.warn.bind(logger);
  const L = logger as unknown as { info: unknown; warn: unknown };
  L.info = ((obj: unknown, ...rest: unknown[]) => {
    if (obj && typeof obj === "object") lines.push({ level: "info", obj: obj as Record<string, unknown> });
    return realInfo(obj as never, ...(rest as [never]));
  }) as never;
  L.warn = ((obj: unknown, ...rest: unknown[]) => {
    if (obj && typeof obj === "object") lines.push({ level: "warn", obj: obj as Record<string, unknown> });
    return realWarn(obj as never, ...(rest as [never]));
  }) as never;
  try {
    await run();
  } finally {
    L.info = realInfo;
    L.warn = realWarn;
  }
  return lines.filter((l) => l.obj.event === "wizard_candidate_repeat_check" || l.obj.event === "wizard_candidate_repeat_check_failed");
}

describe("BUG-249 — normalizeMealTitle", () => {
  it("lowercases, trims, collapses whitespace, strips punctuation", () => {
    assert.equal(normalizeMealTitle("  Beef  Street-Tacos, w/ Lime! "), "beef street tacos w lime");
    assert.equal(normalizeMealTitle("Sheet-Pan Harissa Chicken"), "sheet pan harissa chicken");
  });
});

describe("BUG-249 — computeCandidateRepeats", () => {
  it("a shelf meal in candidates 0 and 2 → one id repeat, repeatCount 1, indices [0, 2]", () => {
    const report = computeCandidateRepeats([
      cand("c1", ["Beef Street Tacos", "Pad Thai"], [{ slotIndex: 0, storeMealId: "meal-tacos" }]),
      cand("c2", ["Lemon Herb Salmon", "Big Greek Salad"]),
      cand("c3", ["Coconut Chickpea Curry", "Beef Street Tacos"], [{ slotIndex: 1, storeMealId: "meal-tacos" }]),
    ]);
    assert.equal(report.candidateCount, 3);
    assert.equal(report.repeatCount, 1);
    assert.deepEqual(report.repeatedIds, [{ key: "meal-tacos", title: "Beef Street Tacos", candidates: [0, 2] }]);
    // The matching title is the same shelf meal, already counted by id.
    assert.deepEqual(report.repeatedTitles, []);
    assert.deepEqual(report.exempted, []);
  });

  it("a fresh title composed twice (case/punctuation differ) → one title repeat", () => {
    const report = computeCandidateRepeats([
      cand("c1", ["Sheet-Pan Harissa Chicken", "Pad Thai"]),
      cand("c2", ["sheet pan harissa  chicken!", "Big Greek Salad"]),
    ]);
    assert.equal(report.repeatCount, 1);
    assert.deepEqual(report.repeatedIds, []);
    assert.equal(report.repeatedTitles.length, 1);
    assert.equal(report.repeatedTitles[0].key, "sheet pan harissa chicken");
    assert.deepEqual(report.repeatedTitles[0].candidates, [0, 1]);
  });

  it("a fresh title that copies a shelf meal from another candidate is a title repeat (not hidden by the id)", () => {
    const report = computeCandidateRepeats([
      cand("c1", ["Beef Street Tacos"], [{ slotIndex: 0, storeMealId: "meal-tacos" }]),
      cand("c2", ["Beef Street Tacos"]), // fresh, same dinner
    ]);
    assert.deepEqual(report.repeatedIds, []);
    assert.equal(report.repeatedTitles.length, 1);
    assert.equal(report.repeatCount, 1);
  });

  it("the same meal twice within ONE candidate is not a cross-candidate repeat", () => {
    const report = computeCandidateRepeats([
      cand("c1", ["Pad Thai", "Pad Thai"], [{ slotIndex: 0, storeMealId: "m1" }, { slotIndex: 1, storeMealId: "m1" }]),
      cand("c2", ["Big Greek Salad"]),
    ]);
    assert.equal(report.repeatCount, 0);
  });

  it("a repeat matching a user-named meal (containment either direction) is exempted and NOT counted", () => {
    const report = computeCandidateRepeats(
      [
        cand("c1", ["Beef Street Tacos", "Pad Thai"], [{ slotIndex: 0, storeMealId: "meal-tacos" }]),
        cand("c2", ["Beef Street Tacos", "Big Greek Salad"], [{ slotIndex: 0, storeMealId: "meal-tacos" }]),
        cand("c3", ["Beef Street Tacos", "Spaghetti Carbonara"], [{ slotIndex: 0, storeMealId: "meal-tacos" }]),
      ],
      ["tacos"],
    );
    assert.equal(report.repeatCount, 0);
    assert.deepEqual(report.repeatedIds, []);
    assert.equal(report.exempted.length, 1);
    assert.equal(report.exempted[0].key, "meal-tacos");
    assert.deepEqual(report.exempted[0].candidates, [0, 1, 2]);

    // The other direction: the named meal is longer than the title.
    const r2 = computeCandidateRepeats(
      [cand("c1", ["Carbonara"]), cand("c2", ["carbonara"])],
      ["Spaghetti Carbonara with pancetta"],
    );
    assert.equal(r2.repeatCount, 0);
    assert.equal(r2.exempted.length, 1);
  });

  it("an exempted named meal does not hide a second, unnamed repeat", () => {
    const report = computeCandidateRepeats(
      [
        cand("c1", ["Beef Tacos", "Pad Thai"]),
        cand("c2", ["Beef Tacos", "Pad Thai"]),
      ],
      ["tacos"],
    );
    assert.equal(report.exempted.length, 1);
    assert.equal(report.repeatCount, 1);
    assert.equal(report.repeatedTitles[0].key, "pad thai");
  });

  it("no repeat → repeatCount 0, empty lists", () => {
    const report = computeCandidateRepeats([
      cand("c1", ["A", "B"], [{ slotIndex: 0, storeMealId: "m-a" }]),
      cand("c2", ["C", "D"], [{ slotIndex: 0, storeMealId: "m-c" }]),
      cand("c3", ["E", "F"]),
    ]);
    assert.equal(report.repeatCount, 0);
    assert.deepEqual(report.repeatedIds, []);
    assert.deepEqual(report.repeatedTitles, []);
    assert.deepEqual(report.exempted, []);
  });
});

describe("BUG-249 — logCandidateRepeatCheck", () => {
  it("a repeat → exactly one WARN line with repeatCount ≥ 1 and the ids", async () => {
    const lines = await captureLogs(() =>
      logCandidateRepeatCheck({
        route: "wizard.build_plans",
        path: "buffered",
        promptKey: "wizard.set_preferences.generate",
        userId: "u1",
        candidates: [
          cand("c1", ["Beef Street Tacos"], [{ slotIndex: 0, storeMealId: "meal-tacos" }]),
          cand("c2", ["Pad Thai"]),
          cand("c3", ["Beef Street Tacos"], [{ slotIndex: 0, storeMealId: "meal-tacos" }]),
        ],
      }),
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "warn");
    assert.equal(lines[0].obj.event, "wizard_candidate_repeat_check");
    assert.equal(lines[0].obj.route, "wizard.build_plans");
    assert.equal(lines[0].obj.promptKey, "wizard.set_preferences.generate");
    assert.equal(lines[0].obj.candidateCount, 3);
    assert.equal(lines[0].obj.repeatCount, 1);
    assert.deepEqual(lines[0].obj.repeatedIds, [{ key: "meal-tacos", title: "Beef Street Tacos", candidates: [0, 2] }]);
  });

  it("an explicit-meal repeat → one line, exempted carries it, repeatCount 0, level info", async () => {
    const lines = await captureLogs(() =>
      logCandidateRepeatCheck({
        route: "tellkiwi.build_from_text",
        path: "buffered",
        promptKey: "wizard.directed.generate",
        userId: "u1",
        candidates: [
          cand("c1", ["Beef Street Tacos", "Pad Thai"], [{ slotIndex: 0, storeMealId: "meal-tacos" }]),
          cand("c2", ["Beef Street Tacos", "Big Greek Salad"], [{ slotIndex: 0, storeMealId: "meal-tacos" }]),
        ],
        explicitMeals: ["tacos"],
      }),
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "info");
    assert.equal(lines[0].obj.repeatCount, 0);
    const exempted = lines[0].obj.exempted as Array<{ key: string }>;
    assert.equal(exempted.length, 1);
    assert.equal(exempted[0].key, "meal-tacos");
  });

  it("no repeat → exactly one clean INFO line", async () => {
    const lines = await captureLogs(() =>
      logCandidateRepeatCheck({
        route: "wizard.build_plans",
        path: "buffered",
        promptKey: "wizard.set_preferences.generate",
        userId: "u1",
        candidates: [cand("c1", ["A"]), cand("c2", ["B"]), cand("c3", ["C"])],
      }),
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "info");
    assert.equal(lines[0].obj.repeatCount, 0);
  });

  it("fewer than two candidates → no line (not a multi-candidate generation)", async () => {
    const lines = await captureLogs(() =>
      logCandidateRepeatCheck({
        route: "wizard.surprise_me",
        path: "buffered",
        promptKey: "wizard.surprise.generate",
        userId: "u1",
        candidates: [cand("c1", ["A"])],
      }),
    );
    assert.equal(lines.length, 0);
  });

  it("a throw inside the check is swallowed into one warn line", async () => {
    const lines = await captureLogs(() =>
      logCandidateRepeatCheck({
        route: "wizard.build_plans",
        path: "buffered",
        promptKey: "wizard.set_preferences.generate",
        userId: "u1",
        // A malformed candidate (mealTitles missing) makes the check throw.
        candidates: [{ id: "x" } as unknown as WizardPlanCandidate, cand("c2", ["B"])],
      }),
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].obj.event, "wizard_candidate_repeat_check_failed");
  });
});
