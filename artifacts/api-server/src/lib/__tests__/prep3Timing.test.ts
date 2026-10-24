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

describe("PREP-3 3b (B) — dump1-week-hh4-mixed-ticked's R6 misses", () => {
  const ts = <T extends { isTimingSensitive: boolean }>(s: T) => ({ ...s, isTimingSensitive: true });
  it("Friday: the subs wait for the meatballs (R7) and the arugula, \"serve immediately\", is tossed within 3 minutes of serving (dump1: T−9)", () => {
    const MEATBALLS = { ...dish("mb", "Beef and Pork Meatballs in Marinara", 0, [
      st(0, "prep", 3, "Combine ½ cup plain breadcrumbs and ¼ cup whole milk in a large bowl and let soak for 2 minutes until the breadcrumbs are moistened."),
      st(1, "prep", 5, "Add ¾ pound ground beef, ½ pound ground pork, 1 large egg and the parsley to the soaked breadcrumbs and mix gently."),
      st(2, "prep", 5, "Roll the meat mixture into 16 equal balls, about 1½ inches in diameter, and set on a plate."),
      st(3, "preheat", 2, "Heat 2 tablespoons olive oil in a large, wide skillet or Dutch oven over medium-high heat until shimmering."),
      ts(st(4, "cook", 8, "Sear the meatballs in a single layer, turning every 1–2 minutes, until browned on all sides.")),
      ts(st(5, "cook", 1, "Push the meatballs to the side, add the thinly sliced garlic, and sauté 30 seconds until fragrant.")),
      st(6, "cook", 2, "Pour in the 28-oz can of crushed San Marzano tomatoes; nestle the meatballs into the sauce."),
      st(7, "cook", 20, "Reduce heat to medium-low, cover, and simmer for 20 minutes, until cooked through and the sauce has thickened."),
    ]), ingredientNames: ["ground beef", "ground pork", "plain breadcrumbs", "whole milk", "garlic", "crushed san marzano tomatoes"] };
    const ROLLS = { ...dish("rolls", "Toasted Hoagie Rolls with Melted Provolone", 1, [
      st(0, "preheat", 5, "Position an oven rack 6 inches from the broiler and preheat the broiler to high."),
      st(1, "prep", 3, "Split 4 hoagie rolls lengthwise and spread the cut sides lightly with the softened butter."),
      ts(st(2, "cook", 3, "Arrange the rolls cut-side up on a baking sheet and broil 2–3 minutes until golden — watch closely.")),
      st(3, "assemble", 3, "Spoon 3–4 meatballs with generous marinara into each toasted roll, then lay 2 slices of provolone over the meatballs in each roll."),
      ts(st(4, "cook", 3, "Return the loaded rolls to the broiler for 2–3 minutes until the provolone is fully melted and bubbling at the edges.")),
      st(5, "assemble", 1, "Top each sub with 2 fresh basil leaves (optional) and serve immediately."),
    ]), ingredientNames: ["hoagie rolls", "unsalted butter", "provolone cheese", "fresh basil leaves"] };
    const ARUGULA = { ...dish("aru", "Simple Arugula and Shaved Parmesan Salad", 2, [
      st(0, "prep", 3, "Use a vegetable peeler to shave 1 ounce of Parmesan into thin curls and set aside."),
      st(1, "prep", 2, "Whisk together 2 tablespoons extra-virgin olive oil, 1 tablespoon lemon juice and the salt in a large bowl."),
      st(2, "assemble", 2, "Add 4 ounces baby arugula to the bowl, toss to coat evenly with the dressing, then scatter the shaved Parmesan over the top and serve immediately."),
    ]), ingredientNames: ["baby arugula", "parmesan cheese", "extra-virgin olive oil", "lemon juice"] };
    const all = [MEATBALLS, ROLLS, ARUGULA];
    const r = scheduleCookingSequence(all);
    const startOf = (d: string, i: number) => r.steps.find((e) => e.dishId === d && e.originalStepIndex === i)!.startOffsetMinutes;
    assert.ok(startOf("rolls", 3) >= endOf(r, all, "mb", 7), "the subs are filled once the meatballs are done");
    assert.ok(endOf(r, all, "aru", 2) >= -3, `the arugula is tossed by T${endOf(r, all, "aru", 2)}`);
    assert.ok(endOf(r, all, "rolls", 5) >= -3, `the subs are served by T${endOf(r, all, "rolls", 5)}`);
  });

  it("Monday: a soak is a hold — the skewers are threaded once their 30 minutes are over (dump1: 25 minutes in)", () => {
    const SKEWERS = dish("sk", "Lemon-Herb Marinated Chicken Skewers", 0, [
      st(0, "prep", 2, "If using wooden skewers, submerge all 8 in cold water now and let them soak for at least 30 minutes."),
      st(1, "prep", 5, "Whisk together the olive oil, lemon juice, lemon zest, garlic and spices in a large bowl."),
      st(3, "rest", 20, "Add the chicken chunks to the marinade, tossing well to coat; cover and refrigerate for at least 20 minutes (up to 2 hours)."),
      st(4, "prep", 6, "Thread the chicken and the red onion chunks alternately onto the 8 skewers."),
      st(5, "preheat", 5, "Preheat a grill or grill pan to medium-high heat (about 425°F) and lightly oil the grates."),
      ts(st(6, "cook", 10, "Grill the skewers for 4–5 minutes per side, turning once, until cooked through to 165°F.")),
      st(7, "rest", 3, "Transfer the skewers to a platter and rest for 3 minutes before serving."),
    ]);
    const SALAD = dish("gs", "Greek Salad with Warm Pita", 1, [
      st(0, "prep", 8, "Roughly chop 4 cups romaine lettuce and halve 1 cup cherry tomatoes."),
      st(1, "prep", 3, "Whisk together the dressing in a small bowl."),
      st(2, "assemble", 3, "Combine the salad in a large bowl and toss with the dressing."),
    ]);
    const all = [SKEWERS, SALAD];
    const r = scheduleCookingSequence(all);
    const startOf = (d: string, i: number) => r.steps.find((e) => e.dishId === d && e.originalStepIndex === i)!.startOffsetMinutes;
    assert.ok(startOf("sk", 4) >= endOf(r, all, "sk", 0) + 30, `threaded T${startOf("sk", 4)}, the soak over at T${endOf(r, all, "sk", 0) + 30}`);
    // (A soak the step waits out itself holds nothing: the breadcrumbs' 2 minutes are in its 3.)
  });
});

describe("PREP-3 3b (B) — the soak's hold, in the walk and in the pass", () => {
  const ts = <T extends { isTimingSensitive: boolean }>(s: T) => ({ ...s, isTimingSensitive: true });
  const SKEWERS = dish("sk", "Lemon-Herb Marinated Chicken Skewers", 1, [
    st(0, "prep", 2, "If using wooden skewers, submerge all 8 in cold water now and let them soak for at least 30 minutes."),
    st(1, "prep", 5, "Whisk together the olive oil, lemon juice and spices in a large bowl."),
    st(2, "rest", 20, "Add the chicken chunks to the marinade; cover and refrigerate for at least 20 minutes."),
    st(3, "prep", 6, "Thread the chicken and the red onion chunks alternately onto the 8 skewers."),
    st(4, "preheat", 5, "Preheat a grill to medium-high heat."),
    ts(st(5, "cook", 10, "Grill the skewers for 4–5 minutes per side.")),
    st(6, "rest", 3, "Rest for 3 minutes before serving."),
  ]);
  it("the dish alone is as long as its soak makes it (the walk): 56 minutes, not 51", () => {
    const r = scheduleCookingSequence([SKEWERS]);
    assert.equal(r.dishDurations.sk, 56);
  });
  it("when the cook's hands push the soak late, the threading still waits for it (the pass)", () => {
    const BRAISE_LONG = dish("br", "Braised Short Ribs", 0, [
      st(0, "prep", 14, "Trim and season the short ribs."),
      ts(st(1, "cook", 11, "Sear the short ribs on all sides.")),
      st(2, "cook", 45, "Cover and braise in the 325°F oven."),
    ]);
    const all = [BRAISE_LONG, SKEWERS];
    const r = scheduleCookingSequence(all);
    const startOf = (d: string, i: number) => r.steps.find((e) => e.dishId === d && e.originalStepIndex === i)!.startOffsetMinutes;
    assert.ok(startOf("sk", 3) >= endOf(r, all, "sk", 0) + 30, `threaded T${startOf("sk", 3)}, the soak over at T${endOf(r, all, "sk", 0) + 30}`);
  });
});
