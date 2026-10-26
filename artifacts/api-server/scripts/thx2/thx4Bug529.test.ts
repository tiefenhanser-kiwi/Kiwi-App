// THX-4 (BUG-529) — what goes into the turned-off oven comes out. Classic's green bean and
// sweet potato casseroles went into the off oven at T−19 and no step took them out; the
// serve step's cue said "With the Sweet Potato Casserole cooking" with its bake done at
// T−19. The content half writes "Take the sides out of the oven." after every oven-off
// (thx2Warm); the scheduler serves the one the day keeps at serving and merges the rest,
// and a cue whose dish has nothing running goes.
//   node --import tsx --test scripts/thx2/thx4Bug529.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { FEAST_SERVE_STEP, feastRoastDish, isOvenStep, isUnattended, OVEN_OFF_STEP, OVEN_OFF_TEXT, scheduleCookingSequence, TAKE_OUT_STEP, TAKE_OUT_TEXT, WARM_GAP, type SchedulerDish } from "../../src/lib/cookingScheduler";
import { thursdaySchedule, type OvenDish, type OvenStepRow } from "./thx2Oven";
import { warmStepEdits } from "./thx2Warm";

const row = (ownerId: string, stepIndex: number, phaseType: string, estimatedMinutes: number, text: string): OvenStepRow => ({
  ownerId, stepIndex, stepTextTranslated: text, phaseType, estimatedMinutes, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null,
});

// Classic's shape (prod copy, release #5): the bird, the raise, two casseroles baked
// beside it and after it, each with its oven-off, and the one serve step.
const BIRD: OvenDish = { dishId: "t", title: "Herb-Roasted Whole Turkey", positionIndex: 0, roleLabel: "main", ovenRacks: 1, ovenVessel: "dish" };
const GBC: OvenDish = { dishId: "g", title: "Green Bean Casserole", positionIndex: 1, roleLabel: "side", ovenRacks: 0.5, ovenVessel: "dish" };
const SPC: OvenDish = { dishId: "p", title: "Sweet Potato Casserole", positionIndex: 2, roleLabel: "side", ovenRacks: 0.5, ovenVessel: "dish" };
const birdRows = [
  row("t", 0, "preheat", 20, "On Thursday: Preheat the oven to 325°F."),
  row("t", 1, "cook", 162, "Roast the turkey at 325°F for about 2¾ hours; baste with pan drippings every 45 minutes."),
  row("t", 2, "preheat", 5, "Raise the oven to 350°F and put in the Green Bean Casserole."),
  row("t", 3, "cook", 25, "Keep roasting the turkey at 350°F for about 25 more minutes, until an instant-read thermometer reads 165°F."),
  row("t", 4, "rest", 25, "Transfer the turkey to a carving board, tent loosely with foil, and rest 20–30 minutes before carving."),
  row("t", 5, "assemble", 10, "Carve the turkey and arrange on a large platter."),
  row("t", 6, "assemble", 2, "Serve the Herb-Roasted Whole Turkey with the Green Bean Casserole and Sweet Potato Casserole."),
];
const gbcRows = (takeOut: boolean) => [
  row("g", 0, "cook", 25, "On Thursday: The green bean casserole is in at 350°F, covered. Bake 25 minutes."),
  row("g", 1, "cook", 10, "Uncover, scatter the fried onions over the top, and bake uncovered 10 minutes more."),
  row("g", 2, "assemble", 1, OVEN_OFF_TEXT),
  ...(takeOut ? [row("g", 3, "assemble", 1, TAKE_OUT_TEXT)] : []),
];
const spcRows = (takeOut: boolean) => [
  row("p", 0, "prep", 1, "On Thursday: Put the sweet potato casserole in the oven."),
  row("p", 1, "cook", 20, "The sweet potato casserole is in at 350°F, covered. Bake 20 minutes."),
  row("p", 2, "cook", 10, "Uncover and bake 10 minutes more until the streusel is golden."),
  row("p", 3, "assemble", 1, OVEN_OFF_TEXT),
  ...(takeOut ? [row("p", 4, "assemble", 1, TAKE_OUT_TEXT)] : []),
];

describe("THX-4 (BUG-529) — the content: a take-out after every oven-off (thx2Warm)", () => {
  it("release #5's casserole (an oven-off, nothing after) gets the take-out right after it", () => {
    const e = warmStepEdits([BIRD, GBC, SPC], [...birdRows, ...gbcRows(false), ...spcRows(false)]);
    assert.deepEqual(e.creates.map((c) => [c.dishId, c.stepIndex, c.text, c.phaseType, c.estimatedMinutes]), [
      ["g", 3, TAKE_OUT_TEXT, "assemble", 1],
      ["p", 4, TAKE_OUT_TEXT, "assemble", 1],
    ]);
    assert.deepEqual(e.renumber, []);
  });

  it("idempotent: a take-out already there is left alone", () => {
    const e = warmStepEdits([BIRD, GBC, SPC], [...birdRows, ...gbcRows(true), ...spcRows(true)]);
    assert.deepEqual([e.creates, e.renumber, e.updates, e.deletes], [[], [], [], []]);
  });

  it("a step after the oven-off moves down one for it", () => {
    const rows = [...gbcRows(false), row("g", 3, "assemble", 2, "Scatter the crispy shallots over the top.")];
    const e = warmStepEdits([BIRD, GBC], [...birdRows, ...rows]);
    assert.deepEqual(e.renumber, [{ dishId: "g", from: 3, to: 4 }]);
    assert.deepEqual(e.creates.map((c) => [c.stepIndex, c.text]), [[3, TAKE_OUT_TEXT]]);
  });

  it("a new oven side gets both, the oven-off then the take-out, the steps after moving down two", () => {
    const rows = [
      row("g", 0, "cook", 25, "On Thursday: The green bean casserole is in at 350°F, covered. Bake 25 minutes."),
      row("g", 1, "assemble", 2, "Scatter the crispy shallots over the top."),
    ];
    const e = warmStepEdits([BIRD, GBC], [...birdRows, ...rows]);
    assert.deepEqual(e.creates.map((c) => [c.stepIndex, c.text]), [[1, OVEN_OFF_TEXT], [2, TAKE_OUT_TEXT]]);
    assert.deepEqual(e.renumber, [{ dishId: "g", from: 1, to: 3 }]);
  });
});


// The five prod copies after release #6's patch (scripts/_scratch/thx-4/dumpFixture.ts),
// as thursdaySchedule hands them to the scheduler; New Twist at 4 servings too.
const FEASTS = JSON.parse(readFileSync(new URL("./fixtures/thx4Bug529.feasts.json", import.meta.url), "utf8")) as Record<string, SchedulerDish[]>;
const without = (ds: SchedulerDish[]) => ds.map((d) => ({ ...d, steps: d.steps.filter((s) => !TAKE_OUT_STEP.test(s.text ?? "")) }));

describe("THX-4 (BUG-529) — the day: one take-out, after every side left in the oven, at serving", () => {
  // feast → the dish whose take-out is served, and when (T, minutes before serving)
  const WANT: Record<string, [RegExp, number]> = {
    "classic": [/^Sweet Potato Casserole$/, -6],
    "make-ahead": [/^Mashed Potato Casserole$/, -14],
    "new-twist": [/^Cornbread and Chorizo Stuffing$/, -1],
    "new-twist@4": [/^Cornbread and Chorizo Stuffing$/, -1],
    "small": [/^Small-Batch Sage Stuffing$/, -1],
    "vegetarian": [/^Herb Stuffing$/, -5],
  };
  for (const [key, [host, at]] of Object.entries(WANT)) {
    it(`${key}: ${host.source.slice(1, -1)}'s take-out at T${at}; the rest merged; the day unchanged but its minute`, () => {
      const ds = FEASTS[key];
      const r = scheduleCookingSequence(ds, { feastOven: true });
      const base = scheduleCookingSequence(without(ds), { feastOven: true });
      const stepOf = (e: { dishId: string; originalStepIndex: number }) => ds.find((d) => d.dishId === e.dishId)!.steps.find((s) => s.stepIndex === e.originalStepIndex)!;
      const serve = r.steps.find((e) => FEAST_SERVE_STEP.test(stepOf(e).text ?? ""))!;
      const takes = r.steps.filter((e) => TAKE_OUT_STEP.test(stepOf(e).text ?? ""));
      assert.equal(takes.length, 1);
      assert.match(ds.find((d) => d.dishId === takes[0].dishId)!.title, host);
      assert.equal(takes[0].startOffsetMinutes - serve.startOffsetMinutes, at);
      assert.ok(serve.startOffsetMinutes - takes[0].startOffsetMinutes <= WARM_GAP);
      // Every other take-out is merged away (the client must not append it).
      const all = ds.flatMap((d) => d.steps.filter((s) => TAKE_OUT_STEP.test(s.text ?? "")).map((s) => `${d.dishId}#${s.stepIndex}`));
      const merged = new Set((r.mergedSteps ?? []).map((m) => `${m.dishId}#${m.stepIndex}`));
      assert.deepEqual(all.filter((x) => !merged.has(x)), [`${takes[0].dishId}#${takes[0].originalStepIndex}`]);
      // Every oven side's last oven step ends by the take-out, or the side has its own step out after it.
      for (const d of ds) {
        const placed = r.steps.filter((e) => e.dishId === d.dishId).sort((a, b) => a.originalStepIndex - b.originalStepIndex);
        const oven = placed.filter((e) => { const s = stepOf(e); return isOvenStep(s) && s.phaseType !== "preheat"; }).pop();
        if (!oven || d.dishId === feastRoastDish(ds)?.dishId) continue;
        const end = oven.startOffsetMinutes + stepOf(oven).estimatedMinutes;
        const own = placed.some((e) => e.originalStepIndex > oven.originalStepIndex && e !== serve && !OVEN_OFF_STEP.test(stepOf(e).text ?? ""));
        assert.ok(own || takes[0].startOffsetMinutes >= end, `${d.title} left in the oven`);
      }
      // The day is the day without the take-outs: the same total, the one minute's hands.
      assert.equal(r.totalEstimatedMinutes, base.totalEstimatedMinutes);
      assert.equal(r.activeEstimatedMinutes, base.activeEstimatedMinutes + 1);
    });
  }

  it("Classic's serve step no longer says the Sweet Potato Casserole is cooking (its bake ended at T−17)", () => {
    const ds = FEASTS["classic"];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    const serve = r.steps.find((e) => FEAST_SERVE_STEP.test(ds.find((d) => d.dishId === e.dishId)!.steps.find((s) => s.stepIndex === e.originalStepIndex)!.text ?? ""))!;
    assert.equal(serve.reason, undefined);
  });

  it("every cue left names a dish with a hands-free step running as its step starts (all five, and New Twist at 4)", () => {
    for (const ds of Object.values(FEASTS)) {
      const r = scheduleCookingSequence(ds, { feastOven: true });
      const stepOf = (e: { dishId: string; originalStepIndex: number }) => ds.find((d) => d.dishId === e.dishId)!.steps.find((s) => s.stepIndex === e.originalStepIndex)!;
      for (const e of r.steps.filter((x) => x.reason)) {
        const named = [...ds].sort((a, b) => b.title.length - a.title.length).find((x) => x.dishId !== e.dishId && e.reason!.startsWith(`With the ${x.title} `));
        assert.ok(named, e.reason);
        assert.ok(r.steps.some((o) => o.dishId === named!.dishId && o.sequenceIndex < e.sequenceIndex && isUnattended(stepOf(o)) && o.startOffsetMinutes <= e.startOffsetMinutes && e.startOffsetMinutes < o.startOffsetMinutes + stepOf(o).estimatedMinutes), `stale: ${e.reason}`);
      }
    }
  });

  it("a feast with no take-out written is scheduled as it was (the branch needs one)", () => {
    const ds = without(FEASTS["classic"]);
    assert.equal(ds.some((d) => d.steps.some((s) => TAKE_OUT_STEP.test(s.text ?? ""))), false);
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.equal(r.steps.some((e) => TAKE_OUT_STEP.test(ds.find((d) => d.dishId === e.dishId)!.steps.find((s) => s.stepIndex === e.originalStepIndex)!.text ?? "")), false);
  });

  it("the synthetic Classic (both casseroles finish near serving): nothing kept, the day the same", () => {
    const d = thursdaySchedule([BIRD, GBC, SPC], [...birdRows, ...gbcRows(true), ...spcRows(true)]);
    // Both casseroles finish near serving here: no oven-off is kept, nothing is left in (each
    // has its oven-off then its take-out, both merged), and the day is the day without them.
    const base = thursdaySchedule([BIRD, GBC, SPC], [...birdRows, ...gbcRows(false), ...spcRows(false)]);
    assert.equal(d.result.totalEstimatedMinutes, base.result.totalEstimatedMinutes);
  });
});
