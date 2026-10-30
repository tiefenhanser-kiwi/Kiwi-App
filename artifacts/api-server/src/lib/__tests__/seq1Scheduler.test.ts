// SEQ-1 — Cook Mode's order follows how a home cook works (QA-COOK-1, cooksim-2026-10-29).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isUnattended, markHandsOn, needsTheCook, scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../cookingScheduler";

const st = (stepIndex: number, phaseType: SchedulerPhase, estimatedMinutes: number, text: string, isTimingSensitive = false, parallelGroup: string | null = null) => ({ stepIndex, phaseType, estimatedMinutes, text, isTimingSensitive, parallelGroup, componentKey: null, pathKey: null });
const dish = (dishId: string, title: string, positionIndex: number, steps: ReturnType<typeof st>[]): SchedulerDish => ({ dishId, title, positionIndex, roleLabel: null, steps, ingredientNames: [] });
const noText = (ds: SchedulerDish[]) => ds.map((d) => ({ ...d, steps: d.steps.map(({ text: _t, ...s }) => s) }));

// The fajita meal (24c07e6d, the catalog's own steps; its bottled-marinade alternate left out).
const CHICKEN = dish("ch", "Smoky Chipotle Chicken with Peppers and Onions", 0, [
  st(0, "prep", 8, "Mince 2 chipotle chiles in adobo sauce and 3 garlic cloves, then whisk together with 1 tablespoon adobo sauce, 3 tablespoons lime juice, 2 tablespoons olive oil, 1 teaspoon cumin, 1 teaspoon smoked paprika, ½ teaspoon chili powder, 1 teaspoon kosher salt, and ½ teaspoon black pepper in a large bowl."),
  st(2, "rest", 15, "Slice 1¾ pounds boneless skinless chicken thighs into ½-inch strips, add to the marinade, toss to coat, and let sit for 15 minutes.", false, "w2"),
  st(3, "prep", 6, "Seed and slice 2 red bell peppers and 1 yellow bell pepper into strips, and halve and slice 1 yellow onion into half-moons.", false, "w2"),
  st(4, "preheat", 2, "Heat 1 tablespoon olive oil in a large cast-iron skillet or heavy skillet over high heat until shimmering.", false, "w2"),
  st(5, "cook", 6, "Add the bell peppers and onion to the skillet and cook, stirring occasionally, for 5–6 minutes until charred at the edges and just tender, then transfer to a plate.", true, "w2"),
  st(6, "cook", 7, "Add the marinated chicken strips to the same skillet in a single layer and sear undisturbed for 3 minutes, then stir and cook another 3–4 minutes until cooked through and charred in spots.", true),
  st(7, "cook", 1, "Return the peppers and onions to the skillet, toss everything together over high heat for 1 minute, then remove from heat.", true),
  st(8, "assemble", 1, "Scatter ¼ cup roughly chopped fresh cilantro over the chicken and peppers and serve immediately from the skillet."),
]);
const TORTILLAS = dish("tor", "Warm Flour Tortillas", 1, [
  st(0, "cook", 6, "Heat a dry skillet or griddle over medium-high heat, then warm the flour tortillas one at a time for 20–30 seconds per side until pliable and lightly toasted in spots."),
  st(1, "hold", 1, "Stack the warmed tortillas and wrap in a clean kitchen towel or foil to keep them warm until serving."),
]);
const TOPPINGS = dish("top", "Fajita Toppings", 2, [
  st(0, "prep", 2, "Cut 2 limes into wedges."),
  st(1, "assemble", 3, "Set out ½ cup sour cream, 1 cup guacamole, 1 cup pico de gallo, 1 cup shredded Mexican cheese blend, the lime wedges, and (optional) ¼ cup pickled jalapeño slices in small bowls for the table."),
]);
const FAJITAS = [CHICKEN, TORTILLAS, TOPPINGS];

type R = ReturnType<typeof scheduleCookingSequence>;
const entry = (r: R, d: string, i: number) => r.steps.find((e) => e.dishId === d && e.originalStepIndex === i)!;
const stepOf = (ds: SchedulerDish[], d: string, i: number) => ds.find((x) => x.dishId === d)!.steps.find((s) => s.stepIndex === i)!;
/** Hands-on steps of other dishes that start inside this one, on the Sequencer's clock. */
function alongside(r: R, ds: SchedulerDish[], d: string, i: number): string[] {
  const marked = markHandsOn(ds);
  const a = entry(r, d, i);
  const end = a.startOffsetMinutes + stepOf(ds, d, i).estimatedMinutes;
  return r.steps
    .filter((e) => e.dishId !== d && !isUnattended(stepOf(marked, e.dishId, e.originalStepIndex)) && e.startOffsetMinutes >= a.startOffsetMinutes && e.startOffsetMinutes < end)
    .map((e) => `${e.dishId}#${e.originalStepIndex}`);
}

describe("SEQ-1 rule 1 (BUG-592) — hands-on means hands-on", () => {
  it("reads the words that hold the cook at the stove", () => {
    const on = (phaseType: SchedulerPhase, estimatedMinutes: number, text: string) => needsTheCook({ phaseType, estimatedMinutes, text });
    assert.equal(on("cook", 6, TORTILLAS.steps[0].text), true, "one at a time, per side");
    assert.equal(on("preheat", 2, CHICKEN.steps[3].text), true, "oil to shimmering");
    assert.equal(on("cook", 3, "Warm 12 corn tortillas directly over a gas flame or in a dry skillet until pliable."), true, "tortillas in a pan");
    assert.equal(on("cook", 4, "Cook the eggs, stirring constantly, until just set."), true);
    assert.equal(on("cook", 2, "Flip the pancakes and cook 1 minute more."), true);
    assert.equal(on("cook", 1, "Toss the noodles with the sauce over high heat."), true);
    // …and the ones that do not.
    assert.equal(on("preheat", 10, "Preheat the oven to 425°F."), false, "the oven heats itself");
    assert.equal(on("cook", 25, "Roast the potatoes 25 minutes, flipping once halfway."), false, "an oven step");
    assert.equal(on("cook", 12, "Return the seared chicken and any resting juices to the pan, reduce heat to medium-low, and simmer uncovered for 12 minutes."), false, "the seared chicken is the food");
    assert.equal(on("cook", 10, "Sear the patties 2 minutes per side, then cover and simmer 6 minutes."), false, "a sear that goes on to a simmer");
    assert.equal(on("cook", 20, "Toast the bread cubes in a dry skillet, tossing every 2 minutes, for 20 minutes."), false, "longer than HANDS_ON_MAX_MINUTES");
    assert.equal(on("cook", 17, "Flip the thighs and grill for another 15–18 minutes, lid closed."), false);
    assert.equal(on("rest", 10, "Let the cucumbers sit and quick-pickle for 10 minutes, tossing once halfway through."), false, "a rest is a rest");
  });

  it("isUnattended reads `handsOn` when it is there, and only the two flags when it is not", () => {
    assert.equal(isUnattended({ phaseType: "cook", isTimingSensitive: false }), true);
    assert.equal(isUnattended({ phaseType: "preheat", isTimingSensitive: false }), true);
    assert.equal(isUnattended({ phaseType: "cook", isTimingSensitive: false, handsOn: true }), false);
    assert.equal(isUnattended({ phaseType: "preheat", isTimingSensitive: false, handsOn: true }), false);
    assert.equal(isUnattended({ phaseType: "rest", isTimingSensitive: false, handsOn: true }), true);
    const marked = markHandsOn(FAJITAS);
    const turned = marked.flatMap((d) => d.steps.filter((s) => isUnattended({ ...s, handsOn: false }) && !isUnattended(s)).map((s) => `${d.dishId}#${s.stepIndex}`));
    assert.deepEqual(turned, ["ch#4", "tor#0"], "the shimmering oil and the tortillas: hands-free by the flags, hands-on by the words");
  });

  it("the fajita K2: nothing hands-on runs beside the tortillas warming one at a time", () => {
    const r = scheduleCookingSequence(FAJITAS);
    assert.deepEqual(alongside(r, FAJITAS, "tor", 0), []);
    assert.deepEqual(alongside(r, FAJITAS, "ch", 4), [], "nor beside the oil heating to shimmering");
  });

  it("the timing stamp (no text) and a feast keep the flags' reading", () => {
    const stamp = scheduleCookingSequence(noText(FAJITAS) as SchedulerDish[]);
    const flagsOnly = FAJITAS.flatMap((d) => d.steps).filter((s) => !isUnattended(s)).reduce((n, s) => n + s.estimatedMinutes, 0);
    assert.equal(stamp.activeEstimatedMinutes, flagsOnly, "hands-on minutes as the two flags count them");
    const cook = scheduleCookingSequence(FAJITAS);
    assert.equal(cook.activeEstimatedMinutes, flagsOnly + 6 + 2, "Cook Mode counts the tortillas and the shimmering oil");
    const feast = scheduleCookingSequence(FAJITAS, { feastOven: true });
    assert.equal(feast.activeEstimatedMinutes, flagsOnly, "a feast is frozen");
  });
});
