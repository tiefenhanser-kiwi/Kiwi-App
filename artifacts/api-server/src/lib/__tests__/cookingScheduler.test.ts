// WS7-8b BUG-018 B2 — deterministic Cooking Sequencer unit tests.
//
// The two NAMED fixtures below ARE the bug: they are the exact cases the Sonnet
// sequencer got wrong (D-WS7-164 started the shorter roast first; BUG-018 let
// the corn finish 25 min early and go cold). They pin the fix.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scheduleCookingSequence,
  type SchedulerDish,
  type SchedulerStep,
  type ScheduleResult,
} from "../cookingScheduler";

// ── helpers ───────────────────────────────────────────────────────────────

function step(
  stepIndex: number,
  estimatedMinutes: number,
  phaseType: SchedulerStep["phaseType"],
  isTimingSensitive = false,
): SchedulerStep {
  return { stepIndex, estimatedMinutes, phaseType, isTimingSensitive };
}

/** Mirrors cookingScheduler.isUnattended — attended = occupies the cook's hands. */
function isAttended(s: SchedulerStep): boolean {
  if (s.phaseType === "prep" || s.phaseType === "assemble") return true;
  if (s.phaseType === "cook") return s.isTimingSensitive;
  return false; // preheat / rest / hold
}

interface Analyzed {
  dishId: string;
  stepIndex: number;
  sequenceIndex: number;
  offset: number;
  startAbs: number;
  finishAbs: number;
  duration: number;
  attended: boolean;
  reason?: string;
}

/** Reconstruct the absolute (cook-start-frame) timeline from serve-anchored offsets. */
function analyze(result: ScheduleResult, dishes: SchedulerDish[]): Analyzed[] {
  const serve = result.totalEstimatedMinutes;
  const src = new Map<string, SchedulerStep>();
  for (const d of dishes)
    for (const s of d.steps) src.set(`${d.dishId}#${s.stepIndex}`, s);
  return result.steps.map((st) => {
    const s = src.get(`${st.dishId}#${st.originalStepIndex}`);
    if (!s) throw new Error(`output step ${st.dishId}#${st.originalStepIndex} not in input`);
    const startAbs = st.startOffsetMinutes + serve;
    return {
      dishId: st.dishId,
      stepIndex: st.originalStepIndex,
      sequenceIndex: st.sequenceIndex,
      offset: st.startOffsetMinutes,
      startAbs,
      finishAbs: startAbs + s.estimatedMinutes,
      duration: s.estimatedMinutes,
      attended: isAttended(s),
      reason: st.reason,
    };
  });
}

/** anchor = the theoretical earliest serve = the gating (longest) dish's duration. */
function anchorOf(dishes: SchedulerDish[]): number {
  return Math.max(
    ...dishes.map((d) => d.steps.reduce((a, s) => a + s.estimatedMinutes, 0)),
  );
}

// ── shared structural invariants (asserted on every fixture) ────────────────

function assertWellFormed(result: ScheduleResult, dishes: SchedulerDish[]) {
  const rows = analyze(result, dishes);
  const inputCount = dishes.reduce((n, d) => n + d.steps.length, 0);

  // Every input step appears exactly once.
  assert.equal(rows.length, inputCount, "every input step appears exactly once");
  const keys = new Set(rows.map((r) => `${r.dishId}#${r.stepIndex}`));
  assert.equal(keys.size, inputCount, "no duplicate step in output");

  // sequenceIndex is contiguous 0..n-1 in emission order.
  result.steps.forEach((s, i) =>
    assert.equal(s.sequenceIndex, i, "sequenceIndex contiguous + in order"),
  );

  // Intra-dish order preserved (a step never precedes an earlier step of its dish).
  const lastSeqByDish = new Map<string, number>();
  for (const s of result.steps) {
    const prev = lastSeqByDish.get(s.dishId);
    if (prev !== undefined)
      assert.ok(
        s.sequenceIndex > prev,
        `intra-dish order preserved for ${s.dishId}`,
      );
    lastSeqByDish.set(s.dishId, s.sequenceIndex);
  }

  // Serve-anchored: the latest finish is exactly serve (offset 0), nothing after.
  const maxFinishOffset = Math.max(...rows.map((r) => r.offset + r.duration));
  assert.equal(maxFinishOffset, 0, "latest finish sits at serve (offset 0)");
  assert.ok(
    rows.every((r) => r.offset <= 0),
    "no step starts after serve (all offsets <= 0)",
  );

  // ATTENTION / single cook: no two ATTENDED steps overlap in time. This
  // subsumes "never overlap a step onto an isTimingSensitive step" (a watched
  // cook is attended). Unattended steps (roast/boil/rest) may overlap freely.
  const attended = rows.filter((r) => r.attended);
  for (let i = 0; i < attended.length; i++) {
    for (let j = i + 1; j < attended.length; j++) {
      const a = attended[i];
      const b = attended[j];
      const overlap = a.startAbs < b.finishAbs && b.startAbs < a.finishAbs;
      assert.ok(
        !overlap,
        `attended steps must not overlap: ${a.dishId}#${a.stepIndex} [${a.startAbs},${a.finishAbs}) vs ${b.dishId}#${b.stepIndex} [${b.startAbs},${b.finishAbs})`,
      );
    }
  }

  // QUALITY: nothing finishes materially early. Every dish finishes no earlier
  // than the anchor (the earliest a single cook could possibly plate). This is
  // the invariant, not a magic number: the gating dish sets the floor and no
  // dish may complete before it.
  const anchor = anchorOf(dishes);
  const lastFinishByDish = new Map<string, number>();
  for (const r of rows) {
    lastFinishByDish.set(
      r.dishId,
      Math.max(lastFinishByDish.get(r.dishId) ?? 0, r.finishAbs),
    );
  }
  for (const [dishId, finish] of lastFinishByDish) {
    assert.ok(
      finish >= anchor - 1e-9,
      `${dishId} finishes at ${finish}, before the anchor ${anchor} (materially early)`,
    );
  }
}

// ── D-WS7-164 — the regression that names the bug ───────────────────────────

describe("scheduleCookingSequence — D-WS7-164 (longer roast starts first)", () => {
  // Two roasts, single unattended cook step each. Midpoints of the ranges in
  // the deferral: 20-25 -> 22, 28-32 -> 30. estimatedMinutes is already the
  // collapsed scalar (B1 finding — do not re-derive ranges).
  const dishes: SchedulerDish[] = [
    // Deliberately list the SHORTER dish first in input, to prove ordering is
    // computed from duration, not input position.
    {
      dishId: "roast-short",
      title: "Roasted Carrots",
      positionIndex: 0,
      steps: [step(0, 22, "cook", false)],
    },
    {
      dishId: "roast-long",
      title: "Roasted Chicken",
      positionIndex: 1,
      steps: [step(0, 30, "cook", false)],
    },
  ];

  it("starts the LONGER roast first and lands both at serve", () => {
    const result = scheduleCookingSequence(dishes);
    assertWellFormed(result, dishes);

    const rows = analyze(result, dishes);
    const long = rows.find((r) => r.dishId === "roast-long")!;
    const short = rows.find((r) => r.dishId === "roast-short")!;

    // THE BUG: the longer roast must start first.
    assert.ok(
      long.sequenceIndex < short.sequenceIndex,
      "longer roast is sequenced before the shorter",
    );
    // Serve-anchored offsets: longer starts 30 before serve, shorter 22 before.
    assert.equal(long.offset, -30, "long roast starts at T-30");
    assert.equal(short.offset, -22, "short roast starts at T-22");
    // Both finish exactly at serve — neither sits.
    assert.equal(long.finishAbs, result.totalEstimatedMinutes);
    assert.equal(short.finishAbs, result.totalEstimatedMinutes);
    assert.equal(result.totalEstimatedMinutes, 30);
  });
});

// ── BUG-018 — corn boiled during a 30-min grill came out cold ───────────────

describe("scheduleCookingSequence — BUG-018 (side must not finish early)", () => {
  // A 30-min grill (main) + a corn boil (side). Both are unattended cooks, so
  // they overlap; the side must be pushed late enough to finish AT serve, not
  // 20 minutes early and cold.
  const dishes: SchedulerDish[] = [
    {
      dishId: "grill",
      title: "Grilled Steak",
      positionIndex: 0,
      steps: [
        step(0, 2, "prep", false), // season
        step(1, 30, "cook", false), // grill (unattended, walk away)
      ],
    },
    {
      dishId: "corn",
      title: "Boiled Corn",
      positionIndex: 1,
      steps: [
        step(0, 2, "prep", false), // shuck
        step(1, 10, "cook", false), // boil (unattended)
      ],
    },
  ];

  it("does not let the corn finish materially before serve", () => {
    const result = scheduleCookingSequence(dishes);
    assertWellFormed(result, dishes);

    const rows = analyze(result, dishes);
    const cornBoil = rows.find(
      (r) => r.dishId === "corn" && r.stepIndex === 1,
    )!;
    // The corn boil finishes AT serve (offset 0), not ~20 min early.
    assert.equal(
      cornBoil.finishAbs,
      result.totalEstimatedMinutes,
      "corn finishes at serve",
    );
    assert.equal(cornBoil.offset, -10, "corn boil starts at T-10, not T-32");

    // The grill (the gating dish) leads.
    const grillLead = rows.find(
      (r) => r.dishId === "grill" && r.stepIndex === 0,
    )!;
    assert.equal(grillLead.sequenceIndex, 0, "grill prep leads the sequence");
    assert.equal(result.totalEstimatedMinutes, 32);
  });
});

// ── attention lock — a watched sear is never overlapped ─────────────────────

describe("scheduleCookingSequence — attention lock (isTimingSensitive)", () => {
  // Two dishes whose finish-aligned prep windows would collide; one has a
  // watched sear. The single-cook pass must serialize the attended work so no
  // step runs during the sear.
  const dishes: SchedulerDish[] = [
    {
      dishId: "steak",
      title: "Seared Steak",
      positionIndex: 0,
      steps: [
        step(0, 2, "prep", false),
        step(1, 6, "cook", true), // watched sear — attention lock
        step(2, 5, "rest", false),
      ],
    },
    {
      dishId: "salad",
      title: "Side Salad",
      positionIndex: 1,
      steps: [
        step(0, 3, "prep", false), // chop
        step(1, 2, "assemble", false), // toss
      ],
    },
  ];

  it("never overlaps another step onto the watched sear", () => {
    const result = scheduleCookingSequence(dishes);
    assertWellFormed(result, dishes); // includes the no-attended-overlap check

    const rows = analyze(result, dishes);
    const sear = rows.find((r) => r.dishId === "steak" && r.stepIndex === 1)!;
    // Nothing from another dish may run inside the sear's active window.
    for (const r of rows) {
      if (r.dishId === "steak") continue;
      const overlap = r.startAbs < sear.finishAbs && sear.startAbs < r.finishAbs;
      // Only unattended overlap would be allowed — but the salad has none here.
      assert.ok(!overlap, `${r.dishId}#${r.stepIndex} overlaps the sear`);
    }
  });
});

// ── passive-window cues + degenerate inputs ─────────────────────────────────

describe("scheduleCookingSequence — cues + edge cases", () => {
  it("emits a passive-window cue when a dish starts during another's cook", () => {
    const dishes: SchedulerDish[] = [
      {
        dishId: "roast",
        title: "Roast Chicken",
        positionIndex: 0,
        steps: [step(0, 30, "cook", false)],
      },
      {
        dishId: "rice",
        title: "Rice Pilaf",
        positionIndex: 1,
        steps: [step(0, 5, "prep", false), step(1, 15, "cook", false)],
      },
    ];
    const result = scheduleCookingSequence(dishes);
    assertWellFormed(result, dishes);
    // At least one rice step begins during the roast and carries a cue.
    const cued = result.steps.find((s) => s.dishId === "rice" && s.reason);
    assert.ok(cued, "a rice step gets a while-the-roast-cooks cue");
    assert.ok(cued!.reason!.includes("Roast Chicken"));
  });

  it("returns an empty schedule for no dishes / no steps", () => {
    assert.deepEqual(scheduleCookingSequence([]), {
      steps: [],
      totalEstimatedMinutes: 0,
    });
    assert.deepEqual(
      scheduleCookingSequence([
        { dishId: "d", title: "Empty", positionIndex: 0, steps: [] },
      ]),
      { steps: [], totalEstimatedMinutes: 0 },
    );
  });

  it("is deterministic — identical input yields identical output", () => {
    const dishes: SchedulerDish[] = [
      {
        dishId: "a",
        title: "A",
        positionIndex: 0,
        steps: [step(0, 10, "cook", false), step(1, 5, "assemble", false)],
      },
      {
        dishId: "b",
        title: "B",
        positionIndex: 1,
        steps: [step(0, 8, "prep", false)],
      },
    ];
    assert.deepEqual(
      scheduleCookingSequence(dishes),
      scheduleCookingSequence(dishes),
    );
  });
});
