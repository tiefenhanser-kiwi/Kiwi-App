// THX-3c (BUG-463, chat-Claude's ruling) — a feast's oven: one preheat per
// temperature; with no bird, one temperature at a time — the dishes that hold well
// covered bake first and come out as the oven changes temperature, then go back in,
// uncovered, for the last 10 minutes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  holdCoveredText,
  isOvenStep,
  ovenTempOfText,
  reheatText,
  scheduleCookingSequence,
  type SchedulerDish,
  type SchedulerPhase,
} from "../cookingScheduler";

let n = 0;
const step = (phaseType: SchedulerPhase, estimatedMinutes: number, text: string) => ({ stepIndex: n++, phaseType, estimatedMinutes, isTimingSensitive: phaseType === "prep" || phaseType === "assemble", text });
const dish = (dishId: string, title: string, positionIndex: number, steps: ReturnType<typeof step>[]): SchedulerDish => {
  n = 0;
  return { dishId, title, positionIndex, steps: steps.map((s, i) => ({ ...s, stepIndex: i })) };
};

// Dev's Vegetarian Friendsgiving, Thursday only, as patch.ts leaves it.
function vegetarian(): SchedulerDish[] {
  return [
    dish("wellington", "Mushroom Wellington", 0, [
      step("prep", 15, "Finely chop the mushrooms."),
      step("cook", 15, "Cook the duxelles until dry."),
      step("rest", 20, "Cool the duxelles."),
      step("preheat", 15, "Preheat the oven to 425°F."),
      step("prep", 3, "Season the 4 portobello caps."),
      step("assemble", 8, "Lay out the pastry and fill it."),
      step("assemble", 7, "Fold and seal the pastry."),
      step("cook", 30, "Bake at 425°F for 28–32 minutes."),
      step("rest", 10, "Rest the Wellingtons for 10 minutes, then slice."),
    ]),
    dish("stuffing", "Herb Stuffing", 1, [
      step("preheat", 15, "On Thursday: Preheat the oven to 375°F."),
      step("cook", 45, "Bake the stuffing covered at 375°F for 30 minutes, then uncover and bake 15 more minutes."),
      step("assemble", 1, holdCoveredText("Herb Stuffing")),
      step("cook", 10, reheatText("Herb Stuffing", 425)),
    ]),
    dish("mac", "Baked Mac and Cheese", 2, [
      step("preheat", 15, "On Thursday: Preheat the oven to 375°F. Mix the panko topping and scatter it over."),
      step("cook", 35, "Bake uncovered at 375°F for 35 minutes."),
      step("assemble", 1, holdCoveredText("Baked Mac and Cheese")),
      step("cook", 10, reheatText("Baked Mac and Cheese", 425)),
    ]),
    dish("sprouts", "Balsamic Roasted Brussels Sprouts", 3, [
      step("prep", 10, "Trim and halve the sprouts."),
      step("preheat", 15, "Preheat the oven to 425°F."),
      step("cook", 25, "Roast at 425°F for 20–25 minutes."),
      step("assemble", 3, "Toss with the glaze."),
    ]),
    dish("potatoes", "Mashed Potatoes", 4, [
      step("prep", 10, "Peel and cut the potatoes."),
      step("cook", 20, "Boil the potatoes."),
      step("assemble", 9, "Drain and mash."),
    ]),
    // Hands-on work that competes with the Wellington's assembly (the gravy and the
    // mash held the cook on dev): it is what made a fixed preheat leave the oven idle.
    dish("gravy", "Mushroom Gravy", 5, [
      step("prep", 15, "Slice the mushrooms, mince the shallots."),
      step("assemble", 15, "Make the roux and whisk in the broth."),
      step("prep", 10, "Strain and season the gravy."),
    ]),
  ];
}

/** Each scheduled oven step with its temperature (its own, or its dish's last before it). */
function ovenWindows(dishes: SchedulerDish[], feast = true) {
  const r = scheduleCookingSequence(dishes, { feastOven: feast });
  const out: { dishId: string; step: number; phase: string; temp: number | null; start: number; end: number }[] = [];
  for (const d of dishes) {
    let temp: number | null = null;
    for (const s of d.steps) {
      const own = ovenTempOfText(s.text);
      if (!isOvenStep(s)) continue;
      if (own !== null) temp = own;
      const at = r.steps.find((x) => x.dishId === d.dishId && x.originalStepIndex === s.stepIndex);
      if (at) out.push({ dishId: d.dishId, step: s.stepIndex, phase: s.phaseType, temp, start: at.startOffsetMinutes, end: at.startOffsetMinutes + s.estimatedMinutes });
    }
  }
  return { r, out };
}

describe("THX-3c B — Vegetarian's oven, one temperature at a time", () => {
  const { r, out } = ovenWindows(vegetarian());
  const w = (dishId: string, step: number) => out.find((o) => o.dishId === dishId && o.step === step)!;

  it("no two oven steps overlap at two temperatures", () => {
    for (const a of out) for (const b of out) {
      if (a === b || a.temp === b.temp || a.dishId === b.dishId) continue;
      assert.ok(!(a.start < b.end && b.start < a.end), `${a.dishId}#${a.step} ${a.temp}°F overlaps ${b.dishId}#${b.step} ${b.temp}°F`);
    }
  });

  it("one preheat per temperature: the stuffing's and the sprouts' pure preheats are merged away", () => {
    const pre = r.steps.filter((s) => vegetarian().find((d) => d.dishId === s.dishId)!.steps[s.originalStepIndex].phaseType === "preheat");
    assert.deepEqual(pre.map((s) => `${s.dishId}#${s.originalStepIndex}`).sort(), ["mac#0", "wellington#3"]);
  });

  it("the held dishes come out as the oven changes temperature: the 425°F preheat starts as the last of them finishes", () => {
    const held = Math.max(w("stuffing", 1).end, w("mac", 1).end);
    assert.equal(w("wellington", 3).start, held);
  });

  it("no idle gap at 425°F: the preheat ends as the Wellington goes in", () => {
    assert.equal(w("wellington", 7).start, w("wellington", 3).end);
  });

  it("covered, then back in uncovered for the last 10 minutes, landing at serving time", () => {
    for (const d of ["stuffing", "mac"]) {
      const cover = r.steps.find((s) => s.dishId === d && s.originalStepIndex === 2)!;
      assert.ok(cover.startOffsetMinutes >= w(d, 1).end, `${d} covered after it comes out`);
      assert.deepEqual([w(d, 3).start, w(d, 3).end, w(d, 3).temp], [-10, 0, 425]);
    }
  });

  it("the Wellington's own steps keep their order (the caps are seasoned before it is filled)", () => {
    const at = (i: number) => r.steps.find((s) => s.dishId === "wellington" && s.originalStepIndex === i)!.startOffsetMinutes;
    for (let i = 5; i <= 8; i++) assert.ok(at(i) >= at(i - 1), `#${i} before #${i - 1}`);
  });

  it("outside a feast nothing is merged or moved", () => {
    const plain = scheduleCookingSequence(vegetarian());
    assert.equal(plain.steps.length, vegetarian().reduce((s, d) => s + d.steps.length, 0));
  });
});

describe("THX-3c B — with a bird, the sides' two preheats to one temperature are one (Make-Ahead)", () => {
  const makeAhead = () => [
    dish("turkey", "Dry-Brined Roast Turkey", 0, [
      step("preheat", 60, "On Thursday: Remove the turkey from the fridge; preheat the oven to 325°F."),
      step("cook", 195, "Roast the turkey at 325°F for 3 to 3½ hours."),
      step("rest", 40, "Rest the turkey."),
      step("assemble", 10, "Carve the turkey."),
    ]),
    dish("stuffing", "Overnight Sage Stuffing", 1, [
      step("preheat", 15, "On Thursday: Preheat the oven to 350°F."),
      step("cook", 60, "Bake the stuffing at 350°F for 55 minutes."),
    ]),
    dish("potatoes", "Mashed Potato Casserole", 2, [
      step("preheat", 15, "On Thursday: Preheat the oven to 350°F."),
      step("cook", 60, "Bake the casserole at 350°F for 60 minutes."),
    ]),
  ];

  it("one 350°F preheat, and the potatoes go in only after it", () => {
    const { r, out } = ovenWindows(makeAhead());
    const pre350 = out.filter((o) => o.phase === "preheat" && o.temp === 350);
    assert.equal(pre350.length, 1);
    const potatoesBake = out.find((o) => o.dishId === "potatoes" && o.phase === "cook")!;
    assert.ok(potatoesBake.start >= pre350[0].end, `${potatoesBake.start} < ${pre350[0].end}`);
    assert.equal(r.steps.filter((s) => s.dishId === "potatoes").length, 1);
  });
});
