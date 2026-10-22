// THX-3d round 2 — H (two phases, two steps), I (the put-in step), J (the warm steps),
// K (every step names its subject): the content passes, on the real sentences.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { feastWarmSteps, KEEP_WARM_TEXT, OVEN_OFF_TEXT, type ScheduleResult, type SchedulerDish } from "../../src/lib/cookingScheduler";
import { splitTwoPhase } from "./thx2Phases";
import { dishNoun, inTheOvenText, putInEdits } from "./thx2PutIn";
import { dayNoun, subjectEdits } from "./thx2Subjects";
import { warmStepEdits } from "./thx2Warm";
import type { OvenStepRow } from "./thx2Oven";
import { alreadyCut, cutSentence, heldCutPlace } from "./thx2Held";

const row = (ownerId: string, stepIndex: number, phaseType: string, estimatedMinutes: number, text: string): OvenStepRow => ({
  ownerId, stepIndex, phaseType, estimatedMinutes, stepTextTranslated: text, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null,
});

describe("THX-3d H — a two-phase bake or roast is two timed steps", () => {
  it("Classic's stuffing: covered 30, then uncovered 20–25", () => {
    assert.deepEqual(splitTwoPhase("On Thursday: Bake the stuffing covered for 30 minutes, then uncover and bake 20–25 minutes more until the top is golden and the center is set.", 55), {
      first: "On Thursday: Bake the stuffing covered for 30 minutes.",
      second: "Uncover and bake 20–25 minutes more until the top is golden and the center is set.",
      firstMinutes: 30, secondMinutes: 25,
    });
  });
  it("Small's breast: the temperature change is its own step; a make-ahead pie keeps its day on both", () => {
    const b = splitTwoPhase("Set the turkey breast skin-side up on the vegetable bed and roast at 425°F for 20 minutes to brown the skin, then reduce the oven to 325°F and continue roasting for about 30 minutes.", 49)!;
    assert.equal(b.second, "Reduce the oven to 325°F and continue roasting for about 30 minutes.");
    assert.deepEqual([b.firstMinutes, b.secondMinutes], [20, 30]);
    const p = splitTwoPhase("Make ahead (Wednesday): Bake at 425°F for 15 minutes, then reduce the oven to 350°F and bake 40–45 minutes more until set.", 15)!;
    assert.equal(p.second, "Make ahead (Wednesday): Reduce the oven to 350°F and bake 40–45 minutes more until set.");
    assert.equal(p.secondMinutes, 45, "the second phase takes its own minutes");
  });
  it("New Twist's Parmesan and Make-Ahead's cheddar: \"; scatter … and roast/bake N more\"", () => {
    assert.equal(splitTwoPhase("Roast at 350°F for 20 minutes; scatter 1 cup finely grated Parmesan over the potatoes and roast 5–8 minutes more until crisp.", 28)?.second, "Scatter 1 cup finely grated Parmesan over the potatoes and roast 5–8 minutes more until crisp.");
    assert.equal(splitTwoPhase("On Thursday: Bake the casserole, still covered in foil, for 45 minutes; uncover, scatter 1 cup cheddar over the top, and bake 15 minutes more.", 60)?.firstMinutes, 45);
  });
  it("a second clause out of the oven is no phase (\"; cool at least 20 minutes\"), and each half is one phase", () => {
    assert.equal(splitTwoPhase("Bake the apple crisp uncovered at 350°F for 45–50 minutes until golden; cool at least 20 minutes before serving.", 48), null);
    assert.equal(splitTwoPhase("Bake the pie at 350°F for 30 minutes, then top with 1 cup whipped cream and let it stand 10 minutes.", 30), null);
    assert.equal(splitTwoPhase("On Thursday: Bake the stuffing covered for 30 minutes.", 30), null);
    assert.equal(splitTwoPhase("Uncover and bake 20–25 minutes more until golden.", 25), null);
  });
});

describe("THX-3d I — the put-in step and what follows it", () => {
  it("after the raise, a named side's bake reads as the phase it is (the temperature stays for the scheduler)", () => {
    assert.deepEqual(inTheOvenText("On Thursday: Bake the stuffing covered for 30 minutes.", "the stuffing", 350), { lead: null, text: "On Thursday: The stuffing is in at 350°F, covered. Bake 30 minutes." });
    assert.equal(inTheOvenText("Bake the apple crisp uncovered at 350°F for 45–50 minutes until golden; cool at least 20 minutes before serving.", "the apple crisp", 350)?.text,
      "The apple crisp is in at 350°F, uncovered. Bake 45–50 minutes until golden; cool at least 20 minutes before serving.");
  });
  it("the dish's noun: the step's object, else its title's food; two casseroles are told apart", () => {
    assert.equal(dishNoun("Maple-Roasted Sweet Potatoes", "Roast at 350°F for 30–35 minutes.", []), "the sweet potatoes");
    assert.equal(dishNoun("Green Bean Casserole", "Bake the casserole covered for 30 minutes.", ["Green Bean Casserole", "Sweet Potato Casserole"]), "the green bean casserole");
  });
  const BIRD = { dishId: "t", title: "Roast Turkey Breast", positionIndex: 0, roleLabel: "main" };
  const STUFF = { dishId: "s", title: "Small-Batch Sage Stuffing", positionIndex: 1, roleLabel: "side" };
  const BEANS = { dishId: "b", title: "Roasted Green Beans", positionIndex: 2, roleLabel: "side" };
  const dishes = [BIRD, STUFF, BEANS];
  const steps = [
    row("t", 0, "preheat", 15, "On Thursday: Preheat the oven to 425°F."),
    row("t", 1, "cook", 60, "Roast the turkey breast at 425°F for 60 minutes."),
    row("t", 2, "preheat", 5, "Raise the oven to 350°F and put in the Small-Batch Sage Stuffing."),
    row("t", 3, "cook", 35, "Keep roasting the turkey breast at 350°F for about 35 more minutes, until it reads 165°F."),
    row("t", 4, "rest", 20, "Rest the turkey breast for 20 minutes."),
    row("t", 5, "assemble", 5, "Carve the turkey breast."),
    row("s", 0, "assemble", 3, "Make ahead (Wednesday): Cover and refrigerate."),
    row("s", 1, "cook", 30, "On Thursday: Bake the stuffing covered for 30 minutes."),
    row("b", 0, "prep", 4, "On Thursday: Toss the green beans with oil."),
    row("b", 1, "cook", 20, "Spread the green beans on a rimmed sheet pan and roast at 350°F for 18–20 minutes, until tender."),
    row("b", 2, "assemble", 2, "Squeeze the lemon over the beans."),
  ];
  it("the named stuffing is in; the beans the raise does not name get the work, \"Put … in the oven.\", the bake — once", () => {
    const e = putInEdits(dishes, steps);
    assert.deepEqual(e.updates.map((u) => `${u.dishId}#${u.stepIndex} ${u.text}`), [
      "s#1 On Thursday: The stuffing is in at 350°F, covered. Bake 30 minutes.",
      "b#1 The green beans are in at 350°F. Roast 18–20 minutes, until tender.",
    ]);
    assert.deepEqual(e.creates.map((c) => `${c.dishId}#${c.stepIndex} ${c.phaseType} ${c.text}`), [
      "b#1 prep Spread the green beans on a rimmed sheet pan.",
      "b#2 prep Put the green beans in the oven.",
    ]);
    assert.deepEqual(e.renumber.map((r) => `${r.dishId} ${r.from}→${r.to}`), ["b 2→4", "b 1→3"]);
    const after = [
      ...steps.filter((s) => s.ownerId !== "b").map((s) => (s.ownerId === "s" && s.stepIndex === 1 ? { ...s, stepTextTranslated: e.updates[0].text! } : s)),
      row("b", 0, "prep", 4, "On Thursday: Toss the green beans with oil."),
      row("b", 1, "prep", 2, "Spread the green beans on a rimmed sheet pan."),
      row("b", 2, "prep", 1, "Put the green beans in the oven."),
      row("b", 3, "cook", 20, e.updates[1].text!),
      row("b", 4, "assemble", 2, "Squeeze the lemon over the beans."),
    ];
    assert.deepEqual(putInEdits(dishes, after), { updates: [], deletes: [], creates: [], renumber: [] });
  });
});

describe("THX-3d J — the warm steps", () => {
  it("written after a stovetop side's last hot step and an oven side's last oven step; once", () => {
    const dishes = [{ dishId: "g", title: "Pan Gravy", positionIndex: 1, roleLabel: "side" }, { dishId: "s", title: "Herb Stuffing", positionIndex: 2, roleLabel: "side" }];
    const steps = [
      row("g", 0, "cook", 10, "On Thursday: Whisk the stock into the roux and simmer 10 minutes."),
      row("g", 1, "assemble", 2, "Season and pour into a gravy boat."),
      row("s", 0, "cook", 30, "On Thursday: Bake the stuffing covered at 375°F for 30 minutes."),
    ];
    const e = warmStepEdits(dishes, steps);
    assert.deepEqual(e.creates.map((c) => `${c.dishId}#${c.stepIndex} ${c.text}`), [`g#1 ${KEEP_WARM_TEXT}`, `s#1 ${OVEN_OFF_TEXT}`]);
    assert.deepEqual(warmStepEdits(dishes, [...steps, row("g", 1, "assemble", 1, KEEP_WARM_TEXT), row("s", 1, "assemble", 1, OVEN_OFF_TEXT)]).creates, []);
  });
  it("round 3 (U) — a stovetop side keeps warm once it is finished in its pot, before it is plated (Classic's mash: after the seasoning, not between mash and season)", () => {
    const dishes = [{ dishId: "m", title: "Mashed Potatoes", positionIndex: 1, roleLabel: "side" }];
    const steps = [
      row("m", 0, "cook", 20, "On Thursday: Bring to a boil and simmer 18–20 minutes."),
      row("m", 1, "cook", 5, "Rice or mash the potatoes; fold in the butter and milk."),
      row("m", 2, "assemble", 2, "Season with salt and white pepper; taste and adjust."),
      row("m", 3, "assemble", 2, "Transfer the potatoes to a large warmed serving bowl and garnish with the chives."),
    ];
    assert.deepEqual(warmStepEdits(dishes, steps).creates.map((c) => `${c.dishId}#${c.stepIndex}`), ["m#3"]);
  });
  it("Cook Mode keeps a keep-warm only beyond 15 minutes of serving, and one oven-off: the last side out, beyond 15", () => {
    const d = (dishId: string, steps: [number, string, number, string][]): SchedulerDish => ({ dishId, title: dishId, positionIndex: 0, roleLabel: null, steps: steps.map(([stepIndex, phaseType, estimatedMinutes, text]) => ({ stepIndex, phaseType: phaseType as never, estimatedMinutes, text, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null })) });
    const dishes = [
      d("beans", [[0, "cook", 10, "Sauté the beans."], [1, "assemble", 1, KEEP_WARM_TEXT]]),
      d("gravy", [[0, "cook", 10, "Simmer the gravy."], [1, "assemble", 1, KEEP_WARM_TEXT]]),
      d("stuffing", [[0, "cook", 30, "Bake at 350°F for 30 minutes."], [1, "assemble", 1, OVEN_OFF_TEXT]]),
      d("crisp", [[0, "cook", 30, "Bake at 350°F for 30 minutes."], [1, "assemble", 1, OVEN_OFF_TEXT]]),
      d("turkey", [[0, "assemble", 2, "Serve the Turkey with the Gravy."]]),
    ];
    const at = (dishId: string, i: number, t: number) => ({ dishId, originalStepIndex: i, sequenceIndex: 0, startOffsetMinutes: t });
    const res = { steps: [at("beans", 0, -60), at("beans", 1, -50), at("gravy", 0, -16), at("gravy", 1, -6), at("stuffing", 0, -70), at("stuffing", 1, -40), at("crisp", 0, -60), at("crisp", 1, -30), at("turkey", 0, -2)], totalEstimatedMinutes: 70, activeEstimatedMinutes: 30, dishDurations: {}, ignoredTags: [] } as ScheduleResult;
    const w = feastWarmSteps(res, dishes);
    assert.deepEqual(w.dropped.map((x) => `${x.dishId}#${x.stepIndex}`).sort(), ["gravy#1", "stuffing#1"]);
    assert.deepEqual(w.result.steps.map((s) => `${s.dishId}#${s.originalStepIndex}`).filter((k) => k.endsWith("#1")), ["beans#1", "crisp#1"]);
  });
});

describe("THX-3d K — every step names its subject on the day", () => {
  it("the day noun: no cut word, no flavour, the food", () => {
    assert.deepEqual(["Mashed Potatoes", "Balsamic Roasted Brussels Sprouts", "Baked Mac and Cheese", "Green Beans with Crispy Shallots"].map(dayNoun), ["the potatoes", "the Brussels sprouts", "the mac and cheese", "the green beans"]);
  });
  it("\"Transfer to\", \"Remove from heat\", \"Return it\" name the dish; make-ahead days are left as written", () => {
    const dishes = [{ dishId: "m", title: "Mashed Potatoes", positionIndex: 1, roleLabel: "side" }, { dishId: "h", title: "Herb Stuffing", positionIndex: 2, roleLabel: "side" }];
    const steps = [
      row("m", 0, "assemble", 2, "Make ahead (Wednesday): Transfer to a container and refrigerate."),
      row("m", 1, "cook", 20, "On Thursday: Boil the potatoes."),
      row("m", 2, "assemble", 2, "Transfer to a warm serving bowl."),
      row("h", 0, "cook", 10, "On Thursday: Return it, uncovered, to the 425°F oven for 10 minutes, until the Herb Stuffing is hot again."),
    ];
    assert.deepEqual(subjectEdits(dishes, steps).updates.map((u) => `${u.dishId}#${u.stepIndex} ${u.text}`), [
      "m#2 Transfer the potatoes to a warm serving bowl.",
      "h#0 On Thursday: Return the Herb Stuffing, uncovered, to the 425°F oven for 10 minutes, until hot again.",
    ]);
  });
});

describe("THX-3d M — a cut held for cook day is a step on that day", () => {
  it("the row's own words (how it waits is heldMorning's, by what comes next); a garnish; nothing to cut is nothing", () => {
    assert.equal(cutSentence({ quantity: 5, unit: "pound", name: "Russet potatoes", note: "peeled and cut into 2-inch chunks" }), "Peel and cut 5 lb russet potatoes into 2-inch chunks.");
    assert.equal(cutSentence({ quantity: 2, unit: "tablespoon", name: "fresh chives", note: "thinly sliced, for garnish" }), "Thinly slice 2 tbsp fresh chives.");
    assert.equal(cutSentence({ quantity: 3, unit: "pound", name: "baby Yukon gold potatoes", note: null }), null);
  });
  it("its place: the first step of the day the dish first names the food (Wednesday for the casserole), unless that day already cuts it", () => {
    const steps = [
      { stepIndex: 0, text: "Make ahead (Wednesday): Place 4 lb peeled sweet potato chunks in a large pot and boil." },
      { stepIndex: 1, text: "Make ahead (Wednesday): Mash the sweet potatoes." },
      { stepIndex: 2, text: "On Thursday: Bake the casserole." },
    ];
    assert.deepEqual(heldCutPlace(steps, "sweet potatoes"), { at: 0, prefix: "Make ahead (Wednesday): ", firstText: steps[0].text, runTexts: [steps[0].text, steps[1].text] });
    // Named first in the run's second step: the cut still leads the run.
    const thu = [{ stepIndex: 0, text: "On Thursday: Whisk the maple syrup and butter in a large bowl." }, { stepIndex: 1, text: "Add the 1½ pounds peeled sweet potato cubes and toss." }];
    assert.equal(heldCutPlace(thu, "sweet potatoes")?.at, 0);
    assert.equal(heldCutPlace(thu, "sweet potatoes")?.prefix, "On Thursday: ");
    assert.equal(alreadyCut(["Peel and cut 5 lb Yukon Gold potatoes into 2-inch chunks."], "yukon gold potatoes"), true);
    assert.equal(alreadyCut(["Place the potato chunks in a large pot."], "russet potatoes"), false);
  });
});

import { sitRiderGroups } from "./thx2Sit";

describe("THX-3d round 3 (U) — the preheat and the bird's prep ride its sit", () => {
  it("Classic: the sit opens the group, the preheat, the herb butter and the cavity ride it", () => {
    const dishes = [{ dishId: "t", title: "Herb-Roasted Whole Turkey", positionIndex: 0, roleLabel: "main" }];
    const steps = [
      row("t", 5, "prep", 5, "On Thursday: Remove the turkey from the brine and pat it dry."),
      row("t", 6, "hold", 60, "Let the turkey sit at room temperature for 1 hour."),
      row("t", 7, "preheat", 15, "Preheat the oven to 325°F."),
      row("t", 8, "prep", 5, "Rub the herb butter under the skin."),
      row("t", 9, "prep", 4, "Stuff the cavity with the aromatics."),
      row("t", 10, "cook", 166, "Roast the turkey at 325°F for about 2¾ hours."),
    ];
    assert.deepEqual(sitRiderGroups(dishes, steps).map((g) => `${g.stepIndex} ${g.group}`), ["6 sit", "7 sit", "8 sit", "9 sit"]);
  });
  it("New Twist: a preheat right before the sit opens it", () => {
    const dishes = [{ dishId: "t", title: "Citrus-Herb Spatchcock Turkey", positionIndex: 0, roleLabel: "main" }];
    const steps = [
      row("t", 6, "preheat", 15, "On Thursday: Preheat the oven to 400°F with a rack in the lower-middle position."),
      row("t", 7, "hold", 45, "Pull the turkey from the fridge 45 minutes before roasting."),
      row("t", 8, "prep", 6, "Slide the compound butter under the breast skin."),
      row("t", 9, "cook", 95, "Roast at 400°F for 90–100 minutes."),
    ];
    assert.deepEqual(sitRiderGroups(dishes, steps).map((g) => g.stepIndex), [6, 7, 8]);
  });
});

import { sharedOvenEdit } from "./thx2Shared";
import { thursdayPostPass } from "./thx2Thursday";

describe("THX-3d round 3 (T) — New Twist's oven at 400°F (Hans, Oct 22)", () => {
  const NT = "thx2-feast-new-twist";
  it("each dish's own 400°F time, written in; once", () => {
    const bird = sharedOvenEdit(NT, "Citrus-Herb Spatchcock Turkey", "Pour the orange and lemon juice into a large rimmed sheet pan; lay the spatchcocked turkey skin-side up on the pan and roast at 425°F for 80–90 minutes.", 85)!;
    assert.deepEqual(bird, { text: "Pour the orange and lemon juice into a large rimmed sheet pan; lay the spatchcocked turkey skin-side up on the pan and roast at 400°F for 90–100 minutes.", minutes: 95 });
    assert.equal(sharedOvenEdit(NT, "Citrus-Herb Spatchcock Turkey", "On Thursday: Preheat the oven to 425°F with a rack in the lower-middle position.", 15)?.text, "On Thursday: Preheat the oven to 400°F with a rack in the lower-middle position.");
    assert.deepEqual(sharedOvenEdit(NT, "Cornbread and Chorizo Stuffing", "On Thursday: Bake the stuffing (still covered in foil) in a 350°F oven for 30 minutes, then uncover and bake 15–20 minutes more until the top is golden and the center is set.", 50),
      { text: "On Thursday: Bake the stuffing (still covered in foil) in a 400°F oven for 30 minutes, then uncover and bake 10–12 minutes more until the top is golden and the center is set.", minutes: 42 });
    assert.deepEqual(sharedOvenEdit(NT, "Garlic-Parmesan Smashed Potatoes", "Preheat the oven to 350°F (after the turkey is out) and line two rimmed sheet pans with parchment.", 15), { text: "Line two rimmed sheet pans with parchment.", minutes: 2, phaseType: "prep" });
    assert.equal(sharedOvenEdit(NT, "Garlic-Parmesan Smashed Potatoes", "Roast at 350°F for 20 minutes; scatter 1 cup finely grated Parmesan over the potatoes and roast 5–8 minutes more until the cheese is melted.", 28)?.text, "Roast at 400°F for 20 minutes; scatter 1 cup finely grated Parmesan over the potatoes and roast 5 minutes more until the cheese is melted.");
    assert.equal(sharedOvenEdit(NT, "Chipotle-Maple Sweet Potatoes", "Spread into a single layer; dot with butter and roast at 350°F for 45–50 minutes (or 425°F for 30–35 minutes), turning once halfway.", 48)?.text, "Spread into a single layer; dot with butter and roast at 400°F for 35–40 minutes, turning once halfway.");
    assert.equal(sharedOvenEdit(NT, "Citrus-Herb Spatchcock Turkey", bird.text, 95), null);
    assert.equal(sharedOvenEdit("thx2-feast-classic", "Sage and Onion Stuffing", "Bake the stuffing (still covered in foil) in a 350°F oven for 30 minutes, then uncover and bake 15–20 minutes more.", 50), null);
  });
  it("at the bird's own temperature the sides go in with it: \"Put the … in the oven with the turkey.\", and the rest no longer roasts", () => {
    const dishes = [
      { dishId: "t", title: "Citrus-Herb Spatchcock Turkey", positionIndex: 0, roleLabel: "main" },
      { dishId: "s", title: "Cornbread and Chorizo Stuffing", positionIndex: 1, roleLabel: "side" },
      { dishId: "p", title: "Chipotle-Maple Sweet Potatoes", positionIndex: 2, roleLabel: "side" },
    ];
    const steps = [
      row("t", 0, "preheat", 15, "On Thursday: Preheat the oven to 400°F."),
      row("t", 1, "cook", 95, "Lay the turkey on the pan and roast at 400°F for 90–100 minutes."),
      row("t", 2, "rest", 25, "Roast until an instant-read thermometer reads 165°F in the thickest part of the thigh; transfer to a cutting board and rest 20–30 minutes before carving."),
      row("s", 0, "cook", 42, "On Thursday: Bake the stuffing (still covered in foil) in a 400°F oven for 30 minutes, then uncover and bake 10–12 minutes more."),
      row("p", 0, "cook", 40, "Roast the sweet potatoes at 400°F for 35–40 minutes."),
    ];
    const e = thursdayPostPass(dishes, steps);
    assert.deepEqual(e.creates.filter((c) => c.dishId === "t").map((c) => c.text).slice(0, 2), [
      "Put the Cornbread and Chorizo Stuffing and Chipotle-Maple Sweet Potatoes in the oven with the turkey.",
      "Keep roasting the turkey at 400°F for about 20 more minutes, until an instant-read thermometer in the thickest part of the thigh reads 165°F.",
    ]);
    assert.ok(e.updates.some((u) => u.dishId === "t" && u.text === "Transfer the turkey to a cutting board and rest 20–30 minutes before carving."));
  });
});
