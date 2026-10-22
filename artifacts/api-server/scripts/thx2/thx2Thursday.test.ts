// THX-3d (D, R4) — Thursday's content half (thx2Thursday): the roast's time, the sit,
// the rest, the serve steps, the raise.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shortenRoastText, thursdayPostPass, thursdayPrePass } from "./thx2Thursday";
import type { OvenDish, OvenStepRow } from "./thx2Oven";

const row = (ownerId: string, stepIndex: number, phaseType: string, estimatedMinutes: number, stepTextTranslated: string): OvenStepRow => ({
  ownerId, stepIndex, phaseType, estimatedMinutes, stepTextTranslated, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null,
});

describe("THX-3d D — the roast's time, cut where the oven is raised", () => {
  it("Classic: the hours and the thermometer clause go; the time is 'about'", () => {
    assert.equal(
      shortenRoastText("Place the turkey breast side up on a rack in a large roasting pan and roast at 325°F for 3 to 3½ hours (about 13–15 minutes per pound), until an instant-read thermometer in the thickest part of the thigh reads 165°F.", 166),
      "Place the turkey breast side up on a rack in a large roasting pan and roast at 325°F for about 2¾ hours.",
    );
  });
  it("Small: the 20 minutes at 425°F stay; the 325°F part is what is left", () => {
    assert.equal(
      shortenRoastText("Set the turkey breast skin-side up on the vegetable bed and roast at 425°F for 20 minutes to brown the skin, then reduce the oven to 325°F and continue roasting until an instant-read thermometer in the thickest part reads 165°F, about 60–70 minutes more.", 49),
      "Set the turkey breast skin-side up on the vegetable bed and roast at 425°F for 20 minutes to brown the skin, then reduce the oven to 325°F and continue roasting for about 30 minutes.",
    );
  });
  it("the Buttermilk turkey's 'about 3 to 3½ hours (…) for a 12–14 lb bird'", () => {
    assert.equal(
      shortenRoastText("Roast at 325°F until the thickest part of the thigh reads 165°F on an instant-read thermometer, about 3 to 3½ hours (13–15 minutes per pound) for a 12–14 lb bird.", 160),
      "Roast at 325°F for about 2¾ hours.",
    );
  });
});

const DISHES: OvenDish[] = [
  { dishId: "t", title: "Herb-Roasted Whole Turkey", positionIndex: 0, roleLabel: "main" },
  { dishId: "s", title: "Sage Stuffing", positionIndex: 1, roleLabel: "side" },
  { dishId: "c", title: "Cranberry Sauce", positionIndex: 2, roleLabel: "sauce" },
  { dishId: "p", title: "Pumpkin Pie", positionIndex: 3, roleLabel: "side" },
];
const STEPS: OvenStepRow[] = [
  row("t", 0, "prep", 5, "On Thursday: Remove the turkey from the brine and pat it very dry; let it sit at room temperature for 1 hour."),
  row("t", 1, "preheat", 15, "Preheat the oven to 325°F."),
  row("t", 2, "cook", 210, "Roast the turkey at 325°F for 3 to 3½ hours, until an instant-read thermometer in the thickest part of the thigh reads 165°F."),
  row("t", 3, "preheat", 5, "As the turkey comes out, raise the oven to 350°F for the sides."),
  row("t", 4, "rest", 40, "Transfer the turkey to a board and let it rest for 30–45 minutes before carving."),
  row("t", 5, "assemble", 10, "Carve the turkey."),
  row("s", 0, "prep", 10, "Make ahead (Wednesday): Assemble the stuffing."),
  row("s", 1, "preheat", 15, "On Thursday: Preheat the oven to 350°F."),
  row("s", 2, "cook", 55, "Bake the stuffing covered for 30 minutes, then uncover and bake 25 more."),
  row("s", 3, "assemble", 1, "Serve the stuffing directly from the baking dish."),
  row("c", 0, "cook", 15, "Make ahead (Monday): Simmer the cranberries."),
  row("c", 1, "assemble", 2, "On Thursday: Spoon the Cranberry Sauce into a serving bowl straight from the fridge; serve chilled."),
  row("p", 0, "assemble", 5, "On Thursday: Slice the pie and serve with whipped cream."),
];

describe("THX-3d D — the pre-pass", () => {
  const e = thursdayPrePass(DISHES, STEPS);
  it("the sit is a 60-minute hold step after the work", () => {
    assert.deepEqual(e.updates.find((u) => u.dishId === "t" && u.stepIndex === 0), { dishId: "t", stepIndex: 0, text: "On Thursday: Remove the turkey from the brine and pat it very dry.", phaseType: "prep", minutes: 5 });
    assert.deepEqual(e.creates.find((c) => c.dishId === "t"), { dishId: "t", stepIndex: 1, text: "Let the turkey sit at room temperature for 1 hour.", phaseType: "hold", estimatedMinutes: 60 });
  });
  it("the rest is 20–30 minutes (25)", () => {
    assert.deepEqual(e.updates.find((u) => u.dishId === "t" && u.stepIndex === 4), { dishId: "t", stepIndex: 4, text: "Transfer the turkey to a board and let it rest for 20–30 minutes before carving.", minutes: 25 });
  });
  it("THX-3c's old raise step, the serve-only steps and the cranberry's spoon go; the pie's own serve stays", () => {
    assert.deepEqual(e.deletes.map((d) => `${d.dishId}#${d.stepIndex}`).sort(), ["c#1", "s#3", "t#3"]);
    assert.ok(!e.deletes.some((d) => d.dishId === "p"));
  });
});

describe("THX-3d D — the post-pass (after the pre-pass)", () => {
  // The pre-pass applied by hand: the sit split, the rest, the deletes.
  const after: OvenStepRow[] = [
    row("t", 0, "prep", 5, "On Thursday: Remove the turkey from the brine and pat it very dry."),
    row("t", 1, "hold", 60, "Let the turkey sit at room temperature for 1 hour."),
    row("t", 2, "preheat", 15, "Preheat the oven to 325°F."),
    row("t", 3, "cook", 210, "Roast the turkey at 325°F for 3 to 3½ hours, until an instant-read thermometer in the thickest part of the thigh reads 165°F."),
    row("t", 5, "rest", 25, "Transfer the turkey to a board and let it rest for 20–30 minutes before carving."),
    row("t", 6, "assemble", 10, "Carve the turkey."),
    ...STEPS.filter((s) => s.ownerId === "s" && s.stepIndex <= 2),
    STEPS.find((s) => s.ownerId === "c" && s.stepIndex === 0)!,
    STEPS.find((s) => s.ownerId === "p")!,
  ];
  const e = thursdayPostPass(DISHES, after);
  it("one raise while the bird roasts: the side's 55 minutes end 5 before the 25-minute rest does", () => {
    const raise = e.creates.find((c) => c.phaseType === "preheat")!;
    assert.equal(raise.text, "Raise the oven to 350°F and put in the Sage Stuffing.");
    const finish = e.creates.find((c) => c.phaseType === "cook")!;
    assert.equal(finish.estimatedMinutes, 35); // 55 - 25 + 5
    assert.match(finish.text, /^Keep roasting the turkey at 350°F for about 35 more minutes, until an instant-read thermometer in the thickest part of the thigh reads 165°F\.$/);
    assert.deepEqual(e.updates.find((u) => u.dishId === "t" && u.stepIndex === 3), { dishId: "t", stepIndex: 3, text: "Roast the turkey at 325°F for about 2¾ hours.", minutes: 166 });
  });
  it("the side's own preheat goes, its 'On Thursday:' moving to the bake", () => {
    assert.ok(e.deletes.some((d) => d.dishId === "s" && d.stepIndex === 1));
    assert.equal(e.updates.find((u) => u.dishId === "s" && u.stepIndex === 2)?.text, "On Thursday: Bake the stuffing covered for 30 minutes, then uncover and bake 25 more.");
  });
  it("one serve step after the carve names every dish but the dessert", () => {
    const serve = e.creates.find((c) => c.phaseType === "assemble")!;
    assert.equal(serve.text, "Serve the Herb-Roasted Whole Turkey with the Sage Stuffing and Cranberry Sauce.");
    assert.equal(serve.stepIndex, 9); // after the carve, which moved down two
  });
});
