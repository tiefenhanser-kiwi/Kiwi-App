// WS7-8b BUG-018 B2 — deterministic Cooking Sequencer unit tests.
//
// The two NAMED fixtures below ARE the bug: they are the exact cases the Sonnet
// sequencer got wrong (D-WS7-164 started the shorter roast first; BUG-018 let
// the corn finish 25 min early and go cold). They pin the fix.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scheduleCookingSequence,
  selectDefaultPathSteps,
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

/**
 * anchor = the theoretical earliest serve = the gating (longest) dish's duration.
 * WS9 D-WS9-239 — read off the result's per-dish CRITICAL PATH, not a serial
 * sum: a tagged dish is shorter than Σ its steps, and a Σ-based anchor would
 * flag every tagged fixture as "materially early". For an untagged dish the
 * two are the same number (pinned in the D-WS9-239 block below).
 */
function anchorOf(result: ScheduleResult): number {
  return Math.max(...Object.values(result.dishDurations));
}

// ── shared structural invariants (asserted on every fixture) ────────────────

function assertWellFormed(result: ScheduleResult, dishes: SchedulerDish[]) {
  const rows = analyze(result, dishes);
  // WS9 BUG-270 — the scheduler's input is base + the default (scratch) path;
  // a `bought` alternate is never scheduled, so it is not an input step here.
  const inputCount = dishes.reduce((n, d) => n + selectDefaultPathSteps(d.steps).length, 0);

  // Every (default-path) input step appears exactly once; no bought step ever.
  assert.equal(rows.length, inputCount, "every default-path input step appears exactly once");
  const keys = new Set(rows.map((r) => `${r.dishId}#${r.stepIndex}`));
  assert.equal(keys.size, inputCount, "no duplicate step in output");
  for (const d of dishes)
    for (const s of d.steps)
      if (s.pathKey === "bought")
        assert.ok(!keys.has(`${d.dishId}#${s.stepIndex}`), `bought step ${d.dishId}#${s.stepIndex} must not be scheduled`);

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
  const anchor = anchorOf(result);
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
    const empty: ScheduleResult = {
      steps: [],
      totalEstimatedMinutes: 0,
      activeEstimatedMinutes: 0,
      dishDurations: {},
      ignoredTags: [],
    };
    assert.deepEqual(scheduleCookingSequence([]), empty);
    assert.deepEqual(
      scheduleCookingSequence([
        { dishId: "d", title: "Empty", positionIndex: 0, steps: [] },
      ]),
      empty,
    );
  });

  // ── WS9 D-WS9-235 — active vs total, Hans's own acceptance example ──────
  //
  // "a 20-minute bake beside a 10-minute sauté derives to about 20 total, 10
  // active — not 30." The bake is `cook` + NOT timing-sensitive, so it is
  // unattended and the sauté overlaps it; the sauté is `cook` + timing-
  // sensitive, so it holds the cook.
  //
  // The two numbers are asserted TOGETHER on purpose: a total of 20 alone would
  // also be produced by treating both steps as unattended, and an active of 10
  // alone by treating both as attended-but-parallel. Only the real predicate
  // yields this PAIR.
  it("D-WS9-235: a 20-min bake beside a 10-min sauté is 20 total, 10 active", () => {
    const result = scheduleCookingSequence([
      {
        dishId: "bake",
        title: "Baked Thing",
        positionIndex: 0,
        steps: [
          {
            stepIndex: 0,
            estimatedMinutes: 20,
            phaseType: "cook",
            isTimingSensitive: false, // unattended bake
          },
        ],
      },
      {
        dishId: "saute",
        title: "Sautéed Thing",
        positionIndex: 1,
        steps: [
          {
            stepIndex: 0,
            estimatedMinutes: 10,
            phaseType: "cook",
            isTimingSensitive: true, // watched sauté — holds the cook
          },
        ],
      },
    ]);
    assert.equal(
      result.totalEstimatedMinutes,
      20,
      "the sauté overlaps the unattended bake — 20, not 30",
    );
    assert.equal(
      result.activeEstimatedMinutes,
      10,
      "only the watched sauté costs the cook's hands",
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

// ── WS9 D-WS9-239 Phase 1a — intra-dish `parallelGroup` ─────────────────────
//
// The contract as MEASURED in Phase 0b (see the module header): a token names
// an UNATTENDED window step and rides on the CONTIGUOUS same-token steps after
// it; a rider may start at the window's kickoff; the first untagged step after
// the group waits for max(finish); every invalid tag is IGNORED (the step just
// waits); and the meal is scheduled twice — tags honoured / ignored — with the
// shorter total emitted. Every number below is a literal read against the live
// result, and every invalid-shape fixture is asserted EQUAL to its own untagged
// twin (deepEqual on the emitted schedule), not merely "not shorter".

/** A step with the D-WS9-239 columns. */
function tstep(
  stepIndex: number,
  estimatedMinutes: number,
  phaseType: SchedulerStep["phaseType"],
  opts: {
    ts?: boolean;
    tag?: string | null;
    componentKey?: string | null;
    pathKey?: string | null;
  } = {},
): SchedulerStep {
  return {
    stepIndex,
    estimatedMinutes,
    phaseType,
    isTimingSensitive: opts.ts ?? false,
    parallelGroup: opts.tag ?? null,
    ...(opts.componentKey !== undefined ? { componentKey: opts.componentKey } : {}),
    ...(opts.pathKey !== undefined ? { pathKey: opts.pathKey } : {}),
  };
}

/** The same dishes with every tag stripped — the control every fixture is judged against. */
function untaggedTwin(dishes: SchedulerDish[]): SchedulerDish[] {
  return dishes.map((d) => ({
    ...d,
    steps: d.steps.map((s) => ({ ...s, parallelGroup: null })),
  }));
}

/** The emitted schedule minus `ignoredTags` (which is the one field allowed to differ). */
function emitted(r: ScheduleResult) {
  const { ignoredTags: _ignored, ...rest } = r;
  return rest;
}

describe("scheduleCookingSequence — D-WS9-239 parallelGroup (valid groups)", () => {
  // preheat 20 (window) · prep 12 + prep 5 (riders) · bake 30 (untagged, waits).
  const dishes: SchedulerDish[] = [
    {
      dishId: "bake",
      title: "Baked Ziti",
      positionIndex: 0,
      steps: [
        tstep(0, 20, "preheat", { tag: "oven" }),
        tstep(1, 12, "prep", { tag: "oven" }),
        tstep(2, 5, "prep", { tag: "oven" }),
        tstep(3, 30, "cook"), // the bake — no tag, so it waits for the whole group
      ],
    },
  ];

  it("a valid group shortens the meal by the overlap; active minutes do not move", () => {
    const control = scheduleCookingSequence(untaggedTwin(dishes));
    assert.equal(control.totalEstimatedMinutes, 67, "untagged: 20+12+5+30 serial");
    assert.equal(control.activeEstimatedMinutes, 17);

    const result = scheduleCookingSequence(dishes);
    assertWellFormed(result, dishes);
    // Riders ride the 20-min preheat (12 then 5 serialize on the cook → done at
    // 17); the bake waits for max(finish) = the WINDOW's 20, not the riders' 17.
    assert.equal(result.totalEstimatedMinutes, 50, "20 (window) + 30 (bake)");
    assert.equal(result.activeEstimatedMinutes, 17, "Σ attended is unchanged by overlap");
    assert.deepEqual(result.ignoredTags, []);
    // The dish's own duration is its critical path, and it equals the meal's.
    assert.deepEqual(result.dishDurations, { bake: 50 });

    const rows = analyze(result, dishes);
    const preheat = rows.find((r) => r.stepIndex === 0)!;
    const chop = rows.find((r) => r.stepIndex === 1)!;
    const bakeStep = rows.find((r) => r.stepIndex === 3)!;
    assert.equal(chop.startAbs, preheat.startAbs, "a rider starts at the window's KICKOFF");
    assert.equal(bakeStep.startAbs, 20, "the first untagged step waits for max(finish) of the group");
  });

  it("the untagged twin's dishDurations are the serial sums (the pre-239 number)", () => {
    const control = scheduleCookingSequence(untaggedTwin(dishes));
    assert.deepEqual(control.dishDurations, { bake: 67 });
    assert.deepEqual(control.ignoredTags, []);
  });

  it("an unattended rider is kicked off in the background; an attended rider still holds the cook", () => {
    // preheat 10 (window) · prep 4 (attended rider) · simmer 8 (unattended
    // rider) · toss 2 (untagged). The simmer's kickoff needs a free hand, so it
    // is pushed past the prep it would otherwise land inside.
    const d: SchedulerDish[] = [
      {
        dishId: "rice",
        title: "Rice",
        positionIndex: 0,
        steps: [
          tstep(0, 10, "preheat", { tag: "w" }),
          tstep(1, 4, "prep", { tag: "w" }),
          tstep(2, 8, "cook", { tag: "w" }), // unattended simmer
          tstep(3, 2, "assemble"),
        ],
      },
    ];
    const result = scheduleCookingSequence(d);
    assertWellFormed(result, d);
    const rows = analyze(result, d);
    assert.equal(rows.find((r) => r.stepIndex === 1)!.startAbs, 0, "attended rider at kickoff");
    assert.equal(rows.find((r) => r.stepIndex === 2)!.startAbs, 4, "unattended rider waits for a free hand (after the 4-min prep)");
    assert.equal(rows.find((r) => r.stepIndex === 3)!.startAbs, 12, "toss waits for max(10, 4, 12)");
    assert.equal(result.totalEstimatedMinutes, 14, "vs 24 serial");
    assert.equal(scheduleCookingSequence(untaggedTwin(d)).totalEstimatedMinutes, 24);
    assert.equal(result.activeEstimatedMinutes, 6);
  });

  it("the §5.4 Cajun shape: a second window opens right after the first group closes", () => {
    // Cajun Shrimp Pasta (handcheck_b.md): boil 8 (w0) · prep 7/3/1/3 ride it ·
    // pasta 10 (w5) · sauté 4/4/1 ride it · deglaze 2 + cream 5 (unattended
    // riders) · toss 2 · finish 2 · plate 2. Stored 54 → 34, measured in Phase 0b.
    // WS9 BUG-270: step 3 is the 1-min BOUGHT alternate of step 2's scratch prep
    // and is no longer scheduled, so the fixture reads 53 → 33 (active 28) — the
    // Phase 0b numbers minus exactly that minute.
    const d: SchedulerDish[] = [
      {
        dishId: "cajun",
        title: "Cajun Shrimp Pasta",
        positionIndex: 0,
        steps: [
          tstep(0, 8, "preheat", { tag: "w0" }),
          tstep(1, 7, "prep", { tag: "w0" }),
          tstep(2, 3, "prep", { tag: "w0", pathKey: "scratch" }),
          tstep(3, 1, "prep", { tag: "w0", pathKey: "bought" }),
          tstep(4, 3, "prep", { tag: "w0" }),
          tstep(5, 10, "cook", { tag: "w5" }),
          tstep(6, 4, "cook", { tag: "w5", ts: true }),
          tstep(7, 4, "cook", { tag: "w5", ts: true }),
          tstep(8, 1, "cook", { tag: "w5", ts: true }),
          tstep(9, 2, "cook", { tag: "w5" }),
          tstep(10, 5, "cook", { tag: "w5" }),
          tstep(11, 2, "cook", { ts: true }),
          tstep(12, 2, "assemble"),
          tstep(13, 2, "assemble"),
        ],
      },
    ];
    const result = scheduleCookingSequence(d);
    assertWellFormed(result, d);
    assert.equal(scheduleCookingSequence(untaggedTwin(d)).totalEstimatedMinutes, 53);
    assert.equal(result.totalEstimatedMinutes, 33);
    assert.equal(result.activeEstimatedMinutes, 28);
    assert.deepEqual(result.ignoredTags, []);
    const rows = analyze(result, d);
    assert.equal(rows.find((r) => r.stepIndex === 5)!.startAbs, 13, "the pasta waits for max(finish) of the w0 group (8,7,10,13)");
  });

  it("is deterministic with tags — identical input yields identical output", () => {
    assert.deepEqual(scheduleCookingSequence(dishes), scheduleCookingSequence(dishes));
  });
});

describe("scheduleCookingSequence — D-WS9-239 invalid tags are ignored (never honoured, never thrown)", () => {
  // The base dish every invalid shape is built on: prep 5 · preheat 10 · prep 6
  // · roast 20 (unattended) · rest 5. Untagged = 46 serial.
  const base = (): SchedulerStep[] => [
    tstep(0, 5, "prep"),
    tstep(1, 10, "preheat"),
    tstep(2, 6, "prep"),
    tstep(3, 20, "cook"),
    tstep(4, 5, "rest"),
  ];
  const dish = (steps: SchedulerStep[]): SchedulerDish[] => [
    { dishId: "x", title: "X", positionIndex: 0, steps },
  ];
  const tagAt = (steps: SchedulerStep[], tag: string, ...idx: number[]) =>
    steps.map((s, i) => (idx.includes(i) ? { ...s, parallelGroup: tag } : s));

  function assertIgnoredEqualsUntagged(
    d: SchedulerDish[],
    expectedIgnored: ScheduleResult["ignoredTags"],
  ) {
    const control = scheduleCookingSequence(untaggedTwin(d));
    const result = scheduleCookingSequence(d);
    assertWellFormed(result, d);
    assert.deepEqual(emitted(result), emitted(control), "the schedule is the untagged one");
    assert.deepEqual(result.ignoredTags, expectedIgnored);
  }

  it("a window on an ATTENDED step: the whole token is dropped (attended_window)", () => {
    const d = dish(tagAt(base(), "g", 0, 1)); // first occurrence = the prep
    assertIgnoredEqualsUntagged(d, [
      { dishId: "x", stepIndex: 0, token: "g", reason: "attended_window" },
      { dishId: "x", stepIndex: 1, token: "g", reason: "attended_window" },
    ]);
    assert.equal(scheduleCookingSequence(d).totalEstimatedMinutes, 46);
  });

  it("a rider that PRECEDES its window: the first occurrence is attended, so there is no window", () => {
    // The author meant the roast (#3) as the window and the prep (#2) to ride
    // it — but the token's first occurrence is #2, an attended step.
    const d = dish(tagAt(base(), "g", 2, 3));
    assertIgnoredEqualsUntagged(d, [
      { dishId: "x", stepIndex: 2, token: "g", reason: "attended_window" },
      { dishId: "x", stepIndex: 3, token: "g", reason: "attended_window" },
    ]);
  });

  it("contiguity: a token that re-appears after its group closed is dropped (reopened_group), the contiguous part is honoured", () => {
    // preheat(1)+prep(2) form the group; roast(3) is untagged and closes it;
    // rest(4) carries the token again → dropped, so the rest still waits for
    // the roast. Honouring it would start the rest at minute 5.
    const d = dish(tagAt(base(), "g", 1, 2, 4));
    const result = scheduleCookingSequence(d);
    assertWellFormed(result, d);
    assert.deepEqual(result.ignoredTags, [
      { dishId: "x", stepIndex: 4, token: "g", reason: "reopened_group" },
    ]);
    // prep 5 → preheat [5,15) with prep [5,11) riding → roast waits 15 → [15,35) → rest [35,40).
    assert.equal(result.totalEstimatedMinutes, 40, "40, not 35 (the rest did not ride)");
    const rows = analyze(result, d);
    assert.equal(rows.find((r) => r.stepIndex === 4)!.startAbs, 35);
    assert.equal(rows.find((r) => r.stepIndex === 2)!.startAbs, 5, "the contiguous rider still rides");
  });

  it("more than one token on a step (whitespace / separator) is malformed and ignored", () => {
    const d = dish(tagAt(base(), "oven boil", 1, 2));
    assertIgnoredEqualsUntagged(d, [
      { dishId: "x", stepIndex: 1, token: "oven boil", reason: "malformed_token" },
      { dishId: "x", stepIndex: 2, token: "oven boil", reason: "malformed_token" },
    ]);
  });

  it("an empty / whitespace-only tag is simply untagged (no ignoredTags entry)", () => {
    const d = dish(tagAt(base(), "   ", 1, 2));
    assertIgnoredEqualsUntagged(d, []);
  });

  it("a window whose every rider was rejected is a lone_token (nothing rides it)", () => {
    const d = dish(tagAt(base(), "g", 3)); // the roast alone
    assertIgnoredEqualsUntagged(d, [
      { dishId: "x", stepIndex: 3, token: "g", reason: "lone_token" },
    ]);
  });

  describe("same-component rest/hold immediately after a cook window (Phase 0b narrowing)", () => {
    const sear = (restComponent: string | null, cookComponent: string | null): SchedulerDish[] => [
      {
        dishId: "steak",
        title: "Steak",
        positionIndex: 0,
        steps: [
          tstep(0, 5, "prep"),
          tstep(1, 20, "cook", { tag: "g", componentKey: cookComponent }), // unattended roast = window
          tstep(2, 5, "rest", { tag: "g", componentKey: restComponent }), // rides it?
        ],
      },
    ];

    it("REJECTS a rest riding its own cook (both base / same componentKey): rest_rides_cook + the window goes lone", () => {
      for (const [rest, cook] of [
        [null, null],
        ["meat", "meat"],
      ] as const) {
        const d = sear(rest, cook);
        const control = scheduleCookingSequence(untaggedTwin(d));
        const result = scheduleCookingSequence(d);
        assert.deepEqual(emitted(result), emitted(control));
        assert.equal(result.totalEstimatedMinutes, 30, `${rest}/${cook}: 5+20+5 serial`);
        assert.deepEqual(result.ignoredTags, [
          { dishId: "steak", stepIndex: 2, token: "g", reason: "rest_rides_cook" },
          { dishId: "steak", stepIndex: 1, token: "g", reason: "lone_token" },
        ]);
      }
    });

    it("does NOT reject a rest that belongs to a DIFFERENT component (the false positive the narrowing fixed)", () => {
      const d = sear("sauce", "meat");
      const result = scheduleCookingSequence(d);
      assertWellFormed(result, d);
      assert.deepEqual(result.ignoredTags, []);
      // The sauce's rest rides the meat's roast: [5,10) inside [5,25) → 25, not 30.
      assert.equal(result.totalEstimatedMinutes, 25);
      assert.equal(scheduleCookingSequence(untaggedTwin(d)).totalEstimatedMinutes, 30);
    });

    it("the narrowing is adjacency-specific: a rest two steps after the cook window is not this rule", () => {
      const d: SchedulerDish[] = [
        {
          dishId: "s",
          title: "S",
          positionIndex: 0,
          steps: [
            tstep(0, 20, "cook", { tag: "g" }),
            tstep(1, 4, "prep", { tag: "g" }),
            tstep(2, 5, "rest", { tag: "g" }),
          ],
        },
      ];
      const result = scheduleCookingSequence(d);
      assert.deepEqual(result.ignoredTags, []);
      assert.equal(result.totalEstimatedMinutes, 20, "prep [0,4) and rest [4,9) both ride the 20-min roast");
    });
  });

  describe("path rule: a rider's pathKey must agree with the window's unless one is base (null)", () => {
    // WS9 BUG-270 — a `bought` step is dropped at the scheduler's input, before
    // classification, so scratch-vs-bought never reaches this rule any more.
    // The rule stays as the defensive guard it always was; the fixtures below
    // pin (i) what the drop does to a group that leaned on a bought step and
    // (ii) that rule (d) still fires for a pathKey outside the enum.
    const pasta = (windowPath: string | null, riderPath: string | null): SchedulerDish[] => [
      {
        dishId: "p",
        title: "Pasta",
        positionIndex: 0,
        steps: [
          tstep(0, 5, "prep"),
          tstep(1, 12, "cook", { tag: "g", pathKey: windowPath }), // unattended boil = window
          tstep(2, 6, "prep", { tag: "g", pathKey: riderPath }),
        ],
      },
    ];

    it("BUG-270: a bought WINDOW is not scheduled, so its scratch rider has no window (attended_window) — 5+6, the bought 12 gone", () => {
      const d = pasta("bought", "scratch");
      const result = scheduleCookingSequence(d);
      assertWellFormed(result, d);
      assert.equal(result.totalEstimatedMinutes, 11);
      assert.deepEqual(result.ignoredTags, [{ dishId: "p", stepIndex: 2, token: "g", reason: "attended_window" }]);
    });

    it("BUG-270: a bought RIDER is not scheduled, so its scratch window goes lone — 5+12, the bought 6 gone", () => {
      const d = pasta("scratch", "bought");
      const result = scheduleCookingSequence(d);
      assertWellFormed(result, d);
      assert.equal(result.totalEstimatedMinutes, 17);
      assert.deepEqual(result.ignoredTags, [{ dishId: "p", stepIndex: 1, token: "g", reason: "lone_token" }]);
    });

    it("BUG-270: a base rider whose only window was bought is simply untagged (attended_window), never orphaned onto nothing", () => {
      const d = pasta("bought", null);
      const result = scheduleCookingSequence(d);
      assertWellFormed(result, d);
      assert.equal(result.totalEstimatedMinutes, 11, "5 + 6: the base prep waits like any untagged step");
      assert.deepEqual(result.ignoredTags, [{ dishId: "p", stepIndex: 2, token: "g", reason: "attended_window" }]);
    });

    it("rule (d) still guards a pathKey outside the enum: path_mismatch + lone window = the untagged schedule", () => {
      const d = pasta("scratch", "frozen");
      const control = scheduleCookingSequence(untaggedTwin(d));
      const result = scheduleCookingSequence(d);
      assert.deepEqual(emitted(result), emitted(control));
      assert.equal(result.totalEstimatedMinutes, 23, "5+12+6 serial — the unknown value is kept and reads long, never short");
      assert.deepEqual(result.ignoredTags, [
        { dishId: "p", stepIndex: 2, token: "g", reason: "path_mismatch" },
        { dishId: "p", stepIndex: 1, token: "g", reason: "lone_token" },
      ]);
    });

    it("base (null) rides with anything, on either side", () => {
      for (const [w, r] of [
        [null, "scratch"],
        ["scratch", null],
        [null, null],
        ["scratch", "scratch"],
      ] as const) {
        const d = pasta(w, r);
        const result = scheduleCookingSequence(d);
        assertWellFormed(result, d);
        assert.deepEqual(result.ignoredTags, [], `${w}/${r}`);
        assert.equal(result.totalEstimatedMinutes, 17, `${w}/${r}: the prep rides the boil → 5+12`);
      }
    });

    it("a rejected rider is a hole that closes the group: later same-token riders are reopened_group, not honoured", () => {
      // The hole is a same-component rest riding its own cook (rest_rides_cook);
      // BUG-270 made a scratch/bought mismatch unreachable as the hole-maker.
      const d: SchedulerDish[] = [
        {
          dishId: "p",
          title: "Pasta",
          positionIndex: 0,
          steps: [
            tstep(0, 12, "cook", { tag: "g", componentKey: "sauce" }),
            tstep(1, 6, "rest", { tag: "g", componentKey: "sauce" }), // rest rides its own cook → hole
            tstep(2, 3, "prep", { tag: "g" }), // would ride, but the group is closed
          ],
        },
      ];
      const result = scheduleCookingSequence(d);
      assert.deepEqual(result.ignoredTags, [
        { dishId: "p", stepIndex: 1, token: "g", reason: "rest_rides_cook" },
        { dishId: "p", stepIndex: 2, token: "g", reason: "reopened_group" },
        { dishId: "p", stepIndex: 0, token: "g", reason: "lone_token" },
      ]);
      assert.equal(result.totalEstimatedMinutes, 21, "12+6+3 serial");
    });
  });

  it("a token never spans two dishes: the same name in two dishes is two independent groups", () => {
    // Dish A has a valid group "g". Dish B's only "g" sits on an attended step:
    // read across dishes it would be a rider of A's window; per dish it has no
    // window at all → attended_window, and B schedules exactly as untagged.
    const d: SchedulerDish[] = [
      {
        dishId: "a",
        title: "A",
        positionIndex: 0,
        steps: [tstep(0, 10, "preheat", { tag: "g" }), tstep(1, 5, "prep", { tag: "g" })],
      },
      {
        dishId: "b",
        title: "B",
        positionIndex: 1,
        steps: [tstep(0, 4, "prep", { tag: "g" }), tstep(1, 3, "assemble")],
      },
    ];
    const result = scheduleCookingSequence(d);
    assertWellFormed(result, d);
    assert.deepEqual(result.ignoredTags, [
      { dishId: "b", stepIndex: 0, token: "g", reason: "attended_window" },
    ]);
    assert.deepEqual(result.dishDurations, { a: 10, b: 7 }, "A's group honoured (10 not 15); B serial");
    // B's own timeline is its untagged one: the prep does not start at A's kickoff.
    const rows = analyze(result, d);
    const bPrep = rows.find((r) => r.dishId === "b" && r.stepIndex === 0)!;
    const bToss = rows.find((r) => r.dishId === "b" && r.stepIndex === 1)!;
    assert.equal(bToss.startAbs, bPrep.finishAbs, "B's toss waits for B's prep");
  });
});

describe("scheduleCookingSequence — D-WS9-239 the anomaly guard (rule 6)", () => {
  // A VALID tag that makes the MEAL longer. Found by search, then checked by
  // hand. d0 = assemble 5 · roast 12 (unattended) · preheat 5 → 22 serial.
  // d1 = rest 7 (window "g") · watched sear 3 (rider) → 10 serial, 7 alone
  // with the tag. Finish-aligned, d1's shorter tagged duration moves its ideal
  // start from 12 to 15; the sear then runs [15,18) and holds the cook, so
  // d0's preheat (ideal 17) is pushed to 18 and the meal ends at 23. Untagged
  // the sear runs [19,22) after the preheat kicked off at 17: 22.
  const d0: SchedulerDish = {
    dishId: "d0",
    title: "D0",
    positionIndex: 0,
    steps: [tstep(0, 5, "assemble"), tstep(1, 12, "cook"), tstep(2, 5, "preheat")],
  };
  const d1: SchedulerDish = {
    dishId: "d1",
    title: "D1",
    positionIndex: 1,
    steps: [tstep(0, 7, "rest", { tag: "g" }), tstep(1, 3, "cook", { ts: true, tag: "g" })],
  };

  it("the tag is valid and honoured when the dish is alone (7, not 10)", () => {
    const alone = scheduleCookingSequence([d1]);
    assert.equal(alone.totalEstimatedMinutes, 7);
    assert.deepEqual(alone.ignoredTags, []);
    assert.deepEqual(alone.dishDurations, { d1: 7 });
  });

  it("in the meal, honouring it would give 23: the guard emits the untagged 22 and reports anomaly_guard on the window", () => {
    const control = scheduleCookingSequence(untaggedTwin([d0, d1]));
    assert.equal(control.totalEstimatedMinutes, 22);
    const result = scheduleCookingSequence([d0, d1]);
    assertWellFormed(result, [d0, d1]);
    assert.equal(result.totalEstimatedMinutes, 22, "the shorter of the two schedules");
    assert.deepEqual(emitted(result), emitted(control), "the emitted schedule IS the untagged one (serial dish durations included)");
    assert.deepEqual(result.ignoredTags, [
      { dishId: "d1", stepIndex: 0, token: "g", reason: "anomaly_guard" },
    ]);
    assert.equal(result.activeEstimatedMinutes, control.activeEstimatedMinutes, "active is the same either way");
  });
});

// ── WS9 BUG-270 — a dual-path dish is BASE + the default path, never both ────

describe("scheduleCookingSequence — BUG-270 base + default (scratch) path only", () => {
  /** Live rows of the km30 "Buffalo Chicken Quesadillas" dish, the shape that named the bug. */
  const quesadilla: SchedulerDish = {
    dishId: "q",
    title: "Buffalo Chicken Quesadillas",
    positionIndex: 0,
    steps: [
      tstep(0, 3, "prep", { componentKey: "chicken", pathKey: "scratch" }),
      tstep(1, 14, "cook", { ts: true, componentKey: "chicken", pathKey: "scratch" }),
      tstep(2, 4, "cook", { componentKey: "buffalo-sauce", pathKey: "scratch" }),
      tstep(3, 5, "prep", { componentKey: "chicken", pathKey: "bought" }),
      tstep(4, 1, "prep", { componentKey: "buffalo-sauce", pathKey: "bought" }),
      tstep(5, 2, "prep"),
      tstep(6, 4, "prep", { componentKey: "cheese", pathKey: "scratch" }),
      tstep(7, 2, "prep", { componentKey: "cheese", pathKey: "bought" }),
      tstep(8, 4, "assemble"),
      tstep(9, 12, "cook", { ts: true }),
      tstep(10, 2, "assemble"),
    ],
  };
  const celery: SchedulerDish = {
    dishId: "c",
    title: "Celery Sticks with Ranch",
    positionIndex: 1,
    steps: [tstep(0, 4, "prep"), tstep(1, 2, "assemble")],
  };
  /** The same dishes with the bought steps already removed — what the fix must equal. */
  const prefiltered = (ds: SchedulerDish[]): SchedulerDish[] =>
    ds.map((d) => ({ ...d, steps: d.steps.filter((s) => s.pathKey !== "bought") }));
  /** The same dishes with every path tag stripped — what the OLD scheduler effectively walked. */
  const bothPaths = (ds: SchedulerDish[]): SchedulerDish[] =>
    ds.map((d) => ({ ...d, steps: d.steps.map((s) => ({ ...s, componentKey: null, pathKey: null })) }));

  it("the quesadilla: base 20 + scratch 25 + bought 8 schedules as 45, the meal 51 — not the 53 / 59 both paths gave", () => {
    const d = [quesadilla, celery];
    const result = scheduleCookingSequence(d);
    assertWellFormed(result, d);
    assert.equal(result.dishDurations.q, 45, "base 20 + scratch 25; the bought 8 is not cooked");
    assert.equal(result.dishDurations.c, 6);
    assert.equal(result.totalEstimatedMinutes, 51, "45 + the all-attended 6-minute side");
    assert.equal(result.activeEstimatedMinutes, 47, "the unattended sauce simmer (4) is the only hands-free minute");
    assert.deepEqual(result.ignoredTags, []);
    // Exactly what pre-filtering by hand gives — the filter is the whole change.
    assert.deepEqual(result, scheduleCookingSequence(prefiltered(d)));
    // And what the unfixed walk stored: every path serialised.
    const old = scheduleCookingSequence(bothPaths(d));
    assert.equal(old.dishDurations.q, 53);
    assert.equal(old.totalEstimatedMinutes, 59);
    assert.equal(old.activeEstimatedMinutes, 55);
  });

  it("a single-path dish is byte-unchanged: base-only, and base + scratch with no bought step", () => {
    const baseOnly: SchedulerDish[] = [
      { dishId: "a", title: "A", positionIndex: 0, steps: [tstep(0, 5, "prep"), tstep(1, 20, "cook"), tstep(2, 3, "assemble")] },
      { dishId: "b", title: "B", positionIndex: 1, steps: [tstep(0, 8, "prep"), tstep(1, 6, "cook", { ts: true })] },
    ];
    assert.deepEqual(scheduleCookingSequence(baseOnly), scheduleCookingSequence(bothPaths(baseOnly)));
    const scratchTagged: SchedulerDish[] = [
      {
        dishId: "s",
        title: "S",
        positionIndex: 0,
        steps: [
          tstep(0, 10, "preheat", { tag: "w" }),
          tstep(1, 6, "prep", { tag: "w", componentKey: "sauce", pathKey: "scratch" }),
          tstep(2, 25, "cook"),
        ],
      },
    ];
    const result = scheduleCookingSequence(scratchTagged);
    assertWellFormed(result, scratchTagged);
    assert.deepEqual(result, scheduleCookingSequence(bothPaths(scratchTagged)), "a scratch tag alone changes nothing");
    assert.equal(result.totalEstimatedMinutes, 35);
  });

  it("the default is the default, not the minimum: a SHORTER bought path still reads the scratch time", () => {
    const d: SchedulerDish[] = [
      {
        dishId: "slaw",
        title: "Coleslaw",
        positionIndex: 0,
        steps: [
          tstep(0, 10, "prep", { componentKey: "slaw", pathKey: "scratch" }), // shred the cabbage
          tstep(1, 1, "prep", { componentKey: "slaw", pathKey: "bought" }), // open the bag
          tstep(2, 3, "assemble"),
        ],
      },
    ];
    const result = scheduleCookingSequence(d);
    assertWellFormed(result, d);
    assert.equal(result.totalEstimatedMinutes, 13, "10 + 3: the 1-minute bag is not the number");
    assert.equal(result.activeEstimatedMinutes, 13);
  });

  it("an unrecognised pathKey is KEPT (reads long, never short); only the literal bought is dropped", () => {
    const d: SchedulerDish[] = [
      {
        dishId: "x",
        title: "X",
        positionIndex: 0,
        steps: [tstep(0, 7, "prep", { componentKey: "k", pathKey: "frozen" }), tstep(1, 2, "prep", { componentKey: "k", pathKey: "Bought" }), tstep(2, 5, "cook")],
      },
    ];
    const result = scheduleCookingSequence(d);
    assert.equal(result.steps.length, 3, "neither frozen nor Bought is the excluded value");
    assert.equal(result.totalEstimatedMinutes, 14);
  });

  describe("token orphans: excluding bought steps must not leave a tag the derivation would not catch", () => {
    it("a base window whose EVERY rider was bought goes lone_token — reported, never honoured, the number is the serial one", () => {
      const d: SchedulerDish[] = [
        {
          dishId: "o",
          title: "O",
          positionIndex: 0,
          steps: [
            tstep(0, 10, "preheat", { tag: "w" }), // base window
            tstep(1, 2, "prep", { tag: "w", componentKey: "sauce", pathKey: "bought" }), // the only rider — gone
            tstep(2, 20, "cook"),
          ],
        },
      ];
      const result = scheduleCookingSequence(d);
      assertWellFormed(result, d);
      assert.deepEqual(result.ignoredTags, [{ dishId: "o", stepIndex: 0, token: "w", reason: "lone_token" }]);
      assert.equal(result.totalEstimatedMinutes, 30, "10 + 20 serial: nothing rides the preheat any more");
    });

    it("a bought window with base riders: the first surviving rider becomes the window if unattended, so later riders still overlap it", () => {
      const d: SchedulerDish[] = [
        {
          dishId: "r",
          title: "R",
          positionIndex: 0,
          steps: [
            tstep(0, 12, "cook", { tag: "g", componentKey: "sauce", pathKey: "bought" }), // bought window — gone
            tstep(1, 8, "cook", { tag: "g" }), // base, unattended → the window now
            tstep(2, 5, "prep", { tag: "g" }), // base rider → rides #1's kickoff
            tstep(3, 2, "assemble"),
          ],
        },
      ];
      const result = scheduleCookingSequence(d);
      assertWellFormed(result, d);
      assert.deepEqual(result.ignoredTags, []);
      assert.equal(result.totalEstimatedMinutes, 10, "prep rides the 8-min cook (kicked off together), then 2");
      const rows = analyze(result, d);
      assert.equal(rows.find((r) => r.stepIndex === 2)!.startAbs, rows.find((r) => r.stepIndex === 1)!.startAbs);
    });

    it("a bought window with an ATTENDED base rider: the rider has no window (attended_window) and simply waits", () => {
      const d: SchedulerDish[] = [
        {
          dishId: "r",
          title: "R",
          positionIndex: 0,
          steps: [
            tstep(0, 12, "cook", { tag: "g", componentKey: "sauce", pathKey: "bought" }),
            tstep(1, 5, "prep", { tag: "g" }),
            tstep(2, 2, "assemble"),
          ],
        },
      ];
      const result = scheduleCookingSequence(d);
      assertWellFormed(result, d);
      assert.deepEqual(result.ignoredTags, [{ dishId: "r", stepIndex: 1, token: "g", reason: "attended_window" }]);
      assert.equal(result.totalEstimatedMinutes, 7);
    });
  });

  it("a dish left with NO steps by the drop is treated as empty: absent from dishDurations, the meal still schedules", () => {
    const d: SchedulerDish[] = [
      { dishId: "gone", title: "All bought", positionIndex: 0, steps: [tstep(0, 3, "prep", { componentKey: "k", pathKey: "bought" })] },
      { dishId: "kept", title: "Kept", positionIndex: 1, steps: [tstep(0, 9, "prep")] },
    ];
    const result = scheduleCookingSequence(d);
    assert.deepEqual(Object.keys(result.dishDurations), ["kept"]);
    assert.equal(result.totalEstimatedMinutes, 9);
    assert.equal(scheduleCookingSequence([d[0]]).totalEstimatedMinutes, 0, "alone it is the empty schedule");
  });

  it("selectDefaultPathSteps: drops the literal bought only, keeps order and stepIndex", () => {
    const steps = [
      tstep(0, 1, "prep", { pathKey: "scratch" }),
      tstep(1, 1, "prep", { pathKey: "bought" }),
      tstep(2, 1, "prep"),
      tstep(3, 1, "prep", { pathKey: null }),
      tstep(4, 1, "prep", { pathKey: "bought" }),
    ];
    assert.deepEqual(selectDefaultPathSteps(steps).map((s) => s.stepIndex), [0, 2, 3]);
  });
});
