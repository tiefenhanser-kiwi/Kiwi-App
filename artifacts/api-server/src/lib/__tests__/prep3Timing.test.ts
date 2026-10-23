// PREP-3 (R6) — every dish's last hands at serving time, and the prep day the held line
// counts from.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../cookingScheduler";
import { buildPrepWeekPlan } from "../prepWeekBuild";
import { load, uuid, type Meal } from "./fixtures/prep3Week";

const st = (stepIndex: number, phaseType: SchedulerPhase, estimatedMinutes: number, text: string) => ({ stepIndex, phaseType, estimatedMinutes, text, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null });
const dish = (dishId: string, title: string, positionIndex: number, steps: ReturnType<typeof st>[]): SchedulerDish => ({ dishId, title, positionIndex, roleLabel: null, steps });

// hh4-mixed Thursday, as dumped (dump0): the Caesar dressed at T−19 and plated at T−14.
const SALMON = dish("salmon", "Garlic Butter Grilled Salmon", 0, [
  st(0, "prep", 5, "Mince the garlic and stir it into the melted butter with the lemon juice."),
  st(1, "prep", 3, "Pat the salmon fillets dry."),
  st(2, "preheat", 10, "Heat the grill to medium-high (about 425°F)."),
  st(3, "cook", 4, "Grill the salmon skin-side down for 4 minutes, then brush with the garlic butter."),
  st(4, "cook", 3, "Flip and grill 2–3 minutes more."),
  st(5, "assemble", 2, "Transfer the salmon to a platter and serve immediately with lemon wedges."),
]);
const CAESAR = dish("caesar", "Crisp Caesar Salad", 1, [
  st(0, "prep", 5, "Tear the romaine into bite-sized pieces."),
  st(1, "prep", 3, "Whisk the dressing."),
  st(2, "cook", 8, "Toast the bread pieces in a dry skillet until golden."),
  st(3, "assemble", 3, "Drizzle the dressing over the romaine and toss, then add the croutons."),
  st(4, "assemble", 2, "Divide the salad among 4 plates and finish with shaved Parmesan."),
]);
const CREMA = dish("crema", "Chipotle Crema", 2, [
  st(0, "assemble", 3, "Whisk the sour cream, chipotle and lime juice until smooth."),
  st(1, "assemble", 1, "Refrigerate until ready to drizzle over the bowls."),
]);

const BRAISE = dish("braise", "Braised Short Ribs", 0, [
  st(0, "prep", 5, "Season the short ribs."),
  st(1, "cook", 10, "Sear the short ribs on all sides."),
  st(2, "cook", 60, "Cover and braise in the 325°F oven for 1 hour."),
]);
const endOf = (r: ReturnType<typeof scheduleCookingSequence>, dishes: SchedulerDish[], d: string, i: number) =>
  r.steps.find((e) => e.dishId === d && e.originalStepIndex === i)!.startOffsetMinutes + dishes.find((x) => x.dishId === d)!.steps[i].estimatedMinutes;

describe("PREP-3 (R6) — the last hands at serving time", () => {
  it("beside a dish that needs no hands at the end, the Caesar is tossed and plated within 3 minutes of serving", () => {
    const r = scheduleCookingSequence([BRAISE, CAESAR]);
    assert.ok(endOf(r, [BRAISE, CAESAR], "caesar", 4) >= -3, `plated T${endOf(r, [BRAISE, CAESAR], "caesar", 4)}`);
  });

  it("beside a dish served the moment it is done (U), as that dish's last run starts — never the dump's T−14", () => {
    const r = scheduleCookingSequence([SALMON, CAESAR]);
    const runStart = r.steps.find((e) => e.dishId === "salmon" && e.originalStepIndex === 3)!.startOffsetMinutes;
    assert.ok(endOf(r, [SALMON, CAESAR], "caesar", 4) >= runStart, `plated T${endOf(r, [SALMON, CAESAR], "caesar", 4)}, the salmon's run starts T${runStart}`);
  });

  it("the stamped meal times pass no step text, and are as they were (the plating where the pass put it)", () => {
    const bare = [BRAISE, CAESAR].map((d) => ({ ...d, steps: d.steps.map(({ text: _t, ...s }) => s) }));
    const r = scheduleCookingSequence(bare);
    assert.ok(endOf(r, [BRAISE, CAESAR], "caesar", 4) < -3, `T${endOf(r, [BRAISE, CAESAR], "caesar", 4)}`);
  });

  it("a closing run that chills is not moved", () => {
    const r = scheduleCookingSequence([BRAISE, CREMA]);
    const at = r.steps.find((e) => e.dishId === "crema" && e.originalStepIndex === 1)!.startOffsetMinutes;
    assert.ok(at < -3, `the crema chills from T${at}`);
  });
});

describe("PREP-3 (R6) — the held line's day, from the plan's prep day", () => {
  const meal: Meal = {
    id: uuid(1), name: "Lemon Chicken Night", day: "Monday", lag: 0,
    dishes: [{ id: uuid(11), name: "Roasted Potatoes",
      ings: [{ id: uuid(101), name: "baby Yukon gold potatoes", category: "Produce", quantity: 1.5, unit: "lb", note: "halved" }],
      steps: [{ i: 0, phase: "prep", text: "Halve 1½ lb baby Yukon gold potatoes.", ids: [uuid(101)] }, { i: 1, phase: "cook", text: "Roast the potatoes at 425°F for 30 minutes." }] }],
  };
  it("\"(Monday, prep day)\" when the prep day is not today; \"(Monday, today)\" when it is", () => {
    const later = load([meal]);
    later.cookDays!.prepDayIsToday = false;
    const lines = buildPrepWeekPlan(later).heldLines;
    assert.ok(lines.length > 0, "the potatoes are held for cook day");
    for (const l of lines) assert.doesNotMatch(l, /today/, l);
    assert.ok(lines.some((l) => /\(Monday, prep day\)/.test(l)), lines.join(" | "));
    assert.ok(buildPrepWeekPlan(load([meal])).heldLines.some((l) => /\(Monday, today\)/.test(l)));
  });
});
