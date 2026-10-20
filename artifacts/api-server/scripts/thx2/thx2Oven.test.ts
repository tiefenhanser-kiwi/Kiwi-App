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
