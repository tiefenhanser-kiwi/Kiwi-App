// WS9 BUG-337 / D-WS9-297 ruling 5 — the third clock, removed.
//
// Cook Mode's footer showed `remainingMinutes(activeSteps, safeIndex)`, a flat Σ
// of step minutes. On the 13-plan census that overstated 48 of 54 meals, median
// 43% over, worst 167%: the Carne Asada Tacos footer read 116 minutes beside a
// card reading 88, from the same steps. The scheduler's serve-anchored offset was
// already on the wire and ignored.
//
// The numbers in the Carne Asada fixture below are the census's own.

import assert from "node:assert/strict";
import { test } from "node:test";

import { remainingMinutes, remainingMinutesToServe, sequenceMealSteps } from "../cookSession";
import type { CookStep } from "../cookSession";
import type { SequencedStep } from "@/lib/api/cooking";
import type { MealDetail, MealStep } from "@/lib/api/meals";

// ── fixtures ────────────────────────────────────────────────────────────────

function mealStep(o: Partial<MealStep> & { stepIndex: number }): MealStep {
  return {
    stepIndex: o.stepIndex,
    text: o.text ?? `step ${o.stepIndex}`,
    phaseType: o.phaseType ?? "cook",
    estimatedMinutes: o.estimatedMinutes ?? 5,
    isTimingSensitive: o.isTimingSensitive ?? false,
    amountRefs: o.amountRefs ?? null,
  } as MealStep;
}

/**
 * The Carne Asada Tacos shape, reduced to the five dishes and the minute values
 * the census recorded. Σ estimatedMinutes = 116; the schedule's wall clock = 88.
 */
function carneAsadaMeal(): MealDetail {
  const d = (dishId: string, title: string, positionIndex: number, mins: number[]): unknown => ({
    dishId,
    title,
    roleLabel: positionIndex === 0 ? "main" : "side",
    positionIndex,
    minutes: mins.reduce((a, b) => a + b, 0),
    difficulty: "medium",
    servings: 4,
    ingredients: [],
    steps: mins.map((m, i) => mealStep({ stepIndex: i, estimatedMinutes: m, text: `${title} ${i}` })),
  });
  return {
    steps: [],
    dishes: [
      d("steak", "Carne Asada", 0, [5, 30, 3, 5, 8, 5, 3, 3, 2]),
      d("pico", "Pico de Gallo", 1, [5, 3, 2, 10, 1]),
      d("guac", "Guacamole", 2, [4, 3, 2, 5, 1]),
      d("tort", "Warm Corn Tortillas", 3, [8, 2, 1]),
      d("top", "Taco Toppings", 4, [3, 2]),
    ],
  } as unknown as MealDetail;
}

/** A schedule whose offsets say 88 minutes, the way the server emits them. */
function carneAsadaSequence(): SequencedStep[] {
  // Only the first entry's offset matters to the assertions; the rest are shaped
  // plausibly so the join covers every source step and nothing is appended.
  const meal = carneAsadaMeal();
  const out: SequencedStep[] = [];
  let seqIdx = 0;
  let offset = -88;
  for (const dish of meal.dishes) {
    for (const s of dish.steps) {
      out.push({
        dishId: dish.dishId,
        originalStepIndex: s.stepIndex,
        sequenceIndex: seqIdx++,
        startOffsetMinutes: Math.min(0, offset),
      });
      offset += 3;
    }
  }
  return out;
}

// ── remainingMinutesToServe ────────────────────────────────────────────────

test("remainingMinutesToServe: reads the serve-anchored offset, not a sum of minutes", () => {
  const steps: CookStep[] = [
    { key: "a", text: "x", phaseType: "prep", estimatedMinutes: 5, isPrep: true, isTimingSensitive: false, startOffsetMinutes: -88 },
    { key: "b", text: "y", phaseType: "rest", estimatedMinutes: 30, isPrep: false, isTimingSensitive: false, startOffsetMinutes: -83 },
    { key: "c", text: "z", phaseType: "assemble", estimatedMinutes: 2, isPrep: false, isTimingSensitive: false, startOffsetMinutes: -2 },
  ];
  assert.equal(remainingMinutesToServe(steps, 0), 88);
  assert.equal(remainingMinutesToServe(steps, 1), 83);
  assert.equal(remainingMinutesToServe(steps, 2), 2);
  // The old clock, on the same steps, is a different and larger number.
  assert.equal(remainingMinutes(steps, 0), 37);
});

test("remainingMinutesToServe: null when the step carries no offset, so the caller can fall back", () => {
  const noOffset: CookStep[] = [
    { key: "a", text: "x", phaseType: "prep", estimatedMinutes: 5, isPrep: true, isTimingSensitive: false },
  ];
  assert.equal(remainingMinutesToServe(noOffset, 0), null);
  // An explicit null (the §27 append shape) is treated the same as absent.
  assert.equal(remainingMinutesToServe([{ startOffsetMinutes: null }], 0), null);
  // Out of range is null, never NaN or a negative.
  assert.equal(remainingMinutesToServe(noOffset, 9), null);
  assert.equal(remainingMinutesToServe([], 0), null);
});

test("remainingMinutesToServe: the serve step itself is 0, never negative", () => {
  assert.equal(remainingMinutesToServe([{ startOffsetMinutes: 0 }], 0), 0);
  // A positive offset cannot occur on the wire (the schema is nonpositive), but
  // clamping means a bad row shows 0 rather than a negative countdown.
  assert.equal(remainingMinutesToServe([{ startOffsetMinutes: 4 }], 0), 0);
});

// ── the join ────────────────────────────────────────────────────────────────

test("sequenceMealSteps carries startOffsetMinutes through from the wire", () => {
  const meal = carneAsadaMeal();
  const out = sequenceMealSteps(meal, carneAsadaSequence());
  assert.equal(out[0].startOffsetMinutes, -88);
  assert.ok(
    out.every((s) => s.startOffsetMinutes != null),
    "every joined step should carry an offset when the sequence covers the meal",
  );
});

test("THE REGRESSION: the footer's number now matches the schedule, not Σ step minutes", () => {
  const meal = carneAsadaMeal();
  const out = sequenceMealSteps(meal, carneAsadaSequence());
  // The census numbers: Σ = 116, the schedule = 88.
  assert.equal(remainingMinutes(out, 0), 116);
  assert.equal(remainingMinutesToServe(out, 0), 88);
  // And what the screen actually resolves (app/cook-session.tsx:277).
  const shown = remainingMinutesToServe(out, 0) ?? remainingMinutes(out, 0);
  assert.equal(shown, 88);
});

test("a step appended by §27 has no offset, so the fallback still answers", () => {
  const meal = carneAsadaMeal();
  // Drop the last dish from the sequence entirely — its steps are appended.
  const partial = carneAsadaSequence().filter((s) => s.dishId !== "top");
  const out = sequenceMealSteps(meal, partial);
  const appended = out.filter((s) => s.startOffsetMinutes == null);
  assert.equal(appended.length, 2, "Taco Toppings' two steps should be appended");
  const idx = out.indexOf(appended[0]);
  assert.equal(remainingMinutesToServe(out, idx), null);
  const shown = remainingMinutesToServe(out, idx) ?? remainingMinutes(out, idx);
  assert.equal(shown, 5, "falls back to the sum over the appended tail");
});

