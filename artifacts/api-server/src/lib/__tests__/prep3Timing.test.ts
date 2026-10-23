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

  it("the salmon bakes until it is plated, near serving (hh2 Wednesday had plated it at T−14, its bake over at T−14)", () => {
    const SALMON_BAKE = dish("salmon", "Baked Salmon Teriyaki", 0, [st(0, "preheat", 10, "Preheat the oven to 425°F."), st(1, "prep", 3, "Pat the salmon dry and place on the sheet."), st(2, "assemble", 2, "Spoon the glaze over the fillets."), st(3, "cook", 15, "Bake the salmon for 15 minutes."), st(4, "assemble", 2, "Transfer the salmon to a platter and garnish with sesame seeds.")]);
    const RICE = dish("rice", "Egg Fried Rice", 1, [st(0, "prep", 3, "Separate the rice."), st(1, "prep", 4, "Beat the eggs."), st(2, "preheat", 2, "Heat the oil in a wok."), st(3, "cook", 1, "Add the garlic."), st(4, "cook", 3, "Add the rice."), st(5, "cook", 2, "Scramble the eggs."), st(6, "cook", 2, "Add the peas and soy sauce."), st(7, "assemble", 1, "Scatter the scallion greens over the top and serve immediately.")]);
    const PEAS = dish("peas", "Stir-Fried Snap Peas", 2, [st(0, "prep", 5, "Pull the strings from the snap peas."), st(1, "preheat", 2, "Heat the oil."), st(2, "cook", 3, "Stir-fry the garlic and peas."), st(3, "assemble", 1, "Drizzle with soy sauce and serve right away.")]);
    const all = [SALMON_BAKE, RICE, PEAS];
    const r = scheduleCookingSequence(all);
    const at = (d: string, i: number) => r.steps.find((e) => e.dishId === d && e.originalStepIndex === i)!.startOffsetMinutes;
    assert.ok(endOf(r, all, "salmon", 4) >= -4, `plated T${endOf(r, all, "salmon", 4)}`);
    assert.equal(endOf(r, all, "salmon", 3), at("salmon", 4), "out of the oven and onto the platter");
  });

  it("hh4-mixed Thursday: the Caesar, its croutons left to cool, is plated as the salmon's run starts (dump1: T−14)", () => {
    // (The dump's own steps, the bought path's out.)
    const CAESAR_TOAST = dish("caesar", "Crisp Caesar Salad with Homemade Croutons", 1, [
      st(0, "prep", 5, "Remove outer leaves from 3 romaine hearts, then tear or chop the inner leaves into bite-sized pieces and place in a large salad bowl; refrigerate until ready to dress."),
      st(1, "prep", 3, "Use a vegetable peeler to shave 2 oz Parmesan into thin ribbons; set aside, reserving a little extra for serving."),
      st(2, "prep", 4, "Mince 1 garlic clove to a fine paste, then mash 4 drained anchovy fillets into the paste using the flat of a knife until a smooth paste forms."),
      st(3, "prep", 3, "Whisk together the anchovy-garlic paste, 1 egg yolk, 2 tablespoons fresh lemon juice, 1 teaspoon Dijon mustard, and ½ teaspoon Worcestershire sauce in a medium bowl until combined."),
      st(4, "prep", 3, "Slowly drizzle in 3 tablespoons extra-virgin olive oil while whisking constantly to emulsify into a creamy dressing, then stir in 1 tablespoon finely grated Parmesan, ½ teaspoon kosher salt, and ¼ teaspoon black pepper."),
      st(5, "prep", 4, "Tear 4 oz day-old sourdough into ¾-inch pieces, toss with 2 tablespoons olive oil and a pinch of kosher salt, then rub the torn pieces with the cut side of a halved garlic clove."),
      st(6, "cook", 8, "Toast the bread pieces in a dry skillet over medium heat, tossing every minute, for 6–8 minutes until golden and crisp on all sides; transfer to a plate to cool."),
      st(7, "assemble", 3, "Drizzle the dressing over the chilled romaine and toss well to coat every leaf, then add the croutons and shaved Parmesan and toss once more."),
      st(8, "assemble", 2, "Divide the salad among 4 plates and finish with extra shaved Parmesan and a crack of black pepper."),
    ]);
    const GRILLED = dish("salmon", "Garlic Butter Grilled Salmon", 0, [
      st(0, "prep", 5, "Mince 4 garlic cloves and finely chop 2 tablespoons flat-leaf parsley, then stir both into 3 tablespoons melted unsalted butter with 1 tablespoon fresh lemon juice, 1 teaspoon kosher salt, and ½ teaspoon black pepper to make the basting butter."),
      st(1, "prep", 3, "Pat the 4 salmon fillets completely dry with paper towels and cut 1 lemon into wedges for serving."),
      st(2, "preheat", 10, "Heat a gas or charcoal grill to medium-high (about 425°F) and brush the grates thoroughly with 1 tablespoon olive oil."),
      st(3, "cook", 4, "Place the salmon fillets skin-side down on the grill and cook undisturbed for 4 minutes, then brush generously with the garlic butter."),
      st(4, "cook", 3, "Flip the fillets carefully and grill flesh-side down for 2–3 minutes, brushing the skin side with more garlic butter, until the salmon is just opaque in the center and releases cleanly from the grates."),
      st(5, "assemble", 2, "Transfer the salmon to a platter, brush with any remaining garlic butter, and serve immediately with lemon wedges."),
    ]);
    // (Stored timing-sensitive: the toast and the grilling — the cook's hands. Without the
    // flags the core pass already got it right; with them it had plated the Caesar at T−16.)
    for (const s of [CAESAR_TOAST.steps[6], GRILLED.steps[3], GRILLED.steps[4]]) s.isTimingSensitive = true;
    const all = [GRILLED, CAESAR_TOAST];
    const r = scheduleCookingSequence(all);
    const runStart = r.steps.find((e) => e.dishId === "salmon" && e.originalStepIndex === 3)!.startOffsetMinutes;
    assert.ok(endOf(r, all, "caesar", 8) >= runStart, `plated T${endOf(r, all, "caesar", 8)}, the salmon's run starts T${runStart}`);
    // …and never inside it: the salmon is served the moment it is done.
    assert.ok(endOf(r, all, "caesar", 8) <= runStart, `plated T${endOf(r, all, "caesar", 8)}, inside the salmon's run from T${runStart}`);
    assert.equal(endOf(r, all, "salmon", 5), 0, "the salmon is served at serving time");
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
