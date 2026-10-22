// THX-3d (D, R4) — Thursday, for every feast: the scheduler half.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { feastServeText, planOven, scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../cookingScheduler";

const st = (stepIndex: number, phaseType: SchedulerPhase, estimatedMinutes: number, text: string) => ({
  stepIndex, phaseType, estimatedMinutes, text, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null,
});
const dish = (dishId: string, title: string, positionIndex: number, steps: ReturnType<typeof st>[]): SchedulerDish => ({ dishId, title, positionIndex, roleLabel: null, steps });

/** Classic's shape after the patch: the raise while the bird roasts, the rest, the carve, the serve. */
const TURKEY = dish("turkey", "Herb-Roasted Whole Turkey", 0, [
  st(0, "preheat", 15, "Preheat the oven to 325°F."),
  st(1, "cook", 166, "Roast the turkey at 325°F for about 2¾ hours."),
  st(2, "preheat", 5, "Raise the oven to 350°F and put in the Sage Stuffing."),
  st(3, "cook", 35, "Keep roasting the turkey at 350°F for about 35 more minutes, until an instant-read thermometer in the thickest part of the thigh reads 165°F."),
  st(4, "rest", 25, "Transfer the turkey to a cutting board and let it rest for 20–30 minutes; reserve the drippings in the roasting pan."),
  st(5, "assemble", 10, "Carve the turkey and arrange on a platter."),
  st(6, "assemble", 2, feastServeText("Herb-Roasted Whole Turkey", ["Pan Gravy", "Sage Stuffing", "Cranberry Sauce"])),
]);
const STUFFING = dish("stuffing", "Sage Stuffing", 1, [st(0, "cook", 55, "On Thursday: Bake the stuffing covered for 30 minutes, then uncover and bake 25 more.")]);
const GRAVY = dish("gravy", "Pan Gravy", 2, [
  st(0, "prep", 4, "On Thursday: Pour the turkey drippings from the roasting pan into a fat separator."),
  st(1, "cook", 12, "Whisk in the stock and simmer until thickened."),
]);
const PIE = dish("pie", "Pumpkin Pie", 3, [st(0, "assemble", 5, "On Thursday: Slice the pie and serve with whipped cream.")]);

const at = (r: ReturnType<typeof scheduleCookingSequence>, dishId: string, stepIndex: number) =>
  r.steps.find((s) => s.dishId === dishId && s.originalStepIndex === stepIndex)!.startOffsetMinutes;

describe("THX-3d R4 — the holder is the roast by kind, never by minutes", () => {
  it("an 85-minute spatchcock holds the oven (THX-3's 90-minute line did not)", () => {
    const bird = dish("t", "Citrus-Herb Spatchcock Turkey", 0, [st(0, "preheat", 15, "Preheat the oven to 425°F."), st(1, "cook", 85, "Roast at 425°F for 80–90 minutes.")]);
    const side = dish("s", "Chipotle-Maple Sweet Potatoes", 1, [st(0, "cook", 35, "Roast at 425°F for 30–35 minutes.")]);
    assert.equal(planOven([bird, side])?.holderDishId, "t");
  });

  it("a bird more than 25°F hotter than a side runs in blocks, the bird's last", () => {
    const bird = dish("t", "Spatchcock Turkey", 0, [st(0, "preheat", 15, "Preheat the oven to 425°F."), st(1, "cook", 85, "Roast at 425°F for 85 minutes."), st(2, "rest", 25, "Rest 20–30 minutes."), st(3, "assemble", 10, "Carve the turkey.")]);
    const side = dish("s", "Cornbread Stuffing", 1, [st(0, "preheat", 15, "Preheat the oven to 350°F."), st(1, "cook", 50, "Bake at 350°F for 50 minutes.")]);
    const gravy = dish("g", "Pan Gravy", 2, [st(0, "cook", 3, "On Thursday: Pour off the drippings from the turkey roasting pan.")]);
    assert.equal(planOven([bird, side, gravy]), null);
    const r = scheduleCookingSequence([bird, side, gravy], { feastOven: true });
    assert.ok(at(r, "s", 1) + 50 <= at(r, "t", 0), "the stuffing bakes before the bird's oven heats to 425°F");
    assert.ok(at(r, "g", 0) >= at(r, "t", 1) + 85, "the gravy works from the drippings once the bird is out");
  });
});

describe("THX-3d R4 — the raise, the rest, the carve, the serve, dessert", () => {
  const r = scheduleCookingSequence([TURKEY, STUFFING, GRAVY, PIE], { feastOven: true });
  it("the side goes in as the raise finishes, while the bird still roasts", () => {
    assert.equal(at(r, "stuffing", 0), at(r, "turkey", 2) + 5);
    assert.ok(at(r, "stuffing", 0) < at(r, "turkey", 3) + 35);
  });
  it("it finishes 5–10 minutes before the bird's 25-minute rest ends", () => {
    const restEnd = at(r, "turkey", 4) + 25;
    const done = at(r, "stuffing", 0) + 55;
    assert.ok(restEnd - done >= 5 && restEnd - done <= 10, `rest ends ${restEnd}, stuffing done ${done}`);
  });
  it("the gravy starts once the bird is out; the carve follows the rest", () => {
    assert.ok(at(r, "gravy", 0) >= at(r, "turkey", 3) + 35);
    assert.equal(at(r, "turkey", 5), at(r, "turkey", 4) + 25);
  });
  it("one serve step, last, at T0; the pie is cut after it", () => {
    assert.equal(at(r, "turkey", 6), -2);
    assert.equal(r.totalEstimatedMinutes > 0, true);
    assert.ok(at(r, "pie", 0) >= 0, "dessert after serve");
    const lastBefore = Math.max(...r.steps.filter((s) => s.dishId !== "pie").map((s) => s.startOffsetMinutes));
    assert.equal(lastBefore, at(r, "turkey", 6));
  });
});

describe("THX-3d R4 — the carve follows the rest even when the stove work is longer", () => {
  it("Small's shape: 30 minutes of hands-on stove work after the bird is out, a 20-minute rest", () => {
    const watched = (stepIndex: number, phaseType: SchedulerPhase, minutes: number, text: string) => ({ ...st(stepIndex, phaseType, minutes, text), isTimingSensitive: true });
    const mash = dish("mash", "Mashed Potatoes", 4, [watched(0, "cook", 10, "On Thursday: Peel and boil the potatoes."), watched(1, "assemble", 15, "Mash with butter and milk; season.")]);
    const gravy = dish("gravy", "Pan Gravy", 2, [watched(0, "prep", 4, "On Thursday: Pour the drippings from the roasting pan into a fat separator."), watched(1, "cook", 12, "Whisk in the stock and simmer.")]);
    const r = scheduleCookingSequence([TURKEY, STUFFING, gravy, mash], { feastOven: true });
    assert.equal(at(r, "turkey", 5), at(r, "turkey", 4) + 25, "carved as the rest ends");
  });
});

describe("THX-3d R4 — merged preheats are named for the client", () => {
  it("a feast's duplicate pure preheat is in mergedSteps (and so not appended after serve)", () => {
    const a = dish("a", "Herb Stuffing", 0, [st(0, "preheat", 15, "On Thursday: Preheat the oven to 375°F. Mix the panko."), st(1, "cook", 45, "Bake at 375°F for 45 minutes.")]);
    const b = dish("b", "Mac and Cheese", 1, [st(0, "preheat", 15, "On Thursday: Preheat the oven to 375°F."), st(1, "cook", 35, "Bake at 375°F for 35 minutes.")]);
    const r = scheduleCookingSequence([a, b], { feastOven: true });
    assert.deepEqual(r.mergedSteps, [{ dishId: "b", stepIndex: 0 }]);
    assert.equal(scheduleCookingSequence([a, b]).mergedSteps, undefined);
  });
});

describe("THX-3d round 2 (I) — what a side needs before it goes in, and an oven heated for it", () => {
  it("Classic's pecan topping is scattered before the raise that puts the casserole in, never during it", () => {
    const sweet = dish("sweet", "Sweet Potato Casserole", 3, [
      st(0, "prep", 3, "On Thursday: Remove the casserole from the fridge and scatter the pecan topping evenly over the surface."),
      st(1, "cook", 40, "The sweet potato casserole is in at 350°F, uncovered. Bake 35–40 minutes."),
    ]);
    const turkey = { ...TURKEY, steps: TURKEY.steps.map((s) => (s.stepIndex === 2 ? { ...s, text: "Raise the oven to 350°F and put in the Sage Stuffing and Sweet Potato Casserole." } : s)) };
    const r = scheduleCookingSequence([turkey, STUFFING, GRAVY, sweet], { feastOven: true });
    assert.ok(at(r, "sweet", 0) + 3 <= at(r, "turkey", 2), `topping ${at(r, "sweet", 0)}+3, raise ${at(r, "turkey", 2)}`);
    assert.equal(at(r, "sweet", 1), at(r, "turkey", 2) + 5, "in as the raise finishes");
  });
  it("New Twist: the stuffing has no preheat of its own; it waits for the potatoes' 350°F preheat", () => {
    const bird = dish("t", "Spatchcock Turkey", 0, [st(0, "preheat", 15, "Preheat the oven to 425°F."), st(1, "cook", 85, "Roast at 425°F for 85 minutes."), st(2, "rest", 25, "Rest 20–30 minutes."), st(3, "assemble", 10, "Carve the turkey.")]);
    const stuffing = dish("s", "Cornbread and Chorizo Stuffing", 1, [st(0, "cook", 30, "On Thursday: Bake the stuffing (still covered in foil) in a 350°F oven for 30 minutes.")]);
    const potatoes = dish("p", "Smashed Potatoes", 2, [st(0, "cook", 20, "Boil the potatoes 20 minutes."), st(1, "preheat", 15, "Preheat the oven to 350°F and line two rimmed sheet pans with parchment."), st(2, "cook", 20, "Roast at 350°F for 20 minutes.")]);
    const r = scheduleCookingSequence([bird, stuffing, potatoes], { feastOven: true });
    assert.ok(at(r, "s", 0) >= at(r, "p", 1) + 15, `stuffing in at ${at(r, "s", 0)}, the oven hot at ${at(r, "p", 1) + 15}`);
  });
});
