// THX-3 item B (BUG-449) — a feast's oven frees when the bird comes out.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isOvenStep, planOven, scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../cookingScheduler";

const st = (stepIndex: number, phaseType: SchedulerPhase, estimatedMinutes: number, text: string, isTimingSensitive = false) => ({
  stepIndex, phaseType, estimatedMinutes, text, isTimingSensitive,
});
const dish = (dishId: string, positionIndex: number, steps: ReturnType<typeof st>[]): SchedulerDish => ({ dishId, title: dishId, positionIndex, steps });

// Classic's Thursday, as dev holds it (minutes and phases verbatim).
const TURKEY = dish("turkey", 0, [
  st(5, "prep", 5, "On Thursday: Remove the turkey from the brine and pat it very dry."),
  st(6, "preheat", 15, "Preheat the oven to 325°F."),
  st(7, "prep", 5, "Loosen the skin and rub the herb butter onto the meat."),
  st(8, "prep", 4, "Stuff the cavity and tie the legs."),
  st(9, "cook", 210, "Place the turkey on a rack in a large roasting pan and roast at 325°F for 3 to 3½ hours."),
  st(10, "rest", 40, "Transfer the turkey to a cutting board and let it rest; reserve the drippings in the roasting pan for the gravy."),
  st(11, "assemble", 10, "Carve the turkey and arrange on a large platter."),
]);
const GRAVY = dish("gravy", 1, [
  st(4, "prep", 4, "On Thursday: Pour the turkey drippings from the roasting pan into a fat separator."),
  st(5, "cook", 3, "Set the roasting pan over two burners on medium-high and whisk in the flour.", true),
  st(6, "cook", 12, "Gradually whisk in the stock and simmer until thickened."),
  st(7, "assemble", 2, "Season and pour into a warmed gravy boat."),
]);
const STUFFING = dish("stuffing", 2, [
  st(9, "cook", 55, "On Thursday: Preheat the oven to 350°F; bake the stuffing covered for 30 minutes, then uncover and bake 20–25 minutes more."),
  st(10, "assemble", 2, "Serve the stuffing directly from the 9×13-inch baking dish."),
]);
const MASH = dish("mash", 3, [
  st(0, "cook", 3, "On Thursday: Place the potatoes in a large pot and cover with cold water."),
  st(1, "cook", 22, "Bring to a boil and cook until tender."),
  st(2, "cook", 2, "Drain the potatoes.", true),
  st(3, "cook", 5, "Mash with the butter and milk."),
  st(4, "assemble", 2, "Season and transfer to a warmed bowl."),
]);
const FEAST = [TURKEY, GRAVY, STUFFING, MASH];

const window = (r: ReturnType<typeof scheduleCookingSequence>, dishId: string, stepIndex: number) => {
  const s = r.steps.find((x) => x.dishId === dishId && x.originalStepIndex === stepIndex)!;
  const d = FEAST.find((x) => x.dishId === dishId)!.steps.find((x) => x.stepIndex === stepIndex)!;
  return { start: s.startOffsetMinutes, end: s.startOffsetMinutes + d.estimatedMinutes };
};

describe("THX-3 B — which steps use the oven", () => {
  it("roast at, bake, preheat the oven — yes; a roasting pan on burners, a baking dish to serve from, a rest — no", () => {
    assert.equal(isOvenStep(TURKEY.steps[4]), true);
    assert.equal(isOvenStep(TURKEY.steps[1]), true);
    assert.equal(isOvenStep(STUFFING.steps[0]), true);
    assert.equal(isOvenStep(GRAVY.steps[1]), false);
    assert.equal(isOvenStep(GRAVY.steps[0]), false);
    assert.equal(isOvenStep(STUFFING.steps[1]), false);
    assert.equal(isOvenStep(TURKEY.steps[5]), false);
  });

  it("the holder is the long roast; a feast without one has no oven plan", () => {
    assert.equal(planOven(FEAST)?.holderDishId, "turkey");
    assert.equal(planOven([STUFFING, MASH]), null);
  });
});

describe("THX-3 B — the oven frees when the bird comes out", () => {
  const before = scheduleCookingSequence(FEAST);
  const after = scheduleCookingSequence(FEAST, { feastOven: true });

  it("before: the stuffing went in at 350°F while the bird was still roasting (the measured defect)", () => {
    assert.ok(window(before, "stuffing", 9).start < window(before, "turkey", 9).end);
  });

  it("after: no other dish is in the oven before the roast is out", () => {
    const out = window(after, "turkey", 9).end;
    assert.ok(window(after, "stuffing", 9).start >= out, `${window(after, "stuffing", 9).start} < ${out}`);
  });

  // THX-3d (R4) — the carve no longer waits to land at serve (the bird rested longer):
  // it follows the rest at once, and what the stove still owes is done after it.
  it("the rest follows the roast at once, the carve follows the rest, and nothing hot finishes early", () => {
    assert.ok(window(after, "turkey", 10).start - window(after, "turkey", 9).end <= 2);
    assert.equal(window(after, "turkey", 11).start, window(after, "turkey", 10).end, `carve starts ${window(after, "turkey", 11).start}`);
    // The single cook's hands already set the gravy and the stuffing's serve step a
    // few minutes ahead of the carve; the oven rule makes neither earlier.
    for (const [d, i] of [["gravy", 7], ["mash", 4], ["stuffing", 10]] as const) {
      assert.ok(window(after, d, i).end >= window(before, d, i).end, `${d} ends ${window(after, d, i).end} (was ${window(before, d, i).end})`);
    }
  });

  it("the stuffing goes in the moment the oven frees — during the rest", () => {
    assert.equal(window(after, "stuffing", 9).start, window(after, "turkey", 9).end);
  });

  it("the pan sauce still comes after the drippings exist", () => {
    assert.ok(window(after, "gravy", 4).start >= window(after, "turkey", 9).end);
  });

  it("it costs the sides' time after the roast, and no more", () => {
    // Out of the oven, the stuffing still needs 55 + 2; the bird's tail is 40 + 10.
    // THX-3d (R4) — with the stove work finishing as the carve starts (not around it),
    // and the carve right after the rest, the feast is 298 minutes beside the plain
    // schedule's 303 (THX-3 measured +7).
    assert.ok(after.totalEstimatedMinutes <= before.totalEstimatedMinutes + 7, `${before.totalEstimatedMinutes} → ${after.totalEstimatedMinutes}`);
    assert.equal(after.totalEstimatedMinutes, 298);
  });

  it("a served-cold dish pulled forward into the roast's window still waits for the oven", () => {
    // The cold-dish rule moves a bars-and-pie dish into the earliest passive window
    // (the roast itself); its bake must not go into a 325°F oven holding the bird.
    const BARS = dish("bars", 4, [
      st(0, "cook", 30, "Bake the bars at 350°F until set."),
      st(1, "rest", 60, "Cool the bars completely, then cut into squares."),
    ]);
    const ovenOut = (r: ReturnType<typeof scheduleCookingSequence>) => {
      const s = r.steps.find((x) => x.dishId === "turkey" && x.originalStepIndex === 9)!;
      return s.startOffsetMinutes + 210;
    };
    const r = scheduleCookingSequence([...FEAST, BARS], { feastOven: true });
    const bake = r.steps.find((x) => x.dishId === "bars" && x.originalStepIndex === 0)!;
    assert.ok(bake.startOffsetMinutes >= ovenOut(r), `bars bake at ${bake.startOffsetMinutes}, oven frees at ${ovenOut(r)}`);
  });

  it("without the option, and for a feast with no long roast, the schedule is unchanged", () => {
    assert.deepEqual(scheduleCookingSequence(FEAST, {}), before);
    assert.deepEqual(scheduleCookingSequence([STUFFING, MASH, GRAVY], { feastOven: true }), scheduleCookingSequence([STUFFING, MASH, GRAVY]));
  });
});
