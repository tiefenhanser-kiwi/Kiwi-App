// THX-3d round 3b — production parity: the patch rules on PRODUCTION'S sentences (the
// export of Oct 23 is another generation than dev's feasts), each from a step that came
// out wrong in production's dry run.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { boilHold, tossHold } from "../../src/lib/heldMorning";
import { splitPrepClause } from "../../src/lib/feastCookWording";
import { isOvenStep } from "../../src/lib/cookingScheduler";
import { nameCutAmounts, repairShapeCounts } from "./thx2Amounts";
import { unholdMakeAhead } from "./thx2Held";
import { sharedOvenEdit } from "./thx2Shared";
import { dayNoun, subjectEdits } from "./thx2Subjects";
import { shortenRoastText, thursdayPostPass, thursdayPrePass } from "./thx2Thursday";
import type { OvenDish, OvenStepRow } from "./thx2Oven";

const row = (ownerId: string, stepIndex: number, phaseType: string, estimatedMinutes: number, stepTextTranslated: string): OvenStepRow => ({
  ownerId, stepIndex, phaseType, estimatedMinutes, stepTextTranslated, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null,
});

describe("THX-3d 3b — Classic: the roast's later clause keeps its words", () => {
  it("the basting interval stays; the time follows the roast", () => {
    assert.equal(
      shortenRoastText("Roast the turkey at 325°F for about 3 to 3½ hours (13–15 minutes per pound), until an instant-read thermometer in the thickest part of the thigh reads 165°F; baste with pan drippings every 45 minutes.", 162),
      "Roast the turkey at 325°F for about 2¾ hours; baste with pan drippings every 45 minutes.",
    );
  });
  it("New Twist: the 155°F clause and its 'begin checking at' aside go together", () => {
    assert.equal(
      shortenRoastText("Set the turkey skin-side up directly on the vegetables on the sheet pan and roast at 400°F for 90–100 minutes, until the thickest part of the thigh reads 155°F on an instant-read thermometer — begin checking at 85 minutes.", 76),
      "Set the turkey skin-side up directly on the vegetables on the sheet pan and roast at 400°F for about 1¼ hours.",
    );
  });
});

describe("THX-3d 3b — rule 2's split on production's sentences", () => {
  const rows = (...names: string[]) => names.map((name, i) => ({ ingredientId: `i${i}`, name }));
  it("Classic gravy: the stripped leaves are stirred in, not the sprigs", () => {
    assert.deepEqual(splitPrepClause("Strip the leaves from 2 thyme sprigs and stir them in; season with 1 teaspoon kosher salt and ½ teaspoon black pepper, then pour the gravy into a warm gravy boat.", rows("fresh thyme")), {
      prep: "Strip the leaves from 2 thyme sprigs.",
      work: "Stir the thyme leaves in; season with 1 teaspoon kosher salt and ½ teaspoon black pepper, then pour the gravy into a warm gravy boat.",
    });
  });
  it("Make-Ahead green beans: 'them' is the shallots alone (the last sentence's cut)", () => {
    const sp = splitPrepClause("Trim 2½ lb fresh green beans. Thinly slice 4 shallots into rings and toss them with 3 tablespoons all-purpose flour in a small bowl until lightly coated. Thinly slice 3 garlic cloves. Zest and juice 1 lemon.", rows("green beans", "shallots", "garlic", "lemon", "all-purpose flour"));
    assert.equal(sp?.prep, "Trim 2½ lb fresh green beans. Thinly slice 4 shallots into rings.");
    assert.match(sp!.work, /^Toss the sliced shallots with 3 tablespoons all-purpose flour/);
  });
  it("a cut whose work is only a bowl is one step (the toss after it holds it)", () => {
    assert.equal(splitPrepClause("On Thursday: Peel and cut 1½ pounds sweet potatoes into 1-inch cubes; place in a large bowl.", rows("sweet potatoes")), null);
    assert.equal(splitPrepClause("Peel and cut 4 lb sweet potatoes into 1½-inch chunks and place in a large bowl.", rows("sweet potatoes")), null);
  });
  it("Vegetarian apples: the cut and the lemon toss are one step (M)", () => {
    assert.equal(splitPrepClause("Make ahead (Wednesday): Peel, core, and slice 5 lb Granny Smith apples ¼-inch thick; toss with the juice of 1 lemon, ¾ cup granulated sugar, 3 tablespoons flour, and 1½ teaspoons cinnamon.", rows("granny smith apples", "lemon", "granulated sugar", "all-purpose flour", "ground cinnamon")), null);
  });
  it("Classic sweet potatoes: the work names the whole food", () => {
    assert.equal(
      splitPrepClause("Make ahead (Wednesday): peel 4½ pounds sweet potatoes and cut into 2-inch chunks; place in a large pot, cover with cold water, bring to a boil over high heat, and cook 18–20 minutes until very tender; drain well.", rows("sweet potatoes"))?.work,
      "Make ahead (Wednesday): Place the sweet potato chunks in a large pot, cover with cold water, bring to a boil over high heat, and cook 18–20 minutes until very tender; drain well.",
    );
  });
  it("Make-Ahead turkey: a rub after the cuts is the work", () => {
    assert.deepEqual(splitPrepClause("Smash 6 cloves garlic and quarter 1 yellow onion. Rub 6 tablespoons softened butter under the breast skin and over the outside.", rows("garlic", "yellow onion", "unsalted butter")), {
      prep: "Smash 6 cloves garlic and quarter 1 yellow onion.",
      work: "Rub 6 tablespoons softened butter under the breast skin and over the outside.",
    });
  });
});

describe("THX-3d 3b — the count words", () => {
  it("'(cut into pieces)' mid-list leaves one comma", () => {
    assert.equal(repairShapeCounts("Add 1 quartered onion, 2 celery stalks, 1 carrot (cut into pieces), 4 smashed garlic cloves, and 8 cups water to the pot."), "Add 1 quartered onion, 2 celery stalks, 1 carrot, cut into pieces, 4 smashed garlic cloves, and 8 cups water to the pot.");
    assert.equal(repairShapeCounts("Fold in 8 tablespoons butter (cut into pieces), 4 oz softened cream cheese."), "Fold in 8 tablespoons butter, cut into pieces, 4 oz softened cream cheese.");
  });
  it("celery's stalks after it, its shape and its cut kept", () => {
    assert.equal(repairShapeCounts("Scatter 3 stalks celery and 2 carrots in a large roasting pan."), "Scatter 3 celery stalks and 2 carrots in a large roasting pan.");
    assert.equal(repairShapeCounts("Scatter the quartered onion and 2 stalks celery pieces in the bottom of a roasting pan."), "Scatter the quartered onion and 2 celery stalks, cut into pieces, in the bottom of a roasting pan.");
    assert.equal(repairShapeCounts("Add the 2 onions and 6 stalks diced celery and cook."), "Add the 2 onions and 6 diced celery stalks and cook.");
  });
  it("a food named by its shape takes no cut word: never 'quartered onion quarters'", () => {
    const rows = [{ name: "garlic", quantity: 6, unit: "clove", note: "smashed" }, { name: "yellow onion", quantity: 1, unit: "each", note: "quartered" }];
    const out = nameCutAmounts("Stuff the cavity with the garlic, onion quarters, 6 thyme sprigs, and 6 sage leaves.", rows);
    assert.doesNotMatch(out, /quartered onion quarters/);
    assert.match(out, /, onion quarters, 6 thyme sprigs/);
  });
  it("garlic keeps THX-3c's order; every repair is idempotent", () => {
    assert.equal(repairShapeCounts("Stir in the 4 cloves minced garlic."), "Stir in the 4 cloves minced garlic.");
    for (const t of ["Add 1 carrot, cut into pieces, 4 smashed garlic cloves.", "Scatter 2 celery stalks, cut into pieces, in the pan."]) assert.equal(repairShapeCounts(t), t);
  });
});

describe("THX-3d 3b — M's holds on production's sentences", () => {
  it("Small: the pot's salt is the morning step's, not the burner's", () => {
    assert.deepEqual(boilHold("Peel and cut 2 pounds Yukon Gold potatoes into 2-inch chunks", "Place in a large saucepan, cover with cold water, and add a generous pinch of kosher salt.".replace(/^Place in/, "Place the potatoes in"), "Yukon Gold potatoes"), {
      held: "Peel and cut 2 pounds Yukon Gold potatoes into 2-inch chunks; put them in a large saucepan, cover with cold water, add a generous pinch of kosher salt, and leave the pot on the stove, off, until it's time to cook.",
      later: "Turn the burner on under the pot of potatoes.",
    });
  });
  it("a toss that closes the dressing's clause holds", () => {
    assert.deepEqual(tossHold("Whisk together 3 tablespoons maple syrup, 2 tablespoons melted butter, and ½ teaspoon kosher salt; pour over the sweet potatoes and toss to coat.", "sweet potatoes"), {
      toss: "Whisk together 3 tablespoons maple syrup, 2 tablespoons melted butter, and ½ teaspoon kosher salt; pour over the sweet potatoes and toss to coat; they can sit, covered, in the fridge for a few hours.",
      spread: null,
      pan: null,
    });
  });
  it("a make-ahead day's cut loses its hold line (Hans, Oct 23)", () => {
    assert.equal(
      unholdMakeAhead("Make ahead (Wednesday): Peel and cut 4 lb sweet potatoes into 2-inch chunks; put them in a large pot, cover with cold water, and leave the pot on the stove, off, until it's time to cook."),
      "Make ahead (Wednesday): Peel and cut 4 lb sweet potatoes into 2-inch chunks; put them in a large pot and cover with cold water.",
    );
    assert.equal(unholdMakeAhead("Make ahead (Wednesday): Peel, core, and slice 5 lb apples; keep them in cold water until it's time to cook."), "Make ahead (Wednesday): Peel, core, and slice 5 lb apples.");
    const plain = "Make ahead (Wednesday): Place the russet potato chunks in a large pot, cover with cold water, and add 2 tablespoons kosher salt.";
    assert.equal(unholdMakeAhead(plain), plain);
  });
});

describe("THX-3d 3b — one oven on production's sentences", () => {
  it("New Twist: the stuffing at 400°F, covered 30 then 10–12, its bake naming the temperature", () => {
    assert.deepEqual(sharedOvenEdit("thx2-feast-new-twist", "Cornbread and Chorizo Stuffing", "On Thursday: Preheat the oven to 350°F; bake the stuffing covered 45 minutes, then uncover and bake 15–20 more minutes until the top is golden and the center is hot.", 65), {
      text: "On Thursday: Preheat the oven to 400°F; bake the stuffing covered at 400°F for 30 minutes, then uncover and bake 10–12 more minutes until the top is golden and the center is hot.",
      minutes: 42,
    });
  });
  it("New Twist: the potatoes' preheat is their pans; their roast and the sweet potatoes' by the baker's rule", () => {
    assert.deepEqual(sharedOvenEdit("thx2-feast-new-twist", "Garlic-Parmesan Smashed Potatoes", "Preheat the oven to 425°F and brush two large rimmed sheet pans with some of the ¼ cup olive oil.", 15), { text: "Brush two large rimmed sheet pans with some of the ¼ cup olive oil.", minutes: 2, phaseType: "prep" });
    assert.deepEqual(sharedOvenEdit("thx2-feast-new-twist", "Garlic-Parmesan Smashed Potatoes", "Roast the potatoes at 425°F for 25–30 minutes until the edges are deeply golden and crispy.", 28), { text: "Roast the potatoes at 400°F for 30–35 minutes until the edges are deeply golden and crispy.", minutes: 33 });
    assert.equal(sharedOvenEdit("thx2-feast-new-twist", "Chipotle-Maple Sweet Potatoes", "Spread the sweet potatoes in a single layer across two rimmed sheet pans; roast at 425°F for 30–35 minutes, flipping once halfway, until caramelized and tender.", 33)?.text, "Spread the sweet potatoes in a single layer across two rimmed sheet pans; roast at 400°F for 35–40 minutes, flipping once halfway, until caramelized and tender.");
    assert.deepEqual(sharedOvenEdit("thx2-feast-new-twist", "Chipotle-Maple Sweet Potatoes", "On Thursday: Preheat the oven to 425°F.", 20), { text: "On Thursday: Preheat the oven to 400°F." });
  });
  it("Small: the two 425°F sides roast at 350°F at Hans's times, never 'decide by hand'", () => {
    assert.deepEqual(sharedOvenEdit("thx2-feast-small", "Maple-Roasted Sweet Potatoes", "Spread the sweet potatoes in a single layer on a large rimmed sheet pan and roast at 425°F for 25–30 minutes, flipping once halfway, until caramelized and tender.", 30), {
      text: "Spread the sweet potatoes in a single layer on a large rimmed sheet pan and roast at 350°F for 30–35 minutes, flipping once halfway, until caramelized and tender.",
      minutes: 35,
    });
    assert.deepEqual(sharedOvenEdit("thx2-feast-small", "Roasted Green Beans", "Spread the green beans in a single layer on a large rimmed sheet pan and roast at 425°F for 18–20 minutes, tossing once halfway through.", 20), {
      text: "Spread the green beans in a single layer on a large rimmed sheet pan and roast at 350°F for 18–20 minutes, tossing once halfway through.",
      minutes: 20,
    });
    assert.deepEqual(sharedOvenEdit("thx2-feast-small", "Roasted Green Beans", "On Thursday: Preheat the oven to 425°F.", 15), { text: "On Thursday: Preheat the oven to 350°F." });
    assert.equal(sharedOvenEdit("thx2-feast-small", "Roast Turkey Breast", "Set the turkey breast skin-side up and roast at 425°F for 20 minutes to brown the skin.", 20), null);
  });
  it("'the roasted turkey' is no oven step (Make-Ahead's gravy)", () => {
    assert.equal(isOvenStep({ phaseType: "cook", text: "On Thursday: Pour the gravy into a medium saucepan. Stir in any pan drippings from the roasted turkey, skimming off excess fat first." }), false);
    assert.equal(isOvenStep({ phaseType: "cook", text: "Spread the vegetables on a sheet pan until roasted and golden, about 25 minutes." }), true);
  });
});

describe("THX-3d 3b — Small: the breast holds the oven, the raise from its 325°F", () => {
  const DISHES: OvenDish[] = [
    { dishId: "t", title: "Roast Turkey Breast", positionIndex: 0, roleLabel: "main" },
    { dishId: "s", title: "Small-Batch Sage Stuffing", positionIndex: 1, roleLabel: "side" },
    { dishId: "v", title: "Maple-Roasted Sweet Potatoes", positionIndex: 2, roleLabel: "side" },
  ];
  const STEPS: OvenStepRow[] = [
    row("t", 0, "preheat", 20, "On Thursday: Preheat the oven to 425°F."),
    row("t", 1, "cook", 20, "Set the turkey breast skin-side up on the vegetables in the roasting pan and roast at 425°F for 20 minutes to brown the skin."),
    row("t", 2, "cook", 70, "Reduce the oven to 325°F and continue roasting until an instant-read thermometer in the thickest part reads 165°F, about 70 more minutes."),
    row("t", 3, "rest", 20, "Transfer the turkey breast to a cutting board and rest, tented loosely with foil, for 20 minutes before carving."),
    row("t", 4, "assemble", 5, "Carve the breast into ½-inch slices and arrange on a warm platter."),
    row("s", 0, "assemble", 3, "Make ahead (Wednesday): Transfer the stuffing to a buttered 9×13-inch baking dish, cover tightly with foil, and refrigerate overnight."),
    row("s", 1, "cook", 30, "On Thursday: Bake the stuffing covered at 350°F for 30 minutes."),
    row("s", 2, "cook", 15, "Uncover and bake 15 more minutes until the top is golden and crisp."),
    row("v", 0, "prep", 10, "On Thursday: Peel and cut 1½ pounds sweet potatoes into 1-inch cubes; place in a large bowl."),
    row("v", 1, "cook", 35, "Spread the sweet potatoes in a single layer on a large rimmed sheet pan and roast at 350°F for 30–35 minutes, flipping once halfway."),
  ];
  it("the 325°F roast splits around 'Raise the oven to 350°F', and the bird keeps roasting at 350°F", () => {
    const e = thursdayPostPass(DISHES, STEPS);
    const raise = e.creates.find((c) => c.dishId === "t" && /oven/.test(c.text));
    assert.equal(raise?.text, "Raise the oven to 350°F and put in the Small-Batch Sage Stuffing and Maple-Roasted Sweet Potatoes.");
    assert.match(e.creates.find((c) => c.dishId === "t" && /^Keep roasting/.test(c.text))!.text, /^Keep roasting the turkey breast at 350°F for about \d+ more minutes, until an instant-read thermometer in the thickest part of the breast reads 165°F\.$/);
    assert.match(e.updates.find((u) => u.dishId === "t" && u.stepIndex === 2)!.text!, /^Reduce the oven to 325°F and continue roasting for about \d+ minutes\.$/);
  });
  it("the raise is from the oven's temperature as the sides go in (325°F), not the breast's first 425°F", () => {
    const hot = STEPS.map((s) => (s.ownerId === "v" && s.stepIndex === 1 ? { ...s, stepTextTranslated: s.stepTextTranslated.replace("350°F", "425°F") } : s.ownerId === "s" && s.stepIndex === 1 ? { ...s, stepTextTranslated: s.stepTextTranslated.replace("350°F", "425°F") } : s));
    const e = thursdayPostPass(DISHES, hot);
    assert.equal(e.creates.find((c) => c.dishId === "t" && /oven/.test(c.text))?.text, "Raise the oven to 425°F and put in the Small-Batch Sage Stuffing and Maple-Roasted Sweet Potatoes.");
  });
});

describe("THX-3d 3b — New Twist: the sides with the bird at 400°F, on production's sentences", () => {
  const DISHES: OvenDish[] = [
    { dishId: "t", title: "Citrus-Herb Spatchcock Turkey", positionIndex: 0, roleLabel: "main" },
    { dishId: "s", title: "Cornbread and Chorizo Stuffing", positionIndex: 1, roleLabel: "side" },
  ];
  const STEPS: OvenStepRow[] = [
    row("t", 0, "preheat", 20, "On Thursday: Preheat the oven to 400°F."),
    row("t", 1, "cook", 105, "Set the turkey skin-side up directly on the vegetables on the sheet pan and roast at 400°F for 90–100 minutes, until the thickest part of the thigh reads 155°F on an instant-read thermometer — begin checking at 85 minutes."),
    row("t", 2, "rest", 30, "Rest the turkey on the sheet pan, loosely tented with foil, for 30 minutes before carving — the carry-over heat will bring the thigh to 165°F."),
    row("t", 3, "assemble", 10, "Carve the turkey and arrange on a warm platter."),
    row("s", 0, "assemble", 3, "Make ahead (Wednesday): Transfer the stuffing to a buttered 9×13-inch baking dish and refrigerate overnight."),
    row("s", 1, "cook", 30, "On Thursday: Bake the stuffing covered at 400°F for 30 minutes."),
    row("s", 2, "cook", 12, "Uncover and bake 10–12 more minutes until the top is golden and the center is hot."),
  ];
  it("the rest is 20–30 minutes, and once the roast goes to 165°F the carry-over clause goes", () => {
    assert.equal(thursdayPrePass(DISHES, STEPS).updates.find((u) => u.dishId === "t" && u.stepIndex === 2)?.text, "Rest the turkey on the sheet pan, loosely tented with foil, for 20–30 minutes before carving — the carry-over heat will bring the thigh to 165°F.");
    const post = thursdayPostPass(DISHES, STEPS);
    assert.equal(post.creates.find((c) => c.dishId === "t" && /oven/.test(c.text))?.text, "Put the Cornbread and Chorizo Stuffing in the oven with the turkey.");
    assert.equal(post.updates.find((u) => u.dishId === "t" && u.stepIndex === 2)?.text, "Rest the turkey on the sheet pan, loosely tented with foil, for 30 minutes before carving.");
  });
});

describe("THX-3d 3b — the pre-pass on production's sentences", () => {
  it("Make-Ahead: a 30-minute preheat that also says the hour's sit is the sit, then the preheat", () => {
    const DISHES: OvenDish[] = [{ dishId: "t", title: "Dry-Brined Roast Turkey", positionIndex: 0, roleLabel: "main" }];
    const STEPS: OvenStepRow[] = [
      row("t", 0, "preheat", 30, "On Thursday: Remove the turkey from the fridge 1 hour before roasting. Preheat the oven to 325°F."),
      row("t", 1, "cook", 180, "Roast the turkey at 325°F for 3 to 3½ hours, until an instant-read thermometer in the thickest part of the thigh reads 165°F."),
      row("t", 2, "rest", 30, "Transfer the turkey to a carving board, tent loosely with foil, and rest 30 minutes before carving."),
    ];
    const e = thursdayPrePass(DISHES, STEPS);
    assert.deepEqual(e.updates.find((u) => u.stepIndex === 0), { dishId: "t", stepIndex: 0, text: "On Thursday: Remove the turkey from the fridge 1 hour before roasting.", phaseType: "hold", minutes: 60 });
    assert.deepEqual(e.creates[0], { dishId: "t", stepIndex: 1, text: "Preheat the oven to 325°F.", phaseType: "preheat", estimatedMinutes: 30 });
  });
  it("dev's 60-minute preheat-with-sit stays one step", () => {
    const DISHES: OvenDish[] = [{ dishId: "t", title: "Dry-Brined Roast Turkey", positionIndex: 0, roleLabel: "main" }];
    const e = thursdayPrePass(DISHES, [
      row("t", 0, "preheat", 60, "On Thursday: Remove the turkey from the fridge 1 hour before roasting to take the chill off; preheat the oven to 325°F."),
      row("t", 1, "cook", 146, "Place the turkey breast-side up on a rack in the roasting pan and roast at 325°F for about 2½ hours."),
    ]);
    assert.equal(e.creates.length, 0);
    assert.equal(e.updates.filter((u) => u.stepIndex === 0).length, 0);
  });
  it("Small: ', and serve with lemon wedges;' goes whole", () => {
    const DISHES: OvenDish[] = [{ dishId: "g", title: "Roasted Green Beans", positionIndex: 0, roleLabel: "side" }];
    const e = thursdayPrePass(DISHES, [row("g", 0, "assemble", 2, "On Thursday: Transfer to a platter, grate the zest of 1 lemon over the top, and serve with lemon wedges; scatter 2 tablespoons toasted sliced almonds over the top, if using.")]);
    assert.equal(e.updates[0]?.text, "On Thursday: Transfer to a platter, grate the zest of 1 lemon over the top; scatter 2 tablespoons toasted sliced almonds over the top, if using.");
  });
  it("Vegetarian: 'Let rest 5 minutes' names the mac and cheese", () => {
    const DISHES: OvenDish[] = [{ dishId: "m", title: "Baked Mac and Cheese", positionIndex: 0, roleLabel: "side" }];
    assert.equal(dayNoun("Baked Mac and Cheese"), "the mac and cheese");
    const e = subjectEdits(DISHES, [row("m", 0, "assemble", 5, "On Thursday: Let rest 5 minutes.")]);
    assert.equal(e.updates[0]?.text, "On Thursday: Let the mac and cheese rest 5 minutes.");
  });
});
