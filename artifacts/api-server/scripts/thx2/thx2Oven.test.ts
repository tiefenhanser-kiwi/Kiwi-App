// THX-3b (BUG-457) — one oven temperature after the bird (thx2Oven.ts, patch.ts step 7).
//   node --import tsx --test scripts/thx2/thx2Oven.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FINALIZE_RULES } from "./thx2Core";
import { oneOvenTemperature, ovenReport, ovenTempOf, retimeForTemp, retimeDish, type OvenStepRow } from "./thx2Oven";

const row = (ownerId: string, stepIndex: number, phaseType: string, estimatedMinutes: number, text: string): OvenStepRow => ({
  ownerId, stepIndex, phaseType, estimatedMinutes, stepTextTranslated: text, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null,
});

// Make-Ahead's Thursday as stored on dev (7bba38a8): the bird, the potato casserole at
// 350°F and the stuffing at 375°F, both baked once the bird is out.
const DISHES = [
  { dishId: "turkey", title: "Dry-Brined Roast Turkey", positionIndex: 0, roleLabel: "main" },
  { dishId: "stuffing", title: "Overnight Sage Stuffing", positionIndex: 2, roleLabel: "side" },
  { dishId: "potatoes", title: "Mashed Potato Casserole", positionIndex: 3, roleLabel: "base" },
];
const STEPS = [
  row("turkey", 4, "preheat", 60, "On Thursday: Remove the turkey from the fridge 1 hour before roasting; preheat the oven to 325°F."),
  row("turkey", 7, "cook", 195, "Place the turkey on a rack in the roasting pan and roast at 325°F for 3 to 3½ hours, until the thigh reads 165°F."),
  row("turkey", 8, "rest", 40, "Transfer the turkey to a cutting board, tent loosely with foil, and let it rest 30–45 minutes before carving."),
  row("turkey", 9, "assemble", 10, "Carve the turkey and arrange on a warm platter to serve."),
  row("stuffing", 0, "prep", 10, "Make ahead (Tuesday): Cut the bread into cubes and dry them overnight."),
  row("stuffing", 6, "preheat", 15, "On Thursday: Preheat the oven to 375°F."),
  row("stuffing", 7, "cook", 55, "Bake the stuffing, still covered in foil, in the 9×13-inch dish for 30 minutes; uncover and bake 20–25 minutes more until the top is golden and crisp."),
  row("stuffing", 8, "assemble", 1, "Serve the stuffing directly from the baking dish."),
  row("potatoes", 4, "preheat", 15, "On Thursday: Preheat the oven to 350°F."),
  row("potatoes", 5, "cook", 60, "Bake the casserole, still covered in foil, in the 9×13-inch dish for 45 minutes; uncover, scatter 1 cup shredded cheddar and bake 15 minutes more."),
  row("potatoes", 6, "assemble", 2, "Scatter 3 tablespoons sliced chives over the top and serve directly from the baking dish."),
];

describe("THX-3b BUG-457 — reading an oven temperature", () => {
  it("an oven temperature, never an internal one or a frying oil's", () => {
    assert.equal(ovenTempOf("roast at 325°F for 3 hours until the thigh reads 165°F"), 325);
    assert.equal(ovenTempOf("until the center reads 165°F"), null);
    assert.equal(ovenTempOf("Preheat the oven to 375 °F."), 375);
  });
});

describe("THX-3b BUG-457 — Make-Ahead's Thursday", () => {
  const before = ovenReport(DISHES, STEPS);

  it("the bird holds the oven; both sides bake after it, at two temperatures", () => {
    assert.equal(before.holderTitle, "Dry-Brined Roast Turkey");
    const post = before.lines.filter((l) => l.afterBird);
    assert.deepEqual([...new Set(post.map((l) => l.temp))].sort(), [350, 375]);
  });

  it("350°F holds the most oven minutes; the stuffing moves to it, by time alone", () => {
    const one = oneOvenTemperature(before);
    assert.equal(one.target, 350);
    assert.deepEqual(one.changes.map((c) => [c.title, c.from, c.to]), [["Overnight Sage Stuffing", 375, 350]]);
    assert.deepEqual(one.refused, []);
    const re = retimeDish(STEPS, one.changes[0]);
    assert.equal(re.get(6)!.text, "On Thursday: Preheat the oven to 350°F.");
    assert.equal(re.get(7)!.text, "Bake the stuffing, still covered in foil, in the 9×13-inch dish for 35 minutes; uncover and bake 20–25 minutes more until the top is golden and crisp.");
    assert.equal(re.get(7)!.minutes, 60);
  });

  it("patched, every post-bird oven step is 350°F and the patch is idempotent", () => {
    const one = oneOvenTemperature(before);
    const re = retimeDish(STEPS, one.changes[0]);
    const patched = STEPS.map((s) => (s.ownerId === "stuffing" && re.has(s.stepIndex) ? { ...s, stepTextTranslated: re.get(s.stepIndex)!.text, estimatedMinutes: re.get(s.stepIndex)!.minutes } : s));
    const after = ovenReport(DISHES, patched);
    assert.deepEqual([...new Set(after.lines.filter((l) => l.afterBird).map((l) => l.temp))], [350]);
    assert.deepEqual(oneOvenTemperature(after).changes, []);
    // The hold between the bird's rest and the carve (Make-Ahead dev: 40 min).
    assert.ok(after.bird && after.bird.carveStart - after.bird.restEnd < 60);
  });
});

describe("THX-3b BUG-457 — the guard: more than 25°F is more than a time change", () => {
  it("a side at 425°F beside two at 350°F is refused, not retimed", () => {
    const steps = [
      ...STEPS,
      row("sprouts", 1, "preheat", 15, "Preheat the oven to 425°F."),
      row("sprouts", 2, "cook", 25, "Roast at 425°F for 20–25 minutes, until charred."),
    ];
    const dishes = [...DISHES, { dishId: "sprouts", title: "Roasted Brussels Sprouts", positionIndex: 4, roleLabel: "side" }];
    const one = oneOvenTemperature(ovenReport(dishes, steps));
    assert.deepEqual(one.refused.map((c) => [c.title, c.from, c.to]), [["Roasted Brussels Sprouts", 425, 350]]);
  });

  it("a hotter move shortens the time (≈10% per 25°F)", () => {
    assert.deepEqual(retimeForTemp("Bake at 350°F for 40 minutes.", 350, 375), { text: "Bake at 375°F for 35 minutes.", extraMinutes: -5 });
  });
});

describe("THX-3b BUG-457 — new generations get the rule", () => {
  it("FINALIZE_RULES (g)", () => assert.match(FINALIZE_RULES, /\(g\) One oven after the bird: .*ONE temperature/));
});

// ── THX-3c — the code-written oven steps (patch.ts 9, 10, 11) ────────────────
import { heldDishSteps, ovenConflicts, splitPreheatSteps } from "./thx2Oven";

// Dev's Vegetarian (4d543799), Thursday as stored before THX-3c.
const VEG = [
  { dishId: "wellington", title: "Mushroom Wellington", positionIndex: 0, roleLabel: "main" },
  { dishId: "stuffing", title: "Herb Stuffing", positionIndex: 1, roleLabel: "side" },
  { dishId: "mac", title: "Baked Mac and Cheese", positionIndex: 2, roleLabel: "side" },
  { dishId: "sprouts", title: "Balsamic Roasted Brussels Sprouts", positionIndex: 3, roleLabel: "side" },
];
const VEG_STEPS = [
  row("wellington", 4, "rest", 20, "Once cool, stir in the walnuts, cheese, spinach and egg."),
  row("wellington", 5, "preheat", 15, "Preheat the oven to 425°F. Season the 4 portobello caps on both sides with ½ teaspoon kosher salt."),
  row("wellington", 6, "assemble", 8, "Lay out the pastry and fill it."),
  row("wellington", 7, "assemble", 7, "Fold and seal the pastry."),
  row("wellington", 8, "cook", 30, "Bake at 425°F for 28–32 minutes until the pastry is deep golden brown."),
  row("wellington", 9, "rest", 10, "Rest the Wellingtons on the pan for 10 minutes, then slice."),
  row("stuffing", 4, "assemble", 3, "Make ahead (Wednesday): Cover and refrigerate overnight."),
  row("stuffing", 5, "preheat", 15, "On Thursday: Preheat the oven to 375°F."),
  row("stuffing", 6, "cook", 45, "Bake the stuffing covered at 375°F for 30 minutes, then uncover and bake 15 more minutes."),
  row("mac", 4, "assemble", 5, "Make ahead (Wednesday): Cover tightly with foil and refrigerate overnight."),
  row("mac", 5, "preheat", 15, "On Thursday: Preheat the oven to 375°F. Mix the panko topping."),
  row("mac", 6, "cook", 35, "Bake uncovered at 375°F for 35 minutes."),
  row("sprouts", 0, "prep", 10, "Trim and halve the sprouts."),
  row("sprouts", 1, "preheat", 15, "Preheat the oven to 425°F."),
  row("sprouts", 2, "cook", 25, "Roast at 425°F for 20–25 minutes."),
];

describe("THX-3c BUG-463 — Vegetarian's code-written steps", () => {
  it("a CONFLICT line for two oven steps overlapping at two temperatures (BUG-463 as it was), none at one", () => {
    const line = (dishId: string, temp: number, start: number, end: number) => ({ dishId, title: dishId, stepIndex: 1, temp, start, end, holder: false, afterBird: false });
    const r = { holderTitle: null, ovenOut: null, total: 164, bird: null, lines: [line("wellington", 425, -40, -10), line("mac", 375, -40, -5), line("sprouts", 425, -38, -13)] };
    assert.deepEqual(ovenConflicts(r), ["T-40→-10 425°F wellington #1 overlaps T-40→-5 375°F mac #1", "T-40→-5 375°F mac #1 overlaps T-38→-13 425°F sprouts #1"]);
    assert.deepEqual(ovenConflicts({ ...r, lines: [r.lines[0], r.lines[2]] }), []);
  });

  it("the Wellington's preheat is split from the cap seasoning; its later steps move down", () => {
    const [sp] = splitPreheatSteps(VEG, VEG_STEPS);
    assert.equal(sp.preheat.text, "Preheat the oven to 425°F.");
    assert.deepEqual([sp.work.stepIndex, sp.work.phaseType, sp.work.text], [6, "prep", "Season the 4 portobello caps on both sides with ½ teaspoon kosher salt."]);
    assert.deepEqual(sp.renumber.map((r) => `${r.from}→${r.to}`), ["9→10", "8→9", "7→8", "6→7"]);
  });

  it("the held dishes get a foil step and a 425°F reheat; then nothing conflicts, and a second run adds nothing", () => {
    const { creates: held, renumber } = heldDishSteps(VEG, VEG_STEPS);
    assert.deepEqual(renumber, []); // the stuffing and the mac end on their oven step
    assert.deepEqual(held.map((c) => `${c.dishId}#${c.stepIndex} ${c.phaseType} ${c.estimatedMinutes}`), ["stuffing#7 assemble 1", "stuffing#8 cook 10", "mac#7 assemble 1", "mac#8 cook 10"]);
    assert.match(held[1].text, /^Return it, uncovered, to the 425°F oven for 10 minutes/);
    const sp = splitPreheatSteps(VEG, VEG_STEPS)[0];
    const after = VEG_STEPS.map((s) => {
      if (s.ownerId === "wellington" && s.stepIndex === 5) return { ...s, stepTextTranslated: sp.preheat.text };
      const m = sp.renumber.find((r) => r.dishId === s.ownerId && r.from === s.stepIndex);
      return m ? { ...s, stepIndex: m.to } : s;
    });
    const all = [
      ...after,
      row("wellington", 6, "prep", 3, sp.work.text),
      ...held.map((c) => row(c.dishId, c.stepIndex, c.phaseType, c.estimatedMinutes, c.text)),
    ];
    assert.deepEqual(ovenConflicts(ovenReport(VEG, all)), []);
    assert.deepEqual(heldDishSteps(VEG, all), { creates: [], renumber: [] });
    assert.deepEqual(splitPreheatSteps(VEG, all), []);
  });
});

// THX-3c item 3 (raiseOvenStep) was replaced by THX-3d D's raise step while the bird
// roasts (thx2Thursday, its own tests in thx2Thursday.test.ts).
