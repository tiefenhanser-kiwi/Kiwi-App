// THX-3d round 5 — the scheduler half of D-WS9-322: hold the forgiving thing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dishRacks, feastRoastDish, OVEN_RACKS, ovenStays, scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../cookingScheduler";

const st = (stepIndex: number, phaseType: SchedulerPhase, estimatedMinutes: number, text: string) => ({
  stepIndex, phaseType, estimatedMinutes, text, isTimingSensitive: false, parallelGroup: null as string | null, componentKey: null, pathKey: null,
});
const dish = (dishId: string, title: string, positionIndex: number, steps: ReturnType<typeof st>[], ovenRacks?: number, ovenVessel?: "sheet" | "dish", roleLabel: string | null = null): SchedulerDish => ({ dishId, title, positionIndex, roleLabel, steps, ...(ovenRacks !== undefined ? { ovenRacks, ovenVessel } : {}) });
const at = (r: ReturnType<typeof scheduleCookingSequence>, dishId: string, stepIndex: number) => r.steps.find((s) => s.dishId === dishId && s.originalStepIndex === stepIndex)?.startOffsetMinutes;

function maxRacks(r: ReturnType<typeof scheduleCookingSequence>, dishes: SchedulerDish[]): number {
  const on = new Map(r.steps.map((s) => [`${s.dishId}#${s.originalStepIndex}`, s.startOffsetMinutes]));
  const bird = feastRoastDish(dishes);
  const uses = dishes.flatMap((d) => ovenStays(d, d.dishId === bird?.dishId ? bird : null).flatMap((s) => {
    const placed = d.steps.slice(s.from, s.to + 1).filter((x) => on.has(`${d.dishId}#${x.stepIndex}`));
    if (placed.length === 0) return [];
    return [{ from: Math.min(...placed.map((x) => on.get(`${d.dishId}#${x.stepIndex}`)!)), to: Math.max(...placed.map((x) => on.get(`${d.dishId}#${x.stepIndex}`)! + x.estimatedMinutes)), racks: dishRacks(d, d.dishId === bird?.dishId) }];
  }));
  let max = 0;
  for (let t = Math.min(...uses.map((u) => u.from)); t < Math.max(...uses.map((u) => u.to)); t++) max = Math.max(max, uses.filter((u) => u.from <= t && t < u.to).reduce((n, u) => n + u.racks, 0));
  return max;
}

// New Twist's shape at its own 10 servings: a spatchcock at 400°F, the stuffing done as it
// comes out, two pans of smashed potatoes in then, two pans of sweet potatoes held.
const BIRD = dish("t", "Citrus-Herb Spatchcock Turkey", 0, [
  st(0, "preheat", 20, "On Thursday: Preheat the oven to 400°F."),
  st(1, "prep", 6, "Work the compound butter under the skin."),
  st(2, "cook", 60, "Set the turkey on the sheet pan and roast at 400°F for about 1 hour."),
  st(3, "prep", 2, "Put the Cornbread Stuffing in the oven with the turkey; the Smashed Potatoes go in when the turkey comes out."),
  st(4, "cook", 42, "Keep roasting the turkey at 400°F for about 40 more minutes, until an instant-read thermometer in the thickest part of the thigh reads 165°F."),
  st(5, "rest", 25, "Rest the turkey on the sheet pan for 20–30 minutes before carving."),
  st(6, "assemble", 10, "Carve the turkey and arrange on a warm platter."),
  st(7, "assemble", 2, "Serve the Citrus-Herb Spatchcock Turkey with the Cornbread Stuffing, Smashed Potatoes and Sweet Potatoes."),
]);
const STUFFING = dish("s", "Cornbread Stuffing", 1, [
  st(0, "cook", 30, "On Thursday: The stuffing is in at 400°F, covered. Bake 30 minutes."),
  st(1, "cook", 12, "Uncover and bake 10–12 more minutes."),
  st(2, "assemble", 1, "Cover the Cornbread Stuffing with foil to keep it warm."),
  st(3, "cook", 10, "Return the Cornbread Stuffing, uncovered, to the 400°F oven for 10 minutes, until hot again."),
], 0.5, "dish");
const smashed = (racks: number) => dish("k", "Smashed Potatoes", 2, [
  st(0, "prep", 1, "On Thursday: Put the potatoes in the oven now that the turkey is out."),
  st(1, "cook", 35, "The potatoes are in at 400°F. Roast 30–35 minutes."),
], racks, "sheet");
const sweets = (racks: number) => dish("v", "Sweet Potatoes", 3, [
  st(0, "prep", 2, "On Thursday: Spread the sweet potatoes across two rimmed sheet pans."),
  st(1, "prep", 1, "Put the sweet potatoes in the oven."),
  st(2, "cook", 40, "The sweet potatoes are in at 400°F. Roast 35–40 minutes."),
  st(3, "assemble", 1, "Cover the Sweet Potatoes with foil to keep them warm."),
  st(4, "cook", 10, "Return the Sweet Potatoes, uncovered, to the 400°F oven for 10 minutes, until hot again."),
], racks, "sheet");

describe("THX-3d round 5 (D-WS9-322 (2)) — what does not fit the rest window bakes before the bird", () => {
  it("two pans of sweet potatoes beside two of smashed: before the bird, held, reheated as it rests", () => {
    const ds = [BIRD, STUFFING, smashed(2), sweets(2)];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.ok(maxRacks(r, ds) <= OVEN_RACKS, `racks ${maxRacks(r, ds)}`);
    assert.ok(at(r, "v", 2)! + 40 <= at(r, "t", 2)!, `sweet potatoes out ${at(r, "v", 2)! + 40}, bird in ${at(r, "t", 2)}`);
    assert.ok(at(r, "t", 0)! + 20 <= at(r, "v", 2)!, "into a hot oven");
    assert.ok(at(r, "v", 4)! >= at(r, "t", 4)! + 42, "reheated once the bird is out");
    const out = at(r, "t", 4)! + 42;
    assert.ok(at(r, "k", 0)! >= out && at(r, "k", 0)! - out <= 2, `the smashed potatoes keep the rest window: in at ${at(r, "k", 0)}, the bird out at ${out} (the stuffing is covered first)`);
  });

  it("a household's single pans fit together: the hold and reheat are merged away, in as the bird comes out", () => {
    const ds = [BIRD, STUFFING, smashed(1), sweets(1)];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.ok(maxRacks(r, ds) <= OVEN_RACKS);
    assert.equal(at(r, "v", 3), undefined);
    assert.equal(at(r, "v", 4), undefined);
    assert.deepEqual(r.mergedSteps?.filter((m) => m.dishId === "v"), [{ dishId: "v", stepIndex: 3 }, { dishId: "v", stepIndex: 4 }]);
    assert.ok(at(r, "v", 1)! >= at(r, "t", 4)! + 42, "after the bird");
  });
});

describe("THX-3d round 5 (D-WS9-322 (1)) — the carved bird waits no more than 10 minutes", () => {
  it("in both shapes above, with no tent needed", () => {
    for (const racks of [2, 1]) {
      const r = scheduleCookingSequence([BIRD, STUFFING, smashed(racks), sweets(racks)], { feastOven: true });
      assert.ok(at(r, "t", 7)! - (at(r, "t", 6)! + 10) <= 10, `${racks} rack(s): carved ${at(r, "t", 6)}, served ${at(r, "t", 7)}`);
    }
  });
});

describe("THX-3d round 5 (D-WS9-322 (3)) — the main dish finishes last among the oven dishes", () => {
  const well = dish("w", "Mushroom Wellington", 0, [st(0, "assemble", 20, "Fill and fold the pastry."), st(1, "preheat", 15, "Preheat the oven to 425°F."), st(2, "cook", 30, "Bake on the sheet pan at 425°F for 25–30 minutes."), st(3, "assemble", 3, "Slice the Wellington into portions.")], 1, "sheet", "main");
  const sprouts = (racks: number) => dish("b", "Balsamic Roasted Brussels Sprouts", 1, [
    st(0, "prep", 5, "Toss the sprouts and spread them on the pans."),
    st(1, "cook", 25, "Roast at 425°F for 22–25 minutes."),
    st(2, "assemble", 1, "Cover the Balsamic Roasted Brussels Sprouts with foil to keep them warm."),
    st(3, "cook", 10, "Return the Balsamic Roasted Brussels Sprouts, uncovered, to the 425°F oven for 10 minutes, until hot again."),
    st(4, "assemble", 2, "Transfer to a platter."),
  ], racks, "sheet", "side");
  const mac = dish("m", "Baked Mac and Cheese", 2, [st(0, "preheat", 15, "On Thursday: Preheat the oven to 375°F."), st(1, "cook", 45, "Bake uncovered at 375°F for 45 minutes."), st(2, "assemble", 1, "Cover the Baked Mac and Cheese with foil to keep it warm while the oven heats for the next dish."), st(3, "cook", 10, "Return the Baked Mac and Cheese, uncovered, to the 425°F oven for 10 minutes, until hot again.")], 0.5, "dish", "side");

  it("two pans of sprouts beside the Wellington's: they bake before it and are reheated; the Wellington comes out last", () => {
    const ds = [well, sprouts(2), mac];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.ok(maxRacks(r, ds) <= OVEN_RACKS, `racks ${maxRacks(r, ds)}`);
    assert.ok(at(r, "b", 1)! + 25 <= at(r, "w", 2)!, "the sprouts' roast ends before the Wellington goes in");
    const lastBakeEnd = Math.max(at(r, "b", 1)! + 25, at(r, "m", 1)! + 45);
    assert.ok(at(r, "w", 2)! + 30 > lastBakeEnd, "the Wellington's bake ends last");
    assert.ok(at(r, "b", 3) !== undefined, "the sprouts are reheated");
  });

  it("one pan of sprouts shares the Wellington's oven: no hold, no reheat", () => {
    const ds = [well, sprouts(1), mac];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.deepEqual(r.mergedSteps?.filter((m) => m.dishId === "b"), [{ dishId: "b", stepIndex: 2 }, { dishId: "b", stepIndex: 3 }]);
  });
});

// Production's New Twist and Vegetarian after patch.ts (the prod copies, dish ids shortened),
// as thursdaySchedule hands them to the scheduler — at their own servings, and New Twist at 4.
const FEASTS = JSON.parse(readFileSync(new URL("./fixtures/thx3dRound5.feasts.json", import.meta.url), "utf8")) as Record<string, SchedulerDish[]>;
const idOf = (ds: SchedulerDish[], title: RegExp) => ds.find((d) => title.test(d.title))!.dishId;
const first = (ds: SchedulerDish[], dishId: string, pick: (s: SchedulerDish["steps"][number] & { text: string }) => boolean) => ds.find((d) => d.dishId === dishId)!.steps.find((s) => pick({ ...s, text: s.text ?? "" }))!;
const carveWait = (r: ReturnType<typeof scheduleCookingSequence>, ds: SchedulerDish[]) => {
  const bird = feastRoastDish(ds)!;
  const carve = first(ds, bird.dishId, (s) => /^Carve\b/.test(s.text));
  const serve = first(ds, bird.dishId, (s) => /^Serve\b/.test(s.text));
  return at(r, bird.dishId, serve.stepIndex)! - (at(r, bird.dishId, carve.stepIndex)! + carve.estimatedMinutes);
};

describe("THX-3d round 5 (D-WS9-322) — the five feasts' own shapes", () => {
  // (226 since BUG-521: two platings no longer share the cook's hands; 223 in 5A.)
  it("New Twist at 10: the sweet potatoes bake before the spatchcock goes in; 226 minutes (more with the bird in at its own time or with them after it)", () => {
    const ds = FEASTS["new-twist"];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    const v = idOf(ds, /Sweet Potatoes/);
    const roast = first(ds, v, (s) => s.phaseType === "cook" && /Roast/.test(s.text));
    const bird = feastRoastDish(ds)!;
    const birdIn = first(ds, bird.dishId, (s) => s.phaseType === "cook");
    assert.ok(at(r, v, roast.stepIndex)! + roast.estimatedMinutes <= at(r, bird.dishId, birdIn.stepIndex)!, "out before the bird goes in");
    assert.ok(maxRacks(r, ds) <= OVEN_RACKS, `racks ${maxRacks(r, ds)}`);
    assert.ok(carveWait(r, ds) <= 10, `carve waits ${carveWait(r, ds)}`);
    assert.ok(r.totalEstimatedMinutes <= 226, `total ${r.totalEstimatedMinutes}`);
  });

  it("New Twist at 4: single pans fit the rest window; the carve still waits no more than 10 (the gravy's seasoning goes after it)", () => {
    const ds = FEASTS["new-twist@4"];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    assert.ok(r.mergedSteps?.some((m) => m.dishId === idOf(ds, /Sweet Potatoes/)), "the sweet potatoes' hold is merged away");
    assert.ok(maxRacks(r, ds) <= OVEN_RACKS, `racks ${maxRacks(r, ds)}`);
    assert.ok(carveWait(r, ds) <= 10, `carve waits ${carveWait(r, ds)}`);
  });

  it("Vegetarian at 10: the Wellington's bake ends last, after both pans of sprouts; 156 minutes (165 without the main-last order)", () => {
    const ds = FEASTS["vegetarian"];
    const r = scheduleCookingSequence(ds, { feastOven: true });
    const w = idOf(ds, /Wellington/), b = idOf(ds, /Brussels/);
    const bake = first(ds, w, (s) => s.phaseType === "cook" && /\bBake\b/i.test(s.text) && /°F/.test(s.text));
    const roast = first(ds, b, (s) => s.phaseType === "cook" && /\bRoast\b/i.test(s.text));
    assert.ok(at(r, b, roast.stepIndex)! + roast.estimatedMinutes <= at(r, w, bake.stepIndex)!, "the sprouts are out before the Wellington goes in");
    assert.ok(maxRacks(r, ds) <= OVEN_RACKS, `racks ${maxRacks(r, ds)}`);
    assert.ok(r.totalEstimatedMinutes <= 156, `total ${r.totalEstimatedMinutes}`);
  });
});
