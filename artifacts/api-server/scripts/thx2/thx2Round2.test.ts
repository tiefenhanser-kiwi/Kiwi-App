// THX-3d round 2 — H (two phases, two steps), I (the put-in step), J (the warm steps),
// K (every step names its subject): the content passes, on the real sentences.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitTwoPhase } from "./thx2Phases";
import { dishNoun, inTheOvenText, putInEdits } from "./thx2PutIn";
import type { OvenStepRow } from "./thx2Oven";

const row = (ownerId: string, stepIndex: number, phaseType: string, estimatedMinutes: number, text: string): OvenStepRow => ({
  ownerId, stepIndex, phaseType, estimatedMinutes, stepTextTranslated: text, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null,
});

describe("THX-3d H — a two-phase bake or roast is two timed steps", () => {
  it("Classic's stuffing: covered 30, then uncovered 20–25", () => {
    assert.deepEqual(splitTwoPhase("On Thursday: Bake the stuffing covered for 30 minutes, then uncover and bake 20–25 minutes more until the top is golden and the center is set.", 55), {
      first: "On Thursday: Bake the stuffing covered for 30 minutes.",
      second: "Uncover and bake 20–25 minutes more until the top is golden and the center is set.",
      firstMinutes: 30, secondMinutes: 25,
    });
  });
  it("Small's breast: the temperature change is its own step; a make-ahead pie keeps its day on both", () => {
    const b = splitTwoPhase("Set the turkey breast skin-side up on the vegetable bed and roast at 425°F for 20 minutes to brown the skin, then reduce the oven to 325°F and continue roasting for about 30 minutes.", 49)!;
    assert.equal(b.second, "Reduce the oven to 325°F and continue roasting for about 30 minutes.");
    assert.deepEqual([b.firstMinutes, b.secondMinutes], [20, 30]);
    const p = splitTwoPhase("Make ahead (Wednesday): Bake at 425°F for 15 minutes, then reduce the oven to 350°F and bake 40–45 minutes more until set.", 15)!;
    assert.equal(p.second, "Make ahead (Wednesday): Reduce the oven to 350°F and bake 40–45 minutes more until set.");
    assert.equal(p.secondMinutes, 45, "the second phase takes its own minutes");
  });
  it("New Twist's Parmesan and Make-Ahead's cheddar: \"; scatter … and roast/bake N more\"", () => {
    assert.equal(splitTwoPhase("Roast at 350°F for 20 minutes; scatter 1 cup finely grated Parmesan over the potatoes and roast 5–8 minutes more until crisp.", 28)?.second, "Scatter 1 cup finely grated Parmesan over the potatoes and roast 5–8 minutes more until crisp.");
    assert.equal(splitTwoPhase("On Thursday: Bake the casserole, still covered in foil, for 45 minutes; uncover, scatter 1 cup cheddar over the top, and bake 15 minutes more.", 60)?.firstMinutes, 45);
  });
  it("a second clause out of the oven is no phase (\"; cool at least 20 minutes\"), and each half is one phase", () => {
    assert.equal(splitTwoPhase("Bake the apple crisp uncovered at 350°F for 45–50 minutes until golden; cool at least 20 minutes before serving.", 48), null);
    assert.equal(splitTwoPhase("Bake the pie at 350°F for 30 minutes, then top with 1 cup whipped cream and let it stand 10 minutes.", 30), null);
    assert.equal(splitTwoPhase("On Thursday: Bake the stuffing covered for 30 minutes.", 30), null);
    assert.equal(splitTwoPhase("Uncover and bake 20–25 minutes more until golden.", 25), null);
  });
});

describe("THX-3d I — the put-in step and what follows it", () => {
  it("after the raise, a named side's bake reads as the phase it is (the temperature stays for the scheduler)", () => {
    assert.deepEqual(inTheOvenText("On Thursday: Bake the stuffing covered for 30 minutes.", "the stuffing", 350), { lead: null, text: "On Thursday: The stuffing is in at 350°F, covered. Bake 30 minutes." });
    assert.equal(inTheOvenText("Bake the apple crisp uncovered at 350°F for 45–50 minutes until golden; cool at least 20 minutes before serving.", "the apple crisp", 350)?.text,
      "The apple crisp is in at 350°F, uncovered. Bake 45–50 minutes until golden; cool at least 20 minutes before serving.");
  });
  it("the dish's noun: the step's object, else its title's food; two casseroles are told apart", () => {
    assert.equal(dishNoun("Maple-Roasted Sweet Potatoes", "Roast at 350°F for 30–35 minutes.", []), "the sweet potatoes");
    assert.equal(dishNoun("Green Bean Casserole", "Bake the casserole covered for 30 minutes.", ["Green Bean Casserole", "Sweet Potato Casserole"]), "the green bean casserole");
  });
  const BIRD = { dishId: "t", title: "Roast Turkey Breast", positionIndex: 0, roleLabel: "main" };
  const STUFF = { dishId: "s", title: "Small-Batch Sage Stuffing", positionIndex: 1, roleLabel: "side" };
  const BEANS = { dishId: "b", title: "Roasted Green Beans", positionIndex: 2, roleLabel: "side" };
  const dishes = [BIRD, STUFF, BEANS];
  const steps = [
    row("t", 0, "preheat", 15, "On Thursday: Preheat the oven to 425°F."),
    row("t", 1, "cook", 60, "Roast the turkey breast at 425°F for 60 minutes."),
    row("t", 2, "preheat", 5, "Raise the oven to 350°F and put in the Small-Batch Sage Stuffing."),
    row("t", 3, "cook", 35, "Keep roasting the turkey breast at 350°F for about 35 more minutes, until it reads 165°F."),
    row("t", 4, "rest", 20, "Rest the turkey breast for 20 minutes."),
    row("t", 5, "assemble", 5, "Carve the turkey breast."),
    row("s", 0, "assemble", 3, "Make ahead (Wednesday): Cover and refrigerate."),
    row("s", 1, "cook", 30, "On Thursday: Bake the stuffing covered for 30 minutes."),
    row("b", 0, "prep", 4, "On Thursday: Toss the green beans with oil."),
    row("b", 1, "cook", 20, "Spread the green beans on a rimmed sheet pan and roast at 350°F for 18–20 minutes, until tender."),
    row("b", 2, "assemble", 2, "Squeeze the lemon over the beans."),
  ];
  it("the named stuffing is in; the beans the raise does not name get the work, \"Put … in the oven.\", the bake — once", () => {
    const e = putInEdits(dishes, steps);
    assert.deepEqual(e.updates.map((u) => `${u.dishId}#${u.stepIndex} ${u.text}`), [
      "s#1 On Thursday: The stuffing is in at 350°F, covered. Bake 30 minutes.",
      "b#1 The green beans are in at 350°F. Roast 18–20 minutes, until tender.",
    ]);
    assert.deepEqual(e.creates.map((c) => `${c.dishId}#${c.stepIndex} ${c.phaseType} ${c.text}`), [
      "b#1 prep Spread the green beans on a rimmed sheet pan.",
      "b#2 prep Put the green beans in the oven.",
    ]);
    assert.deepEqual(e.renumber.map((r) => `${r.dishId} ${r.from}→${r.to}`), ["b 2→4", "b 1→3"]);
    const after = [
      ...steps.filter((s) => s.ownerId !== "b").map((s) => (s.ownerId === "s" && s.stepIndex === 1 ? { ...s, stepTextTranslated: e.updates[0].text! } : s)),
      row("b", 0, "prep", 4, "On Thursday: Toss the green beans with oil."),
      row("b", 1, "prep", 2, "Spread the green beans on a rimmed sheet pan."),
      row("b", 2, "prep", 1, "Put the green beans in the oven."),
      row("b", 3, "cook", 20, e.updates[1].text!),
      row("b", 4, "assemble", 2, "Squeeze the lemon over the beans."),
    ];
    assert.deepEqual(putInEdits(dishes, after), { updates: [], deletes: [], creates: [], renumber: [] });
  });
});
