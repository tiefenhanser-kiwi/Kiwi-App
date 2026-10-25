// THX-3d round 5 — the content half of D-WS9-322 (patch.ts): which sides bake before the
// bird, which go in as it comes out, and the main dish's crowded block.
//   node --import tsx --test scripts/thx2/thx2Round5.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { heldDishSteps, type OvenDish, type OvenStepRow } from "./thx2Oven";
import { thursdayPostPass } from "./thx2Thursday";

const row = (ownerId: string, stepIndex: number, phaseType: string, estimatedMinutes: number, text: string): OvenStepRow => ({
  ownerId, stepIndex, stepTextTranslated: text, phaseType, estimatedMinutes, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null,
});

describe("THX-3d round 5 (D-WS9-322 (2), (4)) — before the bird, and the words say so", () => {
  const BIRD: OvenDish = { dishId: "t", title: "Citrus-Herb Spatchcock Turkey", positionIndex: 0 };
  const birdRows = [
    row("t", 0, "preheat", 20, "On Thursday: Preheat the oven to 400°F."),
    row("t", 1, "cook", 105, "Set the turkey on the sheet pan and roast at 400°F for about 1¾ hours, until the thigh reads 165°F."),
    row("t", 2, "rest", 25, "Rest the turkey on the sheet pan for 20–30 minutes before carving."),
    row("t", 3, "assemble", 10, "Carve the turkey."),
  ];
  const side = (id: string, title: string, pos: number, racks: number, vessel: "sheet" | "dish", minutes: number): { d: OvenDish; rows: OvenStepRow[] } => ({
    d: { dishId: id, title, positionIndex: pos, ovenRacks: racks, ovenVessel: vessel },
    rows: [row(id, 0, "cook", minutes, `On Thursday: Roast the ${title.toLowerCase()} at 400°F for ${minutes} minutes.`)],
  });

  it("at its own 10 servings: the stuffing beside the bird (done as it comes out), the smashed potatoes then, the sweet potatoes before it", () => {
    const s = side("s", "Cornbread Stuffing", 1, 0.5, "dish", 42);
    const k = side("k", "Smashed Potatoes", 2, 2, "sheet", 35);
    const v = side("v", "Sweet Potatoes", 3, 2, "sheet", 40);
    const e = thursdayPostPass([BIRD, s.d, k.d, v.d], [...birdRows, ...s.rows, ...k.rows, ...v.rows]);
    assert.equal(e.creates.find((c) => /in the oven with the turkey/.test(c.text))!.text, "Put the Cornbread Stuffing in the oven with the turkey; the Smashed Potatoes go in when the turkey comes out.");
    assert.deepEqual(e.creates.filter((c) => c.dishId === "v").map((c) => c.text), [
      "Cover the Sweet Potatoes with foil to keep them warm.",
      "Return the Sweet Potatoes, uncovered, to the 400°F oven for 10 minutes, until hot again.",
    ]);
    assert.equal(e.creates.filter((c) => c.dishId === "s").length, 2, "the stuffing is held too (the rest window's racks are the potatoes')");
    assert.equal(e.creates.filter((c) => c.dishId === "k").length, 0, "the smashed potatoes are not held");
  });

  it("when both pans fit the rest window together, nothing bakes before the bird", () => {
    const s = side("s", "Cornbread Stuffing", 1, 0.5, "dish", 42);
    const k = side("k", "Smashed Potatoes", 2, 1, "sheet", 35);
    const v = side("v", "Sweet Potatoes", 3, 1, "sheet", 40);
    const e = thursdayPostPass([BIRD, s.d, k.d, v.d], [...birdRows, ...s.rows, ...k.rows, ...v.rows]);
    assert.equal(e.creates.filter((c) => c.dishId === "v").length, 0);
    // (The stuffing stays in to the rest's end beside one pan; the other waits for room.)
    assert.match(e.creates.find((c) => /in the oven with the turkey/.test(c.text))!.text, /; the Sweet Potatoes go in when the turkey comes out\.$/);
  });
});

describe("THX-3d round 5 (D-WS9-322 (3)) — the main dish's crowded block", () => {
  const well: OvenDish = { dishId: "w", title: "Mushroom Wellington", positionIndex: 0, roleLabel: "main", ovenRacks: 1, ovenVessel: "sheet" };
  const mac: OvenDish = { dishId: "m", title: "Baked Mac and Cheese", positionIndex: 2, roleLabel: "side", ovenRacks: 0.5, ovenVessel: "dish" };
  const rows = (sproutRacks: number) => ({
    dishes: [well, { dishId: "b", title: "Balsamic Roasted Brussels Sprouts", positionIndex: 1, roleLabel: "side", ovenRacks: sproutRacks, ovenVessel: "sheet" as const }, mac],
    steps: [
      row("w", 0, "preheat", 15, "Preheat the oven to 425°F."), row("w", 1, "cook", 30, "Bake on the sheet pan at 425°F for 25–30 minutes."),
      row("b", 0, "cook", 25, "Roast at 425°F for 22–25 minutes."), row("b", 1, "assemble", 2, "Transfer to a platter."),
      row("m", 0, "preheat", 15, "On Thursday: Preheat the oven to 375°F."), row("m", 1, "cook", 45, "Bake uncovered at 375°F for 45 minutes."),
    ],
  });
  it("two pans of sprouts beside the Wellington's: the sprouts are held and reheated", () => {
    const { dishes, steps } = rows(2);
    const h = heldDishSteps(dishes, steps);
    assert.deepEqual(h.creates.filter((c) => c.dishId === "b").map((c) => [c.stepIndex, c.text]), [
      [1, "Cover the Balsamic Roasted Brussels Sprouts with foil to keep them warm while the oven heats for the next dish."],
      [2, "Return the Balsamic Roasted Brussels Sprouts, uncovered, to the 425°F oven for 10 minutes, until hot again."],
    ]);
    assert.ok(!h.creates.some((c) => c.dishId === "w"), "never the main");
  });
  it("one pan: the sprouts share the oven, nothing is written", () => {
    const { dishes, steps } = rows(1);
    assert.ok(!heldDishSteps(dishes, steps).creates.some((c) => c.dishId === "b"));
  });
});
