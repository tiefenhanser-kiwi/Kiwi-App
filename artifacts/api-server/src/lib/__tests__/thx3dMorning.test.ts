// THX-3d round 2 (M, as Hans ruled Oct 22) — the morning cut: how it waits, by what comes
// next (heldMorning), and when it happens (the scheduler's first free window).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { boilHold, plainHold, spreadOnPan, tossHold } from "../heldMorning";
import { morningSteps } from "../heldCookDay";
import { HELD_MORNING_STEP, heldMorningFirst, scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../cookingScheduler";

describe("THX-3d M — boiled: into the recipe's own pot, left on the stove, off", () => {
  it("Classic's mashed: the cut takes the pot, the water and the salt; the place step only turns the burner on", () => {
    assert.deepEqual(
      boilHold("Peel and cut 5 lb russet potatoes into 2-inch chunks.", "Place 5 lb peeled, 2-inch potato chunks in a large pot (at least 8-quart); cover with cold water by 2 inches and add 1 tablespoon kosher salt.", "Russet potatoes"),
      {
        held: "Peel and cut 5 lb russet potatoes into 2-inch chunks; put them in a large pot (at least 8-quart), cover with cold water by 2 inches, add 1 tablespoon kosher salt, and leave the pot on the stove, off, until it's time to cook.",
        later: "Turn the burner on under the pot of potatoes.",
      },
    );
  });
  it("what the place step did next stays with the burner (Make-Ahead's boil, Classic's casserole sweet potatoes)", () => {
    assert.equal(boilHold("Peel and cut 5 lb russet potatoes into 2-inch chunks.", "Place the peeled, 2-inch potato chunks in a large pot, cover with cold salted water by 2 inches, and bring to a boil over high heat.", "Russet potatoes")?.later,
      "Turn the burner on under the pot of potatoes and bring to a boil over high heat.");
    assert.equal(boilHold("Peel and cut 4 lb sweet potatoes into 2-inch chunks.", "Place 4 lb peeled sweet potato chunks in a large pot, cover with cold water, and boil 15–18 minutes until very tender; drain well.", "sweet potatoes")?.later,
      "Turn the burner on under the pot of sweet potatoes and boil 15–18 minutes until very tender; drain well.");
  });
  it("Vegetarian's pot keeps its garlic; an older hold on the cut goes", () => {
    assert.equal(boilHold("Peel and cut 5 lb Yukon Gold potatoes into 2-inch chunks; keep them in cold water.", "Place the potato chunks in a large pot with 4 peeled garlic cloves, cover with cold salted water by 2 inches.", "yukon gold potatoes")?.held,
      "Peel and cut 5 lb Yukon Gold potatoes into 2-inch chunks; put them in a large pot with 4 peeled garlic cloves, cover with cold salted water by 2 inches, and leave the pot on the stove, off, until it's time to cook.");
  });
  it("nothing to cut (New Twist's whole baby potatoes): the pot itself is the morning step", () => {
    assert.deepEqual(boilHold(null, "Place 3 pounds baby Yukon Gold potatoes in a large pot and cover with cold water by 1 inch; add 2 tablespoons kosher salt and bring to a boil over high heat.", "baby Yukon gold potatoes"), {
      held: "Put 3 pounds baby Yukon Gold potatoes in a large pot, cover with cold water by 1 inch, add 2 tablespoons kosher salt, and leave the pot on the stove, off, until it's time to cook.",
      later: "Turn the burner on under the pot of potatoes and bring to a boil over high heat.",
    });
  });
  it("a step that does not put the food in a pot of cold water is not a boil", () => {
    assert.equal(boilHold("Peel and cut 1 lb potatoes.", "Toss the potatoes with oil.", "potatoes"), null);
  });
});

describe("THX-3d M — tossed: the oil and seasoning go on in the morning, the spread stays with the oven", () => {
  it("Small's sweet potatoes: the toss holds, the spread is its own step", () => {
    assert.deepEqual(tossHold("Add the 1½ pounds peeled, 1-inch sweet potato cubes to the bowl and toss until evenly coated; spread in a single layer on a rimmed sheet pan.", "sweet potatoes"), {
      toss: "Add the 1½ pounds peeled, 1-inch sweet potato cubes to the bowl and toss until evenly coated; they can sit, covered, in the fridge for a few hours.",
      spread: "Spread the sweet potatoes in a single layer on a rimmed sheet pan.",
      pan: null,
    });
  });
  it("New Twist's: tossed on the pan → in a large bowl, and the spread takes the pan", () => {
    const t = tossHold("Toss the sweet potato chunks on a large rimmed sheet pan with 3 tablespoons olive oil, the minced chipotles, and 1 teaspoon kosher salt.", "sweet potatoes");
    assert.equal(t?.toss, "Toss the sweet potato chunks in a large bowl with 3 tablespoons olive oil, the minced chipotles, and 1 teaspoon kosher salt; they can sit, covered, in the fridge for a few hours.");
    assert.equal(t?.pan, "a large rimmed sheet pan");
    assert.equal(spreadOnPan("Spread into a single layer; dot with 2 tablespoons butter cut into small pieces.", "a large rimmed sheet pan", "sweet potatoes"),
      "Spread the sweet potatoes on a large rimmed sheet pan in a single layer; dot with 2 tablespoons butter cut into small pieces.");
    assert.equal(spreadOnPan("Spread the sweet potatoes into a single layer; dot with butter.", "a large rimmed sheet pan", "sweet potatoes"),
      "Spread the sweet potatoes on a large rimmed sheet pan in a single layer; dot with butter.");
  });
});

describe("THX-3d M — anything else: water for what browns, a container for a garnish, the fridge", () => {
  it("by the food", () => {
    assert.equal(plainHold("Peel and dice 1 lb russet potatoes.", "russet potatoes", null), "Peel and dice 1 lb russet potatoes; keep them in cold water until it's time to cook.");
    assert.equal(plainHold("Mince ¼ cup fresh parsley.", "fresh parsley", "minced, for garnish"), "Mince ¼ cup fresh parsley; keep it covered in a small container in the fridge until serving.");
    assert.equal(plainHold("Cut 1 lb broccoli into florets.", "broccoli", "cut into florets"), "Cut 1 lb broccoli into florets; keep it covered in the fridge until it's time to cook.");
  });
  it("every hold is the scheduler's marker", () => {
    for (const t of [
      "Mince ¼ cup fresh parsley; keep it covered in a small container in the fridge until serving.",
      "Peel and cut 2 lb potatoes; put them in a large pot, cover with cold water, and leave the pot on the stove, off, until it's time to cook.",
      "Toss the chunks in a large bowl with oil; they can sit, covered, in the fridge for a few hours.",
    ]) assert.match(t, HELD_MORNING_STEP);
    assert.doesNotMatch("Peel and cut 5 lb russet potatoes into 2-inch chunks; keep them in cold water.", HELD_MORNING_STEP);
  });
});

const st = (stepIndex: number, phaseType: SchedulerPhase, estimatedMinutes: number, text: string, isTimingSensitive = false) => ({
  stepIndex, phaseType, estimatedMinutes, text, isTimingSensitive, parallelGroup: null, componentKey: null, pathKey: null,
});
const dish = (dishId: string, title: string, positionIndex: number, steps: ReturnType<typeof st>[]): SchedulerDish => ({ dishId, title, positionIndex, roleLabel: null, steps });
const start = (r: { steps: { dishId: string; originalStepIndex: number; startOffsetMinutes: number }[] }, dishId: string, i: number) =>
  r.steps.find((s) => s.dishId === dishId && s.originalStepIndex === i)!.startOffsetMinutes;

const HELD = "Peel and cut 5 lb russet potatoes into 2-inch chunks; put them in a large pot, cover with cold water by 2 inches, and leave the pot on the stove, off, until it's time to cook.";

describe("THX-3d M — the scheduler does the morning chain in the day's first free window", () => {
  const ROAST = dish("roast", "Herb-Roasted Whole Turkey", 0, [
    st(0, "prep", 20, "Rub the turkey with the herb butter."),
    st(1, "cook", 180, "Roast the turkey at 325°F for about 3 hours."),
    st(2, "rest", 25, "Rest the turkey 20–30 minutes."),
    st(3, "assemble", 10, "Carve the turkey."),
  ]);
  const MASH = dish("mash", "Mashed Potatoes", 1, [
    st(0, "prep", 8, HELD),
    st(1, "cook", 1, "Turn the burner on under the pot of potatoes."),
    st(2, "cook", 20, "Bring to a boil and simmer 18–20 minutes until tender."),
    st(3, "assemble", 5, "Drain and mash with butter."),
  ]);

  it("not timed to the pot: right after the first hands-on work, hours before the burner", () => {
    const r = scheduleCookingSequence([ROAST, MASH], { feastOven: true });
    const rub = start(r, "roast", 0);
    assert.equal(start(r, "mash", 0), rub + 20, "the cut follows the rub, the first moment the hands are free");
    assert.ok(start(r, "mash", 1) - start(r, "mash", 0) > 120, `the burner is still timed to the meal (${start(r, "mash", 1)})`);
    const order = r.steps.map((s) => `${s.dishId}#${s.originalStepIndex}`);
    assert.ok(order.indexOf("mash#0") < order.indexOf("roast#2"), order.join(" "));
  });

  it("the steps before the hold go with it, in order (Small's glaze bowl, then the toss)", () => {
    const sweet = dish("sweet", "Maple-Roasted Sweet Potatoes", 1, [
      st(0, "prep", 5, "Peel and cut 1½ lb sweet potatoes into 1-inch cubes."),
      st(1, "prep", 4, "In a large bowl, whisk together the maple syrup and melted butter."),
      st(2, "prep", 4, "Add the sweet potato cubes to the bowl and toss until evenly coated; they can sit, covered, in the fridge for a few hours."),
      st(3, "prep", 2, "Spread the sweet potatoes in a single layer on a rimmed sheet pan."),
      st(4, "cook", 32, "Roast at 350°F for 30–35 minutes."),
    ]);
    const r = scheduleCookingSequence([ROAST, sweet], { feastOven: true });
    const rubEnd = start(r, "roast", 0) + 20;
    assert.deepEqual([0, 1, 2].map((i) => start(r, "sweet", i)), [rubEnd, rubEnd + 5, rubEnd + 9]);
    assert.ok(start(r, "sweet", 3) > rubEnd + 60, "the spread stays with the oven");
  });

  it("no free window before the dish's next step: the chain opens the day", () => {
    const busy = dish("busy", "Stovetop Stuffing", 0, [st(0, "prep", 10, "Chop the onion and celery."), st(1, "cook", 10, "Sauté until soft, stirring constantly.", true)]);
    // The pot is the longest thing in the meal: it starts the day, so nothing is free before it.
    const mash = dish("mash", "Mashed Potatoes", 1, [st(0, "prep", 8, HELD), st(1, "cook", 60, "Turn the burner on under the pot of potatoes and simmer 60 minutes.")]);
    const r = scheduleCookingSequence([busy, mash], { feastOven: true });
    assert.equal(r.steps[0].dishId, "mash");
    assert.equal(r.steps[0].startOffsetMinutes, -r.totalEstimatedMinutes);
  });

  it("a weeknight (no feast oven): the morning chain is Cook Mode's first step, before the meal's own first step", () => {
    const r = scheduleCookingSequence([ROAST, MASH]);
    assert.deepEqual(r.steps.slice(0, 2).map((s) => `${s.dishId}#${s.originalStepIndex}`), ["mash#0", "roast#0"]);
    assert.equal(start(r, "mash", 0), -r.totalEstimatedMinutes);
    assert.equal(start(r, "roast", 0), start(r, "mash", 0) + 8);
  });

  it("a meal with no morning step is scheduled exactly as before", () => {
    const plain = [ROAST, dish("mash", "Mashed Potatoes", 1, [st(0, "prep", 8, "Peel and cut 5 lb potatoes."), st(1, "cook", 20, "Boil 20 minutes.")])];
    const r = scheduleCookingSequence(plain);
    assert.deepEqual(heldMorningFirst(r, plain), r);
  });
});

describe("THX-3d M — a weeknight's held cut is the dish's first step (read time, heldCookDay)", () => {
  const ms = (stepIndex: number, text: string, estimatedMinutes = 2, phaseType = "cook") => ({ stepIndex, text, estimatedMinutes, phaseType });
  // hh2/hh4's Friday: Parmesan-Crusted Pork Chops' Garlic Butter Broccoli, as stored on dev.
  const BROCCOLI = [
    ms(0, "Mince the 4 garlic cloves and cut 1¼ pounds broccoli into bite-sized florets if not already done.", 5, "prep"),
    ms(1, "Bring a large pot of salted water to a boil over high heat.", 6, "preheat"),
    ms(2, "Blanch the broccoli florets in the boiling water for 2 minutes, then drain and pat dry.", 3),
    ms(5, "Remove from heat, squeeze over the juice of ½ lemon (optional), and transfer to a serving dish.", 1, "assemble"),
  ];
  const HELD = [
    { name: "lemon", quantity: 0.5, unit: "each", note: "juiced" },
    { name: "broccoli florets", quantity: 1.25, unit: "pound", note: "cut into bite-sized pieces" },
  ];

  it("Friday's note (\"juice the lemon and prep the broccoli florets that morning\") leads the dish, each with how it waits", () => {
    const out = morningSteps(BROCCOLI, HELD);
    assert.deepEqual(out.map((s) => [s.stepIndex, s.isNew, s.text]), [
      [6, true, "Juice ½ lemon; keep it covered in the fridge until it's time to cook."],
      [0, false, "Mince the 4 garlic cloves and cut 1¼ pounds broccoli into bite-sized florets if not already done; keep them covered in the fridge until it's time to cook."],
      [1, false, BROCCOLI[1].text],
      [2, false, BROCCOLI[2].text],
      [5, false, "Remove from heat, pour over the lemon juice (optional), and transfer to a serving dish."],
    ]);
    assert.ok(out.slice(0, 2).every((s) => HELD_MORNING_STEP.test(s.text)));
  });

  it("the boil and the toss read the same as the feasts'; nothing held is nothing changed", () => {
    const pot = morningSteps(
      [ms(0, "Place 2 lb peeled, 1-inch potato chunks in a large saucepan; cover with cold water by 1 inch and add 1 teaspoon kosher salt.", 4), ms(1, "Bring to a boil and cook 15 minutes.", 15)],
      [{ name: "russet potatoes", quantity: 2, unit: "pound", note: "peeled and cut into 1-inch chunks" }],
    );
    assert.deepEqual(pot.map((s) => s.text), [
      "Peel and cut 2 lb russet potatoes into 1-inch chunks; put them in a large saucepan, cover with cold water by 1 inch, add 1 teaspoon kosher salt, and leave the pot on the stove, off, until it's time to cook.",
      "Turn the burner on under the pot of potatoes.",
      "Bring to a boil and cook 15 minutes.",
    ]);
    const roast = morningSteps(
      [ms(0, "Cut 1 lb broccoli into florets and toss with 2 tablespoons olive oil and ½ teaspoon salt; spread on a sheet pan.", 4, "prep"), ms(1, "Roast at 425°F for 20 minutes.", 20)],
      [{ name: "broccoli", quantity: 1, unit: "pound", note: "cut into florets" }],
    );
    assert.deepEqual(roast.map((s) => [s.stepIndex, s.text]), [
      [0, "Cut 1 lb broccoli into florets and toss with 2 tablespoons olive oil and ½ teaspoon salt; they can sit, covered, in the fridge for a few hours."],
      [2, "Spread the broccoli on a sheet pan."],
      [1, "Roast at 425°F for 20 minutes."],
    ]);
    assert.ok(morningSteps(BROCCOLI, []).every((s) => !s.changed));
  });
});
