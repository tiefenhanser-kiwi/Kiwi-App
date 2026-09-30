// WS9 BUG-337 / D-WS9-297 — the Prep & Cook pass, B1 scheduler rulings.
//
// Three rulings, three groups. Every fixture here is a REPRO reduced from the
// 13-plan census corpus (scripts/prep-cook-census), and the numbers in the
// assertions are the ones the census measured, not invented ones:
//
//   ruling 1  the latest bound        — Carne Asada's steak rested 20 min late
//   ruling 2  the cue                 — 115 of 193 cues were false or ungrammatical
//   ruling 3  cold dishes forward     — a 30-min marinade sat 27 min idle
//
// A separate file from cookingScheduler.test.ts on purpose: that file's named
// fixtures ARE BUG-018 and D-WS7-164, and mixing a third bug's repros into it
// would blur which fixture pins which defect.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scheduleCookingSequence,
  isServedCold,
  LAG_AFTER_HEAT_REST,
  LAG_AFTER_HEAT_OTHER,
  type SchedulerDish,
  type SchedulerStep,
  type ScheduleResult,
} from "../cookingScheduler";

// ── helpers ───────────────────────────────────────────────────────────────

function step(
  stepIndex: number,
  estimatedMinutes: number,
  phaseType: SchedulerStep["phaseType"],
  opts: { ts?: boolean; text?: string } = {},
): SchedulerStep {
  return {
    stepIndex,
    estimatedMinutes,
    phaseType,
    isTimingSensitive: opts.ts ?? false,
    ...(opts.text !== undefined ? { text: opts.text } : {}),
  };
}

function dish(
  dishId: string,
  title: string,
  positionIndex: number,
  steps: SchedulerStep[],
): SchedulerDish {
  return { dishId, title, positionIndex, steps };
}

/** Absolute (cook-start-frame) start of one step, from its serve-anchored offset. */
function startOf(r: ScheduleResult, dishId: string, stepIndex: number): number {
  const e = r.steps.find((s) => s.dishId === dishId && s.originalStepIndex === stepIndex);
  assert.ok(e, `${dishId}#${stepIndex} missing from the schedule`);
  return e!.startOffsetMinutes + r.totalEstimatedMinutes;
}
function finishOf(
  r: ScheduleResult,
  dishes: SchedulerDish[],
  dishId: string,
  stepIndex: number,
): number {
  const src = dishes.find((d) => d.dishId === dishId)!.steps.find((s) => s.stepIndex === stepIndex)!;
  return startOf(r, dishId, stepIndex) + src.estimatedMinutes;
}
const cueOf = (r: ScheduleResult, dishId: string, stepIndex: number) =>
  r.steps.find((s) => s.dishId === dishId && s.originalStepIndex === stepIndex)?.reason;

// ── ruling 1 — the latest bound ────────────────────────────────────────────

describe("BUG-337 ruling 1 — a step may not drift from its own heat predecessor", () => {
  // THE CENSUS REPRO, reduced. Carne Asada is the gating dish; its steak grills
  // and then rests. Three SHORT dishes are finish-aligned, which lands their
  // ideal starts fractionally BELOW the rest's — so they won the priority sort,
  // each took the hands, and the rest waited 20 minutes for a cooling steak.
  const carneAsada = (): SchedulerDish[] => [
    dish("steak", "Carne Asada", 0, [
      step(0, 5, "prep"),
      step(1, 30, "rest", { text: "Place the skirt steak in a bag, pour the marinade over it, and refrigerate 30 minutes." }),
      step(2, 5, "preheat"),
      step(3, 8, "cook", { ts: true, text: "Grill the skirt steak 3-4 minutes per side over high heat." }),
      step(4, 5, "rest", { text: "Transfer the steak to a cutting board and rest for 5 minutes." }),
      step(5, 3, "assemble"),
    ]),
    // Three short dishes whose finish-aligned starts crowd the rest.
    dish("pico", "Pico de Gallo Relish", 1, [step(0, 5, "prep"), step(1, 3, "prep"), step(2, 2, "assemble")]),
    dish("guac", "Guacamole Mash", 2, [step(0, 4, "prep"), step(1, 3, "assemble")]),
    dish("tort", "Warm Corn Tortillas", 3, [step(0, 8, "cook", { ts: true })]),
  ];

  it("the rest begins within LAG_AFTER_HEAT_REST of its grill finishing", () => {
    const dishes = carneAsada();
    const r = scheduleCookingSequence(dishes);
    const grillEnd = finishOf(r, dishes, "steak", 3);
    const restStart = startOf(r, "steak", 4);
    assert.ok(
      restStart - grillEnd <= LAG_AFTER_HEAT_REST,
      `rest started ${restStart - grillEnd} min after the grill finished (bound ${LAG_AFTER_HEAT_REST})`,
    );
  });

  it("WITHOUT the bound the same fixture reproduces the defect — the bound is what fixes it", () => {
    // 🔴 `coldDishesForward: false` IN BOTH ARMS, and that is not incidental.
    // With ruling 3 on, the pico and the guacamole are already pulled to the
    // front of the meal, so they no longer crowd the rest and the drift does not
    // reproduce at all — the two rulings genuinely overlap on this fixture. To
    // show that the BOUND is what closes the gap, ruling 3 has to be held still.
    // Ruling 1 still earns its place: a crowding dish that is not served cold
    // (the tortilla sear, below, and 12 rest steps across the census) is outside
    // ruling 3's reach entirely.
    const dishes = carneAsada();
    const unbounded = scheduleCookingSequence(dishes, { enforceMaxLag: false, coldDishesForward: false });
    const bounded = scheduleCookingSequence(dishes, { coldDishesForward: false });
    const gapUnbounded = startOf(unbounded, "steak", 4) - finishOf(unbounded, dishes, "steak", 3);
    const gapBounded = startOf(bounded, "steak", 4) - finishOf(bounded, dishes, "steak", 3);
    assert.ok(gapUnbounded > LAG_AFTER_HEAT_REST, `expected the unbounded schedule to drift, got ${gapUnbounded} min`);
    assert.ok(gapBounded <= LAG_AFTER_HEAT_REST, `the bound did not close the gap: ${gapBounded} min`);
  });

  it("the bound reaches a crowding dish that ruling 3 cannot — a hot sear, not a cold salsa", () => {
    // Warm Corn Tortillas is explicitly NOT served cold, so only the bound can
    // stop its 8-minute sear from stealing the steak's rest window.
    const dishes = [
      dish("steak", "Carne Asada", 0, [
        step(0, 5, "prep"),
        step(1, 5, "preheat"),
        step(2, 8, "cook", { ts: true, text: "Grill the skirt steak." }),
        step(3, 5, "rest", { text: "Transfer the steak to a cutting board and rest for 5 minutes." }),
        step(4, 3, "assemble"),
      ]),
      // 4 + 8 = 12, so finish-alignment lands both of its ideal starts just
      // BELOW the rest's — which is the whole mechanism. A shorter tortilla dish
      // ties with the rest instead, and the dishIdx tie-break lets the rest win.
      dish("tort", "Warm Corn Tortillas", 1, [
        step(0, 4, "prep", { text: "Count out and stack 12 corn tortillas." }),
        step(1, 8, "cook", { ts: true, text: "Warm the tortillas one at a time." }),
      ]),
    ];
    const unbounded = scheduleCookingSequence(dishes, { enforceMaxLag: false });
    const bounded = scheduleCookingSequence(dishes);
    assert.ok(
      startOf(unbounded, "steak", 3) - finishOf(unbounded, dishes, "steak", 2) > LAG_AFTER_HEAT_REST,
      "expected the tortilla sear to steal the rest window without the bound",
    );
    assert.ok(startOf(bounded, "steak", 3) - finishOf(bounded, dishes, "steak", 2) <= LAG_AFTER_HEAT_REST);
  });

  it("a non-rest step after heat gets the looser LAG_AFTER_HEAT_OTHER bound", () => {
    // The Teriyaki repro: sear, then glaze. The glaze is an `assemble`, so it
    // rides the 5-minute bound rather than the 2-minute one.
    const dishes = [
      dish("salmon", "Teriyaki Salmon", 0, [
        step(0, 4, "prep"),
        step(1, 6, "cook", { ts: true, text: "Sear the salmon skin-side up in the hot skillet." }),
        step(2, 1, "assemble", { text: "Brush the salmon with the glaze and cook 30 seconds more." }),
        step(3, 2, "assemble"),
      ]),
      dish("rice", "Steamed Jasmine Rice", 1, [step(0, 2, "prep"), step(1, 15, "cook"), step(2, 5, "rest")]),
      dish("cuke", "Sesame Cucumber Salad", 2, [step(0, 6, "prep"), step(1, 2, "assemble")]),
    ];
    const r = scheduleCookingSequence(dishes);
    const gap = startOf(r, "salmon", 2) - finishOf(r, dishes, "salmon", 1);
    assert.ok(gap <= LAG_AFTER_HEAT_OTHER, `glaze waited ${gap} min after the sear (bound ${LAG_AFTER_HEAT_OTHER})`);
  });

  it("the bound never reorders a dish's own steps", () => {
    const dishes = carneAsada();
    const r = scheduleCookingSequence(dishes);
    for (const d of dishes) {
      const mine = r.steps
        .filter((s) => s.dishId === d.dishId)
        .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
        .map((s) => s.originalStepIndex);
      assert.deepEqual(mine, [...mine].sort((a, b) => a - b), `${d.dishId} emitted out of authored order`);
    }
  });

  it("a repaired step does not block work that could run in a hole before it", () => {
    // THE MISSISSIPPI POT ROAST REPRO. The shred follows an 8-hour braise, so the
    // bound pulls its key to the braise's and it is placed FIRST in the walk —
    // with an actual start of 502. Under the old scalar `cookBusyUntil` that set
    // the mark to 506, and the mashed potatoes (ideal start 458, happily inside
    // the braise for the previous eight hours) were told the hands were busy
    // until 506. The meal grew 520 -> 589. Nothing was busy at 458; a high-water
    // mark simply cannot represent a hole, so the hands keep a busy SET.
    const dishes = [
      dish("roast", "Slow Cooker Pot Roast", 0, [
        step(0, 3, "prep"),
        step(1, 10, "cook", { ts: true, text: "Sear the roast in a heavy skillet." }),
        step(2, 480, "cook", { text: "Cover and cook on low for 8 hours." }),
        step(3, 4, "assemble", { text: "Shred the roast with two forks." }),
      ]),
      dish("mash", "Buttery Mashed Potatoes", 1, [
        step(0, 8, "prep", { text: "Peel and cut the potatoes." }),
        step(1, 20, "cook", { text: "Boil the potatoes." }),
        step(2, 5, "assemble", { text: "Mash the potatoes." }),
      ]),
    ];
    const r = scheduleCookingSequence(dishes);
    // The potatoes' prep must land INSIDE the braise, not after the shred.
    const braiseEnd = finishOf(r, dishes, "roast", 2);
    assert.ok(
      startOf(r, "mash", 0) < braiseEnd,
      `the potato prep was pushed to ${startOf(r, "mash", 0)}, after the braise ended at ${braiseEnd}`,
    );
    // And the bound still holds on the step that caused the repair.
    assert.ok(startOf(r, "roast", 3) - braiseEnd <= LAG_AFTER_HEAT_OTHER);
  });

  it("a step with no heat predecessor is unconstrained (the bound is not a global tightening)", () => {
    // Every step here follows a prep/assemble, so the bound must never fire and
    // the schedule must be byte-identical with it on and off.
    const dishes = [
      dish("a", "Chopped Salad Bowl", 0, [step(0, 4, "prep"), step(1, 3, "prep"), step(2, 2, "assemble")]),
      dish("b", "Bread Basket", 1, [step(0, 2, "prep"), step(1, 1, "assemble")]),
    ];
    assert.deepEqual(
      scheduleCookingSequence(dishes),
      scheduleCookingSequence(dishes, { enforceMaxLag: false }),
    );
  });
});

// ── ruling 2 — the cue ─────────────────────────────────────────────────────

describe("BUG-337 ruling 2 — the connective says what the dish is actually doing", () => {
  it('"stays warm" is never said of a dish being refrigerated', () => {
    // The census found exactly one, and it was this: GERUND.hold was the literal
    // string "stays warm", asserted of a guacamole under plastic wrap.
    const dishes = [
      dish("guac", "Guacamole", 0, [
        step(0, 3, "prep"),
        step(1, 2, "assemble"),
        step(2, 12, "hold", { text: "Press plastic wrap directly onto the surface of the guacamole and refrigerate until ready to serve." }),
      ]),
      dish("steak", "Carne Asada", 1, [step(0, 4, "prep"), step(1, 6, "cook", { ts: true, text: "Grill the steak." }), step(2, 3, "assemble", { text: "Slice the rested steak thinly." })]),
    ];
    const cues = scheduleCookingSequence(dishes).steps.map((s) => s.reason).filter(Boolean) as string[];
    for (const c of cues) {
      assert.ok(!/stays warm|staying warm/.test(c), `cue asserts warmth about a chilled dish: "${c}"`);
    }
    assert.ok(
      cues.some((c) => c.includes("Guacamole chilling")),
      `expected a chilling cue, got ${JSON.stringify(cues)}`,
    );
  });

  it('a `cook` row whose prose is not heat gets NO cue rather than "cooking"', () => {
    // "While the Steamed Jasmine Rice cooks" — where the rice had been rinsed
    // and nothing more. 14 of 193.
    const dishes = [
      dish("rice", "Steamed Jasmine Rice", 0, [
        step(0, 2, "prep"),
        step(1, 18, "cook", { text: "Combine the rinsed rice and 2 cups water in a saucepan." }),
      ]),
      dish("stir", "Chicken Stir-Fry", 1, [step(0, 5, "prep"), step(1, 4, "cook", { ts: true, text: "Stir-fry the chicken." })]),
    ];
    const cues = scheduleCookingSequence(dishes).steps.map((s) => s.reason).filter(Boolean) as string[];
    for (const c of cues) {
      assert.ok(!/Rice cooking/.test(c), `cue claims the rice is cooking: "${c}"`);
    }
  });

  it("a marinate is described as marinating, not resting", () => {
    const dishes = [
      dish("steak", "Skirt Steak", 0, [
        step(0, 3, "prep"),
        step(1, 30, "rest", { text: "Pour the marinade over the steak, seal, and refrigerate for 30 minutes." }),
        step(2, 6, "cook", { ts: true, text: "Grill the steak." }),
      ]),
      dish("salsa", "Tomatillo Relish", 1, [step(0, 5, "prep"), step(1, 2, "assemble")]),
    ];
    const cues = scheduleCookingSequence(dishes).steps.map((s) => s.reason).filter(Boolean) as string[];
    assert.ok(cues.length > 0, "expected at least one cue");
    for (const c of cues) assert.ok(!/Steak resting/.test(c), `a marinade described as a rest: "${c}"`);
  });

  it("no cue points forward at a window the cook has not begun", () => {
    // Two steps at the SAME offset each satisfied `actualStart <= actualStart`
    // about the other, so each was told to use the other's window. 18 of 193.
    const dishes = [
      dish("a", "Roasted Broccoli", 0, [step(0, 2, "prep"), step(1, 20, "cook", { text: "Roast the broccoli at 425F." })]),
      dish("b", "Rice Pilaf", 1, [step(0, 2, "prep"), step(1, 20, "cook", { text: "Simmer the pilaf covered." })]),
      dish("c", "Grilled Chicken", 2, [step(0, 3, "prep"), step(1, 10, "cook", { ts: true, text: "Grill the chicken." }), step(2, 2, "assemble")]),
    ];
    const r = scheduleCookingSequence(dishes);
    const idxOfTitle = new Map(dishes.map((d) => [d.title, d.dishId]));
    for (const s of r.steps) {
      if (!s.reason) continue;
      const m = /^With the (.+?) (cooking|heating up|resting|marinating|chilling|staying warm), /.exec(s.reason);
      assert.ok(m, `cue not in the expected shape: "${s.reason}"`);
      const windowDishId = idxOfTitle.get(m![1]);
      const windowEntries = r.steps.filter(
        (o) => o.dishId === windowDishId && o.sequenceIndex < s.sequenceIndex,
      );
      assert.ok(
        windowEntries.length > 0,
        `step #${s.sequenceIndex} cites "${m![1]}" but no step of it appears earlier: "${s.reason}"`,
      );
    }
  });

  it("the connective carries no subject-verb agreement, so a plural title is safe", () => {
    // 69 of 193 were "While the Warm Corn Tortillas stays warm". The fix is a
    // participial absolute, which has no agreement to get wrong — note that the
    // ruling's own "While the X is ..." would NOT have fixed this one.
    const dishes = [
      dish("tort", "Warm Corn Tortillas", 0, [
        step(0, 8, "cook", { ts: true, text: "Warm the tortillas one at a time in a dry skillet." }),
        step(1, 10, "hold", { text: "Stack the warmed tortillas and wrap them in a clean kitchen towel to keep warm." }),
      ]),
      dish("steak", "Carne Asada", 1, [step(0, 4, "prep"), step(1, 6, "cook", { ts: true, text: "Grill the steak." }), step(2, 3, "assemble", { text: "Slice the steak." })]),
    ];
    const cues = scheduleCookingSequence(dishes).steps.map((s) => s.reason).filter(Boolean) as string[];
    assert.ok(cues.length > 0, "expected at least one cue");
    for (const c of cues) {
      assert.ok(!/ (stays|rests|cooks|heats up|comes together) /.test(c), `third-person-singular verb survived: "${c}"`);
      assert.ok(!/Tortillas is /.test(c), `the copula reintroduced agreement: "${c}"`);
    }
  });

  it("a caller that passes no step text keeps the phase fallback, so no total moves", () => {
    // mealTiming and every pre-existing fixture pass no `text`. Cues are emitted
    // prose and move no number, but the guarantee is worth pinning.
    const withText = [
      dish("a", "Roast Chicken", 0, [step(0, 3, "prep"), step(1, 40, "cook", { text: "Roast the chicken." }), step(2, 5, "rest", { text: "Rest the chicken." })]),
      dish("b", "Green Beans", 1, [step(0, 4, "prep"), step(1, 8, "cook", { ts: true, text: "Blanch the beans." })]),
    ];
    const withoutText = withText.map((d) => ({
      ...d,
      steps: d.steps.map(({ text: _drop, ...rest }) => rest),
    }));
    const a = scheduleCookingSequence(withText);
    const b = scheduleCookingSequence(withoutText);
    assert.equal(a.totalEstimatedMinutes, b.totalEstimatedMinutes);
    assert.equal(a.activeEstimatedMinutes, b.activeEstimatedMinutes);
    assert.deepEqual(a.dishDurations, b.dishDurations);
    assert.deepEqual(
      a.steps.map((s) => [s.dishId, s.originalStepIndex, s.startOffsetMinutes]),
      b.steps.map((s) => [s.dishId, s.originalStepIndex, s.startOffsetMinutes]),
    );
  });
});

// ── ruling 3 — cold dishes come forward ────────────────────────────────────

describe("BUG-337 ruling 3 — a served-cold dish is pulled forward, not finish-aligned", () => {
  it("isServedCold recognises the cold set and spares the warm exceptions", () => {
    for (const t of ["Pico de Gallo", "Guacamole", "Cabbage Slaw", "Caesar Salad", "Lime Crema", "Balsamic Vinaigrette"]) {
      assert.equal(isServedCold({ title: t }), true, `${t} should be cold`);
    }
    for (const t of ["Warm Corn Tortillas", "Grilled Romaine Salad", "Roasted Tomatillo Sauce", "Wilted Spinach Salad", "Hot Bacon Dressing"]) {
      assert.equal(isServedCold({ title: t }), false, `${t} should NOT be cold`);
    }
  });

  it("cold prep moves INTO a long marinade window that was previously idle", () => {
    const dishes = [
      dish("steak", "Carne Asada", 0, [
        step(0, 5, "prep"),
        step(1, 30, "rest", { text: "Refrigerate the steak in the marinade for 30 minutes." }),
        step(2, 5, "preheat"),
        step(3, 8, "cook", { ts: true, text: "Grill the steak." }),
        step(4, 5, "rest", { text: "Rest the steak." }),
        step(5, 3, "assemble"),
      ]),
      dish("pico", "Pico de Gallo", 1, [step(0, 5, "prep"), step(1, 3, "prep"), step(2, 2, "assemble")]),
      dish("guac", "Guacamole", 2, [step(0, 4, "prep"), step(1, 3, "assemble")]),
    ];
    const marinadeStart = (r: ScheduleResult) => startOf(r, "steak", 1);
    const marinadeEnd = (r: ScheduleResult) => finishOf(r, dishes, "steak", 1);
    /** Attended minutes of OTHER dishes scheduled inside the marinade window. */
    const fill = (r: ScheduleResult) => {
      const lo = marinadeStart(r), hi = marinadeEnd(r);
      let filled = 0;
      for (const d of dishes) {
        if (d.dishId === "steak") continue;
        for (const s of d.steps) {
          const a = startOf(r, d.dishId, s.stepIndex), b = a + s.estimatedMinutes;
          filled += Math.max(0, Math.min(hi, b) - Math.max(lo, a));
        }
      }
      return filled;
    };
    const before = scheduleCookingSequence(dishes, { coldDishesForward: false });
    const after = scheduleCookingSequence(dishes);
    assert.equal(fill(before), 0, "the repro requires the window to start empty");
    assert.ok(fill(after) > 0, "cold prep did not move into the window");
  });

  it("a HOT dish is still finish-aligned — BUG-018 stays fixed", () => {
    // Hans's original repro: a short corn boil beside a long grill must not
    // finish 25 minutes early and go cold. Neither dish is served cold, so
    // ruling 3 must not touch this at all.
    const dishes = [
      dish("steak", "Grilled Steak", 0, [step(0, 3, "prep"), step(1, 30, "cook", { text: "Grill the steak." }), step(2, 5, "rest", { text: "Rest the steak." })]),
      dish("corn", "Boiled Corn", 1, [step(0, 2, "prep"), step(1, 8, "cook", { text: "Boil the corn." })]),
    ];
    const r = scheduleCookingSequence(dishes);
    const cornEnd = finishOf(r, dishes, "corn", 1);
    assert.ok(
      r.totalEstimatedMinutes - cornEnd <= 5,
      `the corn finished ${r.totalEstimatedMinutes - cornEnd} min before serve`,
    );
  });

  it("a meal with no cold dish schedules identically with the ruling on and off", () => {
    const dishes = [
      dish("a", "Roast Chicken", 0, [step(0, 3, "prep"), step(1, 40, "cook"), step(2, 5, "rest")]),
      dish("b", "Roasted Carrots", 1, [step(0, 4, "prep"), step(1, 25, "cook")]),
    ];
    assert.deepEqual(
      scheduleCookingSequence(dishes),
      scheduleCookingSequence(dishes, { coldDishesForward: false }),
    );
  });
});
