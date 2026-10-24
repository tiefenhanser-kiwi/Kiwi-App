// CLIENT-1 (BUG-507) — "Next step in N minutes" under a long Cook Mode step.
// The rule is the next step's start minus this one's, off the sequence's
// serve-anchored offsets, for a step of 20 minutes or more.

import assert from "node:assert/strict";
import { test } from "node:test";

import { NEXT_STEP_LINE_MIN_MINUTES, nextStepLine } from "../stepTiming";

type S = { key: string; estimatedMinutes: number; startOffsetMinutes?: number | null };

// A weeknight two-dish sequence (offsets: minutes before serving): the roast
// goes in at T-45 for 40 minutes, the rice starts 12 minutes later, then the
// salad, then the roast comes out.
const WEEKNIGHT: S[] = [
  { key: "roast#0", estimatedMinutes: 5, startOffsetMinutes: -50 },
  { key: "roast#1", estimatedMinutes: 40, startOffsetMinutes: -45 },
  { key: "rice#0", estimatedMinutes: 20, startOffsetMinutes: -33 },
  { key: "salad#0", estimatedMinutes: 6, startOffsetMinutes: -13 },
  { key: "rice#1", estimatedMinutes: 2, startOffsetMinutes: -13 },
  { key: "roast#2", estimatedMinutes: 5, startOffsetMinutes: -5 },
];

test("the threshold is 20 minutes", () => {
  assert.equal(NEXT_STEP_LINE_MIN_MINUTES, 20);
});

test("a long step says when the next step — any dish's — starts", () => {
  assert.equal(nextStepLine(WEEKNIGHT, 1), "Next step in 12 minutes");
  // 20 minutes exactly is long; the next step (another dish) 20 later.
  assert.equal(nextStepLine(WEEKNIGHT, 2), "Next step in 20 minutes");
});

test("a short step gets no line", () => {
  assert.equal(nextStepLine(WEEKNIGHT, 0), null);
  assert.equal(nextStepLine(WEEKNIGHT, 3), null);
  assert.equal(nextStepLine([{ key: "a", estimatedMinutes: 19, startOffsetMinutes: -30 }, { key: "b", estimatedMinutes: 5, startOffsetMinutes: -5 }], 0), null);
});

test("under 1 minute — the next step starts with this one — is 'now'; 1 minute is singular", () => {
  const steps: S[] = [
    { key: "a", estimatedMinutes: 25, startOffsetMinutes: -30 },
    { key: "b", estimatedMinutes: 25, startOffsetMinutes: -29.5 },
    { key: "c", estimatedMinutes: 25, startOffsetMinutes: -28.5 },
  ];
  assert.equal(nextStepLine(steps, 0), "Next step now");
  assert.equal(nextStepLine(steps, 1), "Next step in 1 minute");
});

test("a step Prep the Week already did is stepped over, as Next steps over it", () => {
  const done = new Set(["rice#0"]);
  assert.equal(nextStepLine(WEEKNIGHT, 1, done), "Next step in 32 minutes");
});

test("no offset, no line: an unsequenced meal, §27's append, the last step", () => {
  const flat: S[] = [
    { key: "a", estimatedMinutes: 30 },
    { key: "b", estimatedMinutes: 5 },
  ];
  assert.equal(nextStepLine(flat, 0), null);
  assert.equal(nextStepLine([...WEEKNIGHT.slice(0, 2), { key: "appended", estimatedMinutes: 3, startOffsetMinutes: null }], 1), null);
  assert.equal(nextStepLine([{ key: "z", estimatedMinutes: 30, startOffsetMinutes: -30 }], 0), null);
});

test("a feast: the bird's long roast, the sides' step after it, and after-serving steps", () => {
  const feast: S[] = [
    { key: "bird#3", estimatedMinutes: 180, startOffsetMinutes: -240 },
    { key: "stuffing#0", estimatedMinutes: 15, startOffsetMinutes: -95 },
    { key: "pie#2", estimatedMinutes: 30, startOffsetMinutes: 0 },
    { key: "pie#3", estimatedMinutes: 5, startOffsetMinutes: 30 },
  ];
  assert.equal(nextStepLine(feast, 0), "Next step in 145 minutes");
  assert.equal(nextStepLine(feast, 2), "Next step in 30 minutes");
});
