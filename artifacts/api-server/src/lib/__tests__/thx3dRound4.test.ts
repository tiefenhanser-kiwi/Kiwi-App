// THX-3d round 4 — the scheduler half: two racks (BUG-496).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dishRacks,
  feastRoastDish,
  OVEN_RACKS,
  ovenStays,
  placeInRacks,
  racksInUse,
  scheduleCookingSequence,
  type SchedulerDish,
  type SchedulerPhase,
} from "../cookingScheduler";
import { dishOvenRacks, ovenVesselOf, roastedPounds, sheetPanCount, withSheetPanCount } from "../ovenRacks";

const st = (stepIndex: number, phaseType: SchedulerPhase, estimatedMinutes: number, text: string) => ({
  stepIndex, phaseType, estimatedMinutes, text, isTimingSensitive: false, parallelGroup: null as string | null, componentKey: null, pathKey: null,
});
const dish = (dishId: string, title: string, positionIndex: number, steps: ReturnType<typeof st>[], ovenRacks?: number): SchedulerDish => ({ dishId, title, positionIndex, roleLabel: null, steps, ...(ovenRacks !== undefined ? { ovenRacks } : {}) });

/** The most racks in use at any minute of a feast's schedule. */
function maxRacks(r: ReturnType<typeof scheduleCookingSequence>, dishes: SchedulerDish[]): number {
  const at = new Map(r.steps.map((s) => [`${s.dishId}#${s.originalStepIndex}`, s.startOffsetMinutes]));
  const bird = feastRoastDish(dishes);
  const uses = dishes.flatMap((d) => ovenStays(d, d.dishId === bird?.dishId ? bird : null).map((s) => {
    const placed = d.steps.slice(s.from, s.to + 1).filter((x) => at.has(`${d.dishId}#${x.stepIndex}`));
    return { from: Math.min(...placed.map((x) => at.get(`${d.dishId}#${x.stepIndex}`)!)), to: Math.max(...placed.map((x) => at.get(`${d.dishId}#${x.stepIndex}`)! + x.estimatedMinutes)), racks: dishRacks(d, d.dishId === bird?.dishId) };
  }));
  const lo = Math.min(...uses.map((u) => u.from));
  const hi = Math.max(...uses.map((u) => u.to));
  let max = 0;
  for (let t = lo; t < hi; t++) max = Math.max(max, uses.filter((u) => u.from <= t && t < u.to).reduce((n, u) => n + u.racks, 0));
  return max;
}
const at = (r: ReturnType<typeof scheduleCookingSequence>, dishId: string, stepIndex: number) =>
  r.steps.find((s) => s.dishId === dishId && s.originalStepIndex === stepIndex)!.startOffsetMinutes;

describe("THX-3d round 4 (A1) — what a dish takes up in the oven", () => {
  it("the vessel its steps name last before the oven, and how many", () => {
    assert.deepEqual(ovenVesselOf(["Make ahead (Wednesday): cut the bread and spread on two rimmed sheet pans to dry.", "Make ahead (Wednesday): transfer to a buttered 9×13-inch baking dish, cover tightly with foil."]), { vessel: "dish", named: 1 });
    assert.deepEqual(ovenVesselOf(["Brush two large rimmed sheet pans with oil.", "Spread the drained potatoes across the two oiled sheet pans; smash each one."]), { vessel: "sheet", named: 2 });
    assert.deepEqual(ovenVesselOf(["Whisk the eggs."]), { vessel: "unknown", named: 1 });
  });

  it("a 1¼ lb sheet-pan dish takes one pan; a 5 lb one three — the pounds, never the recipe's 'two'", () => {
    const texts = ["Spread the sprouts in a single layer across two large rimmed sheet pans."];
    assert.deepEqual(dishOvenRacks(texts, [{ quantity: 3, unit: "pound" }], 1.25 / 3), { vessel: "sheet", count: 1, racks: 1 });
    assert.deepEqual(dishOvenRacks(texts, [{ quantity: 5, unit: "pound" }], 1), { vessel: "sheet", count: 3, racks: 3 });
    assert.equal(sheetPanCount(4), 2);
    assert.equal(roastedPounds([{ quantity: 4, unit: "pound" }, { quantity: 3, unit: "ounce" }]), 4, "the cheese is not what the pan roasts");
  });

  it("a 9×13 is half a rack, scaled by the servings; an unknown vessel half", () => {
    assert.deepEqual(dishOvenRacks(["Transfer to a buttered 9×13-inch baking dish."], [], 0.4), { vessel: "dish", count: 1, racks: 0.5 });
    assert.deepEqual(dishOvenRacks(["Transfer to a buttered 9×13-inch baking dish."], [], 2), { vessel: "dish", count: 2, racks: 1 });
    assert.deepEqual(dishOvenRacks(["Bake until set."], [], 1), { vessel: "unknown", count: 1, racks: 0.5 });
  });

  it("the text's count corrected to the pounds' (patch time)", () => {
    assert.equal(withSheetPanCount("Line two rimmed sheet pans with parchment.", 1), "Line a rimmed sheet pan with parchment.");
    assert.equal(withSheetPanCount("Spread the sprouts across two large rimmed sheet pans.", 3), "Spread the sprouts across three large rimmed sheet pans.");
    assert.equal(withSheetPanCount("Spread the potatoes across the two oiled sheet pans.", 1), "Spread the potatoes across the oiled sheet pan.");
    assert.equal(withSheetPanCount("Spread across two rimmed sheet pans.", 2), null, "already right");
  });
});

describe("THX-3d round 4 (A2) — two racks, at planning time and in the pass", () => {
  it("placeInRacks: each in turn at the earliest moment it fits", () => {
    const bird = [{ from: -Infinity, to: 0, racks: 1 }];
    const t = placeInRacks([{ id: "a", racks: 0.5, minutes: 30, earliest: -40 }, { id: "b", racks: 0.5, minutes: 30, earliest: -40 }, { id: "c", racks: 1, minutes: 20, earliest: -40 }], bird);
    // Beside the bird one rack is free: the two 9×13s share it, the sheet pan waits for them.
    assert.deepEqual([t.get("a"), t.get("b"), t.get("c")], [-40, -40, -10]);
    assert.equal(racksInUse([...bird, { from: -40, to: -10, racks: 0.5 }], -20, -5), 1.5);
  });

  // Classic's shape: the bird and three 9×13s, the raise naming two of them.
  const TURKEY = dish("t", "Herb-Roasted Whole Turkey", 0, [
    st(0, "preheat", 15, "Preheat the oven to 325°F."),
    st(1, "cook", 160, "Roast the turkey at 325°F for about 2¾ hours."),
    st(2, "preheat", 5, "Raise the oven to 350°F and put in the Sage Stuffing and Green Bean Casserole."),
    st(3, "cook", 25, "Keep roasting the turkey at 350°F for about 25 more minutes, until an instant-read thermometer in the thickest part of the thigh reads 165°F."),
    st(4, "rest", 25, "Transfer the turkey to a carving board and rest 20–30 minutes."),
    st(5, "assemble", 10, "Carve the turkey and arrange on a large platter."),
  ]);
  const STUFFING = dish("s", "Sage Stuffing", 1, [st(0, "cook", 30, "On Thursday: The stuffing is in at 350°F, covered. Bake 30 minutes."), st(1, "cook", 15, "Uncover and bake 15 minutes more.")], 0.5);
  const BEANS = dish("g", "Green Bean Casserole", 2, [st(0, "cook", 25, "On Thursday: The green bean casserole is in at 350°F, covered. Bake 25 minutes."), st(1, "cook", 10, "Uncover and bake 10 minutes more.")], 0.5);
  const SWEET = dish("p", "Sweet Potato Casserole", 3, [st(0, "prep", 1, "On Thursday: Put the sweet potato casserole in the oven."), st(1, "cook", 20, "The sweet potato casserole is in at 350°F, covered. Bake 20 minutes."), st(2, "cook", 10, "Uncover and bake 10 minutes more.")], 0.5);

  it("the bird and three 9×13s: the third waits for the bird to come out", () => {
    const ds = [TURKEY, STUFFING, BEANS, SWEET];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.ok(maxRacks(r, ds) <= OVEN_RACKS, `racks ${maxRacks(r, ds)}`);
    assert.ok(at(r, "p", 0) >= at(r, "t", 3) + 25, `the sweet potato casserole goes in at ${at(r, "p", 0)}, the bird is out at ${at(r, "t", 3) + 25}`);
    assert.equal(at(r, "s", 0), at(r, "t", 2) + 5, "the raise's sides go in as it finishes");
  });

  it("a side the raise says waits goes in as the bird comes out — not finish-aligned to later", () => {
    const raise = { ...TURKEY, steps: TURKEY.steps.map((s) => (s.stepIndex === 2 ? { ...s, text: "Raise the oven to 350°F and put in the Sage Stuffing and Green Bean Casserole; the Sweet Potato Casserole goes in when the turkey comes out." } : s)) };
    const short = { ...SWEET, steps: [SWEET.steps[0], { ...SWEET.steps[1], estimatedMinutes: 10 }, { ...SWEET.steps[2], estimatedMinutes: 5 }] };
    const ds = [raise, STUFFING, BEANS, short];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.equal(at(r, "p", 0), at(r, "t", 3) + 25);
    assert.equal(at(r, "s", 0), at(r, "t", 2) + 5, "the clause's dish is not one the raise puts in");
  });

  it("a side that waits for room does its last work as it goes in: the boiled potatoes are smashed then (C6)", () => {
    const raise = { ...TURKEY, steps: TURKEY.steps.map((s) => (s.stepIndex === 2 ? { ...s, text: "Raise the oven to 350°F and put in the Sage Stuffing and Green Bean Casserole." } : s)) };
    const pot = dish("k", "Smashed Potatoes", 4, [
      st(0, "cook", 20, "On Thursday: Boil the potatoes 18–20 minutes until tender; drain."),
      st(1, "prep", 5, "Spread the potatoes on a rimmed sheet pan and smash each one."),
      st(2, "prep", 1, "Put the potatoes in the oven."),
      st(3, "cook", 30, "The potatoes are in at 350°F. Roast 30 minutes."),
    ], 1);
    const ds = [raise, STUFFING, BEANS, pot];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.ok(maxRacks(r, ds) <= OVEN_RACKS);
    assert.ok(at(r, "k", 2) >= at(r, "t", 3) + 25, "no room beside the bird and the two 9×13s");
    assert.ok(at(r, "k", 2) - (at(r, "k", 1) + 5) <= 2, `smashed at ${at(r, "k", 1)}, in at ${at(r, "k", 2)}`);
    assert.ok(at(r, "k", 1) - (at(r, "k", 0) + 20) <= 2, `boiled until ${at(r, "k", 0) + 20}, smashed at ${at(r, "k", 1)}`);
  });

  it("block mode: two sheet pans of sprouts do not go in beside the Wellington's pan", () => {
    const well = dish("w", "Mushroom Wellington", 0, [st(0, "prep", 20, "Fill and fold the pastry."), st(1, "preheat", 15, "Preheat the oven to 425°F."), st(2, "cook", 30, "Bake on the sheet pan at 425°F for 25–30 minutes.")], 1);
    const sprouts = dish("b", "Balsamic Roasted Brussels Sprouts", 1, [st(0, "prep", 10, "Toss the sprouts and spread across two large rimmed sheet pans."), st(1, "cook", 25, "Roast at 425°F for 22–25 minutes.")], 2);
    const mac = dish("m", "Baked Mac and Cheese", 2, [st(0, "preheat", 15, "On Thursday: Preheat the oven to 375°F."), st(1, "cook", 45, "Bake uncovered at 375°F for 45 minutes."), st(2, "assemble", 1, "Cover the Baked Mac and Cheese with foil to keep it warm while the oven heats for the next dish."), st(3, "cook", 10, "Return the Baked Mac and Cheese, uncovered, to the 425°F oven for 10 minutes, until hot again.")], 0.5);
    const ds = [well, sprouts, mac];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.ok(maxRacks(r, ds) <= OVEN_RACKS, `racks ${maxRacks(r, ds)}`);
    const wellEnd = at(r, "w", 2) + 30;
    const sproutsIn = at(r, "b", 1);
    assert.ok(sproutsIn >= wellEnd || at(r, "w", 2) >= sproutsIn + 25, "one after the other");
  });

  it("C2 — the turned-off oven is the side's rest: 'Let the stuffing rest 5 minutes' goes with a kept oven-off", () => {
    const stuffing = dish("s", "Sage Stuffing", 1, [
      st(0, "cook", 30, "On Thursday: The stuffing is in at 350°F, covered. Bake 30 minutes."),
      st(1, "cook", 15, "Uncover and bake 15 minutes more."),
      st(2, "assemble", 1, "Turn the oven off and leave the sides inside, covered loosely with foil, to keep warm."),
      st(3, "assemble", 5, "Let the stuffing rest 5 minutes."),
    ], 0.5);
    const gravy = dish("v", "Pan Gravy", 2, [st(0, "prep", 5, "On Thursday: Pour the drippings from the roasting pan into a fat separator."), { ...st(1, "cook", 30, "Whisk in the stock and simmer, whisking often."), isTimingSensitive: true }]);
    const r = scheduleCookingSequence([TURKEY, stuffing, gravy], { feastOven: true });
    assert.ok(r.steps.some((s) => s.dishId === "s" && s.originalStepIndex === 2), "the oven-off is kept");
    assert.deepEqual(r.mergedSteps?.filter((m) => m.dishId === "s"), [{ dishId: "s", stepIndex: 3 }]);
  });

  it("C3 — the oven goes off as the last side's bake ends, while the gravy holds the cook's hands", () => {
    const raise = { ...TURKEY, steps: TURKEY.steps.map((s) => (s.stepIndex === 2 ? { ...s, text: "Raise the oven to 350°F and put in the Sage Stuffing." } : s)) };
    const stuffing = dish("s", "Sage Stuffing", 1, [...(STUFFING.steps as ReturnType<typeof st>[]), st(2, "assemble", 1, "Turn the oven off and leave the sides inside, covered loosely with foil, to keep warm.")], 0.5);
    const watched = (stepIndex: number, phaseType: SchedulerPhase, minutes: number, text: string) => ({ ...st(stepIndex, phaseType, minutes, text), isTimingSensitive: true });
    const gravy = dish("v", "Pan Gravy", 2, [watched(0, "prep", 5, "On Thursday: Pour the drippings from the roasting pan into a fat separator."), watched(1, "cook", 4, "Whisk in the flour."), watched(2, "cook", 25, "Whisk in the stock and simmer, whisking often."), st(3, "assemble", 2, "Pour into a warm gravy boat.")]);
    const mash = dish("m", "Mashed Potatoes", 3, [st(0, "cook", 25, "On Thursday: Boil the potatoes until tender."), watched(1, "assemble", 20, "Rice, then mash with the butter and milk; season."), st(2, "assemble", 2, "Transfer to a warm bowl.")]);
    const r = scheduleCookingSequence([raise, stuffing, gravy, mash], { feastOven: true });
    const off = at(r, "s", 2);
    assert.equal(off, at(r, "s", 1) + 15, "right after the bake");
    assert.ok(r.steps.some((s) => s.dishId === "v" && s.startOffsetMinutes < off && off < s.startOffsetMinutes + gravy.steps.find((x) => x.stepIndex === s.originalStepIndex)!.estimatedMinutes), "fixture: the gravy's whisking holds the hands then");
  });

  it("C5 — the preheat riding the bird's sit heats the oven as the sit ends", () => {
    const sat = dish("t", "Dry-Brined Roast Turkey", 0, [
      { ...st(0, "hold", 60, "On Thursday: Remove the turkey from the fridge 1 hour before roasting."), parallelGroup: "sit" },
      { ...st(1, "preheat", 30, "Preheat the oven to 325°F."), parallelGroup: "sit" },
      { ...st(2, "prep", 5, "Rub the butter under the skin."), parallelGroup: "sit" },
      st(3, "cook", 150, "Roast the turkey at 325°F for about 2½ hours."),
      st(4, "rest", 25, "Rest 20–30 minutes."),
      st(5, "assemble", 10, "Carve the turkey."),
    ]);
    const r = scheduleCookingSequence([sat], { feastOven: true });
    assert.equal(at(r, "t", 1) + 30, at(r, "t", 0) + 60, "the preheat ends as the sit does");
    assert.equal(at(r, "t", 3), at(r, "t", 0) + 60, "the roast starts then");
  });

  it("C7 — the carve lands within 10 minutes of serving; each dish's steps keep their order", () => {
    const watched = (stepIndex: number, phaseType: SchedulerPhase, minutes: number, text: string) => ({ ...st(stepIndex, phaseType, minutes, text), isTimingSensitive: true });
    // Small's shape: 30 minutes of hands-on stove work after the bird is out, a 20-minute rest.
    const gravy = dish("v", "Pan Gravy", 2, [watched(0, "prep", 4, "On Thursday: Pour the drippings from the roasting pan into a fat separator."), watched(1, "cook", 12, "Whisk in the stock and simmer.")]);
    const mash = dish("m", "Mashed Potatoes", 3, [watched(0, "cook", 10, "On Thursday: Peel and boil the potatoes."), watched(1, "assemble", 15, "Mash with butter and milk; season.")]);
    const serve = { ...TURKEY, steps: [...TURKEY.steps.map((s) => (s.phaseType === "rest" ? { ...s, estimatedMinutes: 20 } : s)), st(6, "assemble", 2, "Serve the Herb-Roasted Whole Turkey with the Pan Gravy, Sage Stuffing and Mashed Potatoes.")] };
    const ds = [serve, STUFFING, gravy, mash];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.ok(at(r, "t", 5) >= at(r, "t", 4) + 20);
    assert.ok(at(r, "t", 6) - (at(r, "t", 5) + 10) <= 10, `carved ${at(r, "t", 5)}, served ${at(r, "t", 6)}`);
    for (const d of ds) for (let i = 1; i < d.steps.length; i++) {
      const a = r.steps.find((s) => s.dishId === d.dishId && s.originalStepIndex === d.steps[i - 1].stepIndex);
      const b = r.steps.find((s) => s.dishId === d.dishId && s.originalStepIndex === d.steps[i].stepIndex);
      if (a && b) assert.ok(b.startOffsetMinutes >= a.startOffsetMinutes + d.steps[i - 1].estimatedMinutes, `${d.dishId} #${i} starts before #${i - 1} ends`);
    }
  });

  it("without racks (every weeknight) nothing changes", () => {
    const weeknight = [dish("a", "Sheet Pan Chicken", 0, [st(0, "preheat", 15, "Preheat the oven to 425°F."), st(1, "cook", 30, "Roast at 425°F for 30 minutes.")], 1), dish("b", "Roasted Carrots", 1, [st(0, "cook", 25, "Roast at 425°F for 25 minutes.")], 2)];
    const r = scheduleCookingSequence(weeknight);
    assert.deepEqual([at(r, "a", 1) + 30, at(r, "b", 0) + 25], [0, 0], "both finish-aligned as always: no racks outside a feast");
  });
});
