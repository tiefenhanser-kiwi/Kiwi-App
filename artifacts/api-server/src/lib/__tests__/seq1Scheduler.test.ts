// SEQ-1 — Cook Mode's order follows how a home cook works (QA-COOK-1, cooksim-2026-10-29).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BREAD_HOLD_MAX, breadRunFrom, isUnattended, markHandsOn, needsTheCook, panLive, scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../cookingScheduler";

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
    assert.equal(on("cook", 6, TORTILLAS.steps[0].text!), true, "one at a time, per side");
    assert.equal(on("preheat", 2, CHICKEN.steps[3].text!), true, "oil to shimmering");
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

// Al Pastor (a88f5064): the oil heats while the pork marinates (a parallel group).
const PORK = dish("pork", "Al Pastor Pork Strips", 0, [
  st(0, "prep", 5, "Slice the pork tenderloin into thin strips and pat dry with paper towels."),
  st(1, "prep", 4, "In a bowl, whisk together the 2 minced chipotle peppers, 2 tablespoons adobo sauce, 1½ teaspoons ancho chili powder, 1 teaspoon cumin, 1 teaspoon smoked paprika, 3 minced garlic cloves, ¼ cup fresh orange juice, 1 tablespoon white vinegar, and 1 teaspoon kosher salt."),
  st(2, "rest", 10, "Add the pork strips to the marinade and toss to coat evenly; let sit for at least 10 minutes while you prepare the other components.", false, "w2"),
  st(3, "preheat", 2, "Heat 1 tablespoon neutral oil in a large cast-iron or heavy skillet over medium-high until shimmering.", false, "w2"),
  st(4, "cook", 8, "Add the marinated pork strips in a single layer — work in two batches if needed — and cook for 3–4 minutes per side, turning once, until caramelized and cooked through to 145 °F.", true),
  st(5, "rest", 2, "Transfer the cooked pork to a cutting board and let it rest for 2 minutes, then roughly chop into bite-sized pieces."),
]);
const PINEAPPLE = dish("pine", "Charred Pineapple", 1, [
  st(0, "prep", 2, "Toss 1½ cups fresh pineapple chunks with ½ teaspoon neutral oil."),
  st(1, "preheat", 2, "Heat a dry cast-iron skillet or grill pan over high heat until very hot, about 2 minutes."),
  st(2, "cook", 5, "Add the pineapple chunks in a single layer and cook undisturbed for 2–3 minutes per side until deeply charred grill marks form.", true),
  st(3, "hold", 1, "Remove from heat and set aside until ready to serve."),
]);
const SLAW = dish("slaw", "Cilantro-Lime Slaw", 2, [
  st(0, "prep", 6, "Thinly shred 3 cups green cabbage, roughly chop ½ cup fresh cilantro, and thinly slice 1 jalapeño."),
  st(1, "prep", 2, "In a large bowl, whisk together 3 tablespoons freshly squeezed lime juice, 1 teaspoon honey, ½ teaspoon kosher salt, and 1 tablespoon neutral oil."),
  st(2, "assemble", 2, "Add the cabbage, cilantro, and jalapeño to the bowl and toss until evenly coated; taste and adjust salt if needed."),
]);
const CORN = dish("corn", "Warm Corn Tortillas with Cotija", 3, [
  st(0, "prep", 3, "Cut 2 limes into wedges (optional) and crumble 3 ounces cotija cheese; set both aside."),
  st(1, "cook", 5, "Warm 12 corn tortillas directly over a gas flame or in a dry skillet over medium heat, about 30 seconds per side, until pliable and lightly charred; wrap in a clean towel to keep warm.", true),
  st(2, "assemble", 1, "Set out the warm tortillas, crumbled cotija, and lime wedges (if using) for building tacos at the table."),
]);
const AL_PASTOR = [PORK, PINEAPPLE, SLAW, CORN];

// Lucknowi Chicken Biryani (df2ded1e; its bought spice-blend alternate left out).
const BIRYANI = dish("bir", "Lucknowi Chicken Biryani", 0, [
  st(0, "prep", 2, "Steep ¼ teaspoon saffron threads in 3 tablespoons warm whole milk and set aside to bloom for at least 15 minutes."),
  st(1, "prep", 32, "Rinse 2 cups basmati rice under cold water until the water runs clear, then soak in cold water for 30 minutes and drain."),
  st(2, "prep", 25, "In a large bowl, combine the chicken pieces with ½ cup yogurt, 2 tablespoons ginger-garlic paste, 1½ teaspoons ground coriander, 1 teaspoon ground cumin, 1 teaspoon Kashmiri red chili powder, 1 teaspoon garam masala, and 1½ teaspoons kosher salt; toss to coat evenly and marinate for at least 20 minutes."),
  st(4, "cook", 22, "Heat 4 tablespoons neutral oil in a large heavy-bottomed pot or Dutch oven over medium-high and fry the 2 thinly sliced onions, stirring frequently, for 18–22 minutes until deep golden brown and crispy; remove with a slotted spoon and drain on paper towels.", true),
  st(5, "cook", 8, "Bring a large pot of water to a boil with ½ teaspoon kosher salt, 3 of the green cardamom pods, 2 cloves, 4 peppercorns, 1 bay leaf, and the cinnamon stick; add the drained rice and parboil for exactly 5–6 minutes until 70% cooked (grains should still have a firm white core), then drain immediately.", true),
  st(6, "cook", 2, "In the same heavy pot used for the onions, melt 3 tablespoons ghee over medium-high; add the remaining 3 cardamom pods, 2 cloves, 4 peppercorns, 1 bay leaf, 1 star anise, and 2 mace blades and sizzle for 1 minute until fragrant.", true),
  st(7, "cook", 5, "Add the marinated chicken to the pot in a single layer and cook over high heat for 5 minutes, turning once, until the marinade thickens and the chicken is lightly seared on both sides.", true),
  st(8, "assemble", 4, "Scatter half the fried onions, ¼ cup mint leaves, and ¼ cup cilantro leaves over the chicken, then layer all the parboiled rice evenly on top; drizzle the saffron milk, 1 tablespoon rose water, and 1 tablespoon kewra water (optional) over the rice, and scatter the remaining fried onions on top."),
  st(9, "cook", 25, "Cover the pot tightly with foil and then the lid to seal in steam; cook on the lowest heat setting for 25 minutes (dum cooking), then remove from heat and let rest, still sealed, for 10 minutes."),
  st(10, "rest", 10, "Rest the sealed pot off heat for 10 minutes to allow the steam to finish cooking the rice."),
  st(11, "assemble", 3, "Uncover and gently fold the biryani from the edges inward two or three times to mix the layers without breaking the rice grains, then serve immediately."),
]);
const RAITA = dish("raita", "Cucumber and Tomato Raita", 1, [
  st(0, "prep", 7, "Halve the English cucumber lengthwise, scrape out the seeds with a spoon, and finely dice the flesh; finely dice the Roma tomato and finely mince 2 tablespoons red onion."),
  st(1, "cook", 2, "Toast ¼ teaspoon ground cumin in a dry skillet over medium heat for 60 seconds until fragrant, then remove from heat.", true),
  st(2, "assemble", 2, "Whisk 1½ cups whole milk yogurt with ½ teaspoon kosher salt and ⅛ teaspoon black pepper until smooth."),
  st(3, "assemble", 2, "Fold in the diced cucumber, diced tomato, minced red onion, 2 tablespoons chopped fresh mint, and the toasted cumin; taste and adjust salt if needed."),
  st(4, "rest", 15, "Cover and refrigerate the raita for at least 15 minutes before serving alongside the biryani."),
]);
const LUCKNOWI = [BIRYANI, RAITA];

/** The order the cook reads, as "dishId#stepIndex". */
const order = (r: R) => [...r.steps].sort((a, b) => a.sequenceIndex - b.sequenceIndex).map((e) => `${e.dishId}#${e.originalStepIndex}`);
/** Each step on a live pan (panLive, or hands-on work left in it), and the hands-on steps of other dishes read before its dish's next step. */
function handsBetweenPanSteps(r: R, ds: SchedulerDish[]): string[] {
  const marked = markHandsOn(ds);
  const seq = [...r.steps].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  const out: string[] = [];
  for (const d of marked) {
    let live = false;
    d.steps.forEach((s, k) => {
      const next = d.steps[k + 1];
      live = panLive(s) || (live && !isUnattended(s) && !/\b(?:transfer|drain|set aside|remove from heat|serve)\w*/i.test(s.text ?? ""));
      if (!live || !next) return;
      const i = seq.findIndex((e) => e.dishId === d.dishId && e.originalStepIndex === s.stepIndex);
      const j = seq.findIndex((e) => e.dishId === d.dishId && e.originalStepIndex === next.stepIndex);
      for (const e of seq.slice(i + 1, j)) if (!isUnattended(stepOf(marked, e.dishId, e.originalStepIndex))) out.push(`${d.dishId}#${s.stepIndex} … ${e.dishId}#${e.originalStepIndex} … ${d.dishId}#${next.stepIndex}`);
    });
  }
  return out;
}

describe("SEQ-1 rule 2 (BUG-594) — no knife work inside pan work you can't leave", () => {
  it("panLive: a hands-on stove step that leaves the food on the heat", () => {
    const [ch, tor] = markHandsOn([CHICKEN, TORTILLAS]);
    assert.equal(panLive(ch.steps[3]), true, "the oil, shimmering");
    assert.equal(panLive(ch.steps[4]), false, "the peppers go to a plate");
    assert.equal(panLive(ch.steps[5]), true, "the chicken sears on");
    assert.equal(panLive(ch.steps[6]), false, "removed from the heat");
    assert.equal(panLive(tor.steps[0]), true, "the tortillas, one at a time");
    assert.equal(panLive({ phaseType: "cook", isTimingSensitive: true, text: "Roast the broccoli 20 minutes, turning once." }), false, "an oven step");
    assert.equal(panLive({ phaseType: "cook", isTimingSensitive: false, text: "Simmer the sauce 20 minutes." }), false, "hands-free");
    assert.equal(panLive({ phaseType: "cook", isTimingSensitive: true }), false, "no words (the timing stamp): never");
  });

  it("the fajita: the chicken's sear is followed by its peppers; the toppings come before or after", () => {
    const r = scheduleCookingSequence(FAJITAS);
    const o = order(r);
    assert.equal(o[o.indexOf("ch#6") + 1], "ch#7");
    assert.equal(entry(r, "ch", 7).startOffsetMinutes, entry(r, "ch", 6).startOffsetMinutes + 7);
    assert.deepEqual(handsBetweenPanSteps(r, FAJITAS), []);
  });

  it("Al Pastor: the oil goes on as the marinade ends and the pork follows it; the slaw is cut before or after (was between)", () => {
    const r = scheduleCookingSequence(AL_PASTOR);
    const o = order(r);
    assert.equal(o[o.indexOf("pork#3") + 1], "pork#4");
    assert.equal(entry(r, "pork", 4).startOffsetMinutes, entry(r, "pork", 3).startOffsetMinutes + 2, "the pork goes in as the oil shimmers");
    assert.ok(entry(r, "pork", 4).startOffsetMinutes >= entry(r, "pork", 2).startOffsetMinutes + 10, "after the marinade");
    assert.deepEqual(handsBetweenPanSteps(r, AL_PASTOR), []);
  });

  it("Biryani: the dum follows the layering, and the raita is made during it (151 → 138 in QA-COOK-1's sessions)", () => {
    const r = scheduleCookingSequence(LUCKNOWI);
    const o = order(r);
    assert.equal(o[o.indexOf("bir#7") + 1], "bir#8");
    assert.equal(o[o.indexOf("bir#8") + 1], "bir#9", "the pot is sealed right after the rice is layered on the chicken");
    assert.ok(entry(r, "raita", 0).startOffsetMinutes >= entry(r, "bir", 9).startOffsetMinutes, "the cucumber is diced while the biryani steams");
    assert.deepEqual(handsBetweenPanSteps(r, LUCKNOWI), []);
  });
});

describe("SEQ-1 rule 3 (BUG-593) — bread is a serve-time dish", () => {
  it("breadRunFrom: a dish whose last heat step warms a bread, from its pan run or preheat", () => {
    const run = (steps: SchedulerDish["steps"]) => breadRunFrom(markHandsOn([{ dishId: "x", title: "x", positionIndex: 0, steps }])[0]);
    assert.equal(run(TORTILLAS.steps), 0, "the fajita tortillas: the whole dish");
    assert.equal(run([
      st(0, "prep", 3, "Brush both sides of each of the 2 pita rounds lightly with olive oil."),
      st(1, "preheat", 2, "Heat a large dry skillet or grill pan over medium-high heat."),
      st(2, "cook", 4, "Toast the pitas one or two at a time for 1–2 minutes per side until lightly charred and warmed through.", true),
      st(3, "assemble", 2, "Stack the toasted pitas and cut each into quarters, then serve alongside the salad."),
    ]), 1, "the pita, from its skillet's preheat");
    assert.equal(run([
      st(0, "prep", 3, "Shred the 3 oz Oaxacan cheese and set aside."),
      st(1, "preheat", 2, "Heat a large griddle or skillet over medium-high and brush lightly with the 1 tablespoon neutral oil."),
      st(2, "cook", 1, "Dip each corn tortilla into the reserved birria fat from the consommé to coat both sides, then lay it on the hot griddle.", true),
      st(3, "assemble", 2, "Scatter a generous pinch of shredded Oaxacan cheese over one half of each tortilla, then pile on a spoonful of shredded beef."),
      st(4, "cook", 6, "Fold the tortilla in half and cook 2–3 minutes per side, pressing gently, until the outside is crispy and the cheese is melted.", true),
    ]), 1, "Birria's dipped tortillas: the whole griddle run");
    assert.equal(run([
      st(0, "prep", 5, "In a large bowl, combine 1½ pounds ground turkey with 1 teaspoon Worcestershire sauce and form 4 patties."),
      st(1, "cook", 7, "Heat 1 tablespoon olive oil and 1 tablespoon unsalted butter in a large skillet over medium heat and cook the sliced mushrooms until golden.", true),
      st(2, "cook", 10, "Push the mushrooms to one side of the skillet (or remove to a plate), increase heat to medium-high, and cook the patties 4–5 minutes per side.", true),
      st(3, "cook", 1, "In the last minute of cooking, lay 1 slice of Swiss cheese on each patty, cover the pan with a lid until melted.", true),
      st(4, "cook", 2, "Lightly toast the 4 brioche buns cut-side down in the residual heat of the pan for 1–2 minutes.", true),
      st(5, "assemble", 3, "Spread garlic aioli on both cut sides of each bun, add lettuce, tomato, the patty and the mushrooms."),
    ]), 1, "the turkey burgers: the buns close the session at the pan (mushrooms, patties, cheese)");
    assert.equal(run([st(0, "cook", 45, "Reduce heat to low, cover, and simmer for 45 minutes until the pork is very tender; while it simmers, prepare the pickled slaw and warm the tortillas.")]), null, "a stew: the tortillas are work alongside");
    assert.equal(run([st(0, "prep", 7, "Dice the cucumber."), st(1, "cook", 2, "Toast ¼ teaspoon ground cumin in a dry skillet over medium heat for 60 seconds until fragrant, then remove from heat.", true)]), null, "toast is a verb");
    assert.equal(run([
      st(0, "cook", 5, "Warm the 6 corn tortillas in a dry skillet over medium heat for 20–30 seconds per side."),
      st(1, "assemble", 6, "Spoon the filling down the center of each tortilla and roll tightly."),
      st(2, "cook", 25, "Bake uncovered at 375°F for 22–25 minutes until the cheese is melted."),
    ]), null, "enchiladas: the tortillas are baked after");
    assert.equal(run([{ ...st(0, "cook", 6, "Warm the flour tortillas one at a time."), text: undefined }]), null, "no words (the timing stamp): never");
  });

  it("the fajita: vegetables and chicken cook, tortillas warm at the end, wrap, serve", () => {
    const r = scheduleCookingSequence(FAJITAS);
    const o = order(r);
    assert.deepEqual(o.slice(-3), ["tor#0", "tor#1", "ch#8"], "warm, wrap, then the chicken's serve");
    assert.ok(o.indexOf("ch#7") < o.indexOf("tor#0"), "the chicken is done before the tortillas go on");
    const warmEnd = entry(r, "tor", 0).startOffsetMinutes + 6;
    assert.ok(-warmEnd <= BREAD_HOLD_MAX, `the tortillas finish ${-warmEnd} min before serving`);
    assert.equal(entry(r, "tor", 1).startOffsetMinutes, warmEnd, "and are wrapped as they come off");
  });

  it("Al Pastor: the corn tortillas are warmed last and set out as the meal is served", () => {
    const r = scheduleCookingSequence(AL_PASTOR);
    const warmEnd = entry(r, "corn", 1).startOffsetMinutes + 5;
    assert.ok(-warmEnd <= BREAD_HOLD_MAX, `the tortillas finish ${-warmEnd} min before serving`);
    assert.equal(order(r).at(-1), "corn#2");
  });
});
