// WS7-8b Block A (BUG-024) — Week-Prep auto-advance guard tests.
//
// The one subtle correctness point: reaching a phase's all-done state advances
// EXACTLY ONCE, whether it was reached by checking the last step (the effect) or
// by "Mark all complete" (the button) — and never on mount / empty / resumed
// phases. We VERIFY that by driving the pure helpers through the exact call
// sequences the container makes for each path (§27), not by asserting it.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isPrepAllDoneEdge,
  releasePrepAdvance,
  requestPrepAdvance,
  type PrepAdvanceEffect,
  type PrepAllDoneObservation,
} from "../prepAutoAdvance";

const PHASE_COUNT = 4; // the fixed 4 prep phases

// ── requestPrepAdvance (the latch) ────────────────────────────────────────────

test("requestPrepAdvance: a fresh (unlatched) non-last phase advances to from+1", () => {
  const { latch, effect } = requestPrepAdvance(null, 1, PHASE_COUNT);
  assert.equal(latch, 1);
  assert.deepEqual(effect, { kind: "advance", from: 1, to: 2 });
});

test("requestPrepAdvance: the last phase finishes (never advances past the end)", () => {
  const { latch, effect } = requestPrepAdvance(null, 3, PHASE_COUNT);
  assert.equal(latch, 3);
  assert.deepEqual(effect, { kind: "finish", from: 3 });
});

test("requestPrepAdvance: a second call for the same latched phase is a no-op", () => {
  const first = requestPrepAdvance(null, 2, PHASE_COUNT);
  const second = requestPrepAdvance(first.latch, 2, PHASE_COUNT);
  assert.deepEqual(second.effect, { kind: "none" });
  assert.equal(second.latch, 2, "latch stays put on the no-op");
});

// ── releasePrepAdvance ────────────────────────────────────────────────────────

test("releasePrepAdvance: clears the latch only for the phase that holds it", () => {
  assert.equal(releasePrepAdvance(2, 2), null, "same index → released");
  assert.equal(releasePrepAdvance(2, 1), 2, "other index → untouched");
  assert.equal(releasePrepAdvance(null, 2), null);
});

// ── isPrepAllDoneEdge (the false→true gate) ───────────────────────────────────

test("isPrepAllDoneEdge: mount (no prior observation) is NOT an edge", () => {
  assert.equal(isPrepAllDoneEdge(null, 0, true), false);
});

test("isPrepAllDoneEdge: an already-done phase (empty / resumed) is NOT an edge", () => {
  const last: PrepAllDoneObservation = { index: 2, allDone: true };
  assert.equal(isPrepAllDoneEdge(last, 2, true), false);
});

test("isPrepAllDoneEdge: false→true on the same phase IS an edge", () => {
  const last: PrepAllDoneObservation = { index: 2, allDone: false };
  assert.equal(isPrepAllDoneEdge(last, 2, true), true);
});

test("isPrepAllDoneEdge: leaving all-done (true→false) is NOT an edge", () => {
  const last: PrepAllDoneObservation = { index: 2, allDone: true };
  assert.equal(isPrepAllDoneEdge(last, 2, false), false);
});

test("isPrepAllDoneEdge: a pointer move to a different index is NOT an edge", () => {
  const last: PrepAllDoneObservation = { index: 1, allDone: false };
  assert.equal(isPrepAllDoneEdge(last, 2, true), false);
});

// ── Faithful container simulation ─────────────────────────────────────────────
//
// A tiny model of PrepWeekScreen's guard: the two refs (latch + last-observed)
// and the two entry points that mutate them. `pointer`/`finished` stand in for
// setPhaseIndex/setToastVisible so we can count advances.

interface Sim {
  latch: number | null;
  last: PrepAllDoneObservation | null;
  pointer: number;
  advances: number;
  finishes: number;
}

function newSim(pointer: number): Sim {
  return { latch: null, last: null, pointer, advances: 0, finishes: 0 };
}

function apply(sim: Sim, completedIndex: number): PrepAdvanceEffect {
  const { latch, effect } = requestPrepAdvance(sim.latch, completedIndex, PHASE_COUNT);
  sim.latch = latch;
  if (effect.kind === "advance") {
    sim.pointer = effect.to; // ABSOLUTE — a repeat call can't skip
    sim.advances += 1;
  } else if (effect.kind === "finish") {
    sim.finishes += 1;
  }
  return effect;
}

// The per-step all-done EFFECT: gated on a false→true edge; releases on leaving.
function effectTick(sim: Sim, phaseIndex: number, allDone: boolean): void {
  const edge = isPrepAllDoneEdge(sim.last, phaseIndex, allDone);
  sim.last = { index: phaseIndex, allDone };
  if (!allDone) {
    sim.latch = releasePrepAdvance(sim.latch, phaseIndex);
    return;
  }
  if (edge) apply(sim, phaseIndex);
}

// The "Mark all complete" BUTTON path: its `.then` calls commitAdvance directly.
function buttonTick(sim: Sim, phaseIndex: number): void {
  apply(sim, phaseIndex);
}

test("core: checking the last step of a phase advances exactly once to the next", () => {
  const sim = newSim(1);
  effectTick(sim, 1, false); // baseline: phase 1 not yet done (2 of 3 checked)
  effectTick(sim, 1, true); // last step checked → false→true edge
  assert.equal(sim.pointer, 2, "advanced to the next phase");
  assert.equal(sim.advances, 1, "exactly one advance");
  assert.equal(sim.finishes, 0);
});

test("guard: button then effect on the same completion advances exactly ONCE", () => {
  // "Mark all complete": the optimistic write flips all-done true (effect edge)
  // AND the promise `.then` fires commitAdvance. Model both, button first.
  const sim = newSim(1);
  effectTick(sim, 1, false); // baseline before the write
  buttonTick(sim, 1); // .then → commitAdvance
  effectTick(sim, 1, true); // optimistic write flips all-done → edge
  assert.equal(sim.pointer, 2, "advanced exactly one phase, not two");
  assert.equal(sim.advances, 1, "the second caller is a latch no-op");
});

test("guard: effect then button on the same completion advances exactly ONCE", () => {
  // Reverse arrival order (effect's edge commits before the promise resolves).
  const sim = newSim(1);
  effectTick(sim, 1, false);
  effectTick(sim, 1, true); // edge advances first
  buttonTick(sim, 1); // .then → latch no-op
  assert.equal(sim.pointer, 2, "still one phase, never skipped to 3");
  assert.equal(sim.advances, 1);
});

test("guard: mount on a vacuously-empty (already all-done) phase does NOT advance", () => {
  const sim = newSim(0);
  effectTick(sim, 0, true); // phase 0 empty → all-done from the first observation
  assert.equal(sim.pointer, 0, "stays put — no edge on mount");
  assert.equal(sim.advances, 0);
});

test("last phase: checking the final step finishes, does not advance past the end", () => {
  const sim = newSim(3);
  effectTick(sim, 3, false);
  effectTick(sim, 3, true); // last step of the last phase
  assert.equal(sim.finishes, 1, "terminal finish fires");
  assert.equal(sim.advances, 0, "never advances past the last phase");
  assert.equal(sim.pointer, 3);
});

test("last phase: button + effect finish exactly once (no double terminal toast)", () => {
  const sim = newSim(3);
  effectTick(sim, 3, false);
  buttonTick(sim, 3);
  effectTick(sim, 3, true);
  assert.equal(sim.finishes, 1, "finish fires once across both channels");
});

test("re-completion: uncheck then recheck a phase advances again (latch released)", () => {
  const sim = newSim(1);
  effectTick(sim, 1, false);
  effectTick(sim, 1, true); // advance to phase 2 (latch = 1)
  assert.equal(sim.advances, 1);
  // User taps Back to phase 1 (still all-done) — no edge, no re-advance.
  effectTick(sim, 1, true);
  assert.equal(sim.advances, 1, "returning to a done phase does not re-advance");
  // Uncheck a step (latch releases), then recheck (fresh edge) → advances again.
  effectTick(sim, 1, false);
  effectTick(sim, 1, true);
  assert.equal(sim.advances, 2, "re-completing the phase advances again");
  assert.equal(sim.pointer, 2);
});
