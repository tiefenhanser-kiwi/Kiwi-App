// THX-3d (F, R6) — a feast dish's days, from its steps as well as its tags, and a dish
// added to a feast gets them in code.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildMakeAheadSchedule } from "../makeAheadSchedule";
import { feastDaysForAddedDish, statesLongWait } from "../feastAddedDish";
import { prefixDaysOf } from "../feastPrefixes";

const FEAST = "22222222-2222-4222-8222-222222222222";
const sched = (dishes: { dishId: string; dishName: string; tags: string[]; stepTexts: string[] }[]) =>
  buildMakeAheadSchedule({ startDate: new Date("2026-11-23T00:00:00Z"), feast: { mealId: FEAST, assignedDayOfWeek: "Thursday", dishes } })
    .rows.map((r) => `${r.kind}:${r.dayName}:${r.dishName}`);

describe("THX-3d F — the make-ahead rows read the steps' days too", () => {
  it("Small's untagged make-ahead steps are rows (the breast, the gravy, the crisp; the stuffing's Tuesday)", () => {
    assert.deepEqual(sched([
      { dishId: "b", dishName: "Roast Turkey Breast", tags: ["thaw-2d"], stepTexts: ["Thaw (start Tuesday): If the turkey breast is frozen…", "Make ahead (Wednesday): Mix the herb butter.", "On Thursday: Roast."] },
      { dishId: "g", dishName: "Pan Gravy", tags: [], stepTexts: ["Make ahead (Wednesday): Simmer the stock.", "On Thursday: Whisk."] },
      { dishId: "s", dishName: "Small-Batch Sage Stuffing", tags: ["ahead-wed", "keeps-1d", "assemble"], stepTexts: ["Make ahead (Tuesday): Dry the bread.", "Make ahead (Wednesday): Assemble.", "On Thursday: Bake."] },
      { dishId: "c", dishName: "Apple Crisp", tags: [], stepTexts: ["Make ahead (Wednesday): Assemble.", "On Thursday: Bake."] },
    ]), [
      "thaw:Tuesday:Roast Turkey Breast",
      "make:Tuesday:Small-Batch Sage Stuffing",
      "make:Wednesday:Roast Turkey Breast",
      "make:Wednesday:Pan Gravy",
      "make:Wednesday:Small-Batch Sage Stuffing",
      "make:Wednesday:Apple Crisp",
    ]);
  });

  it("a tag and its step's phrase are one row, not two", () => {
    assert.deepEqual(sched([
      { dishId: "t", dishName: "Herb-Roasted Whole Turkey", tags: ["thaw-6d", "brine-wed"], stepTexts: ["Thaw (start Friday): …", "Make ahead (Wednesday night): Brine.", "On Thursday: Roast."] },
    ]), ["thaw:Friday:Herb-Roasted Whole Turkey", "brine:Wednesday:Herb-Roasted Whole Turkey"]);
  });

  it("prefixDaysOf reads make days, nights and the thaw", () => {
    assert.deepEqual(prefixDaysOf(["Thaw (start Friday): x", "Make ahead (Tuesday): x", "Make ahead (Wednesday night): x", "On Thursday: x"]), { make: ["tue"], night: ["wed"], thaw: "fri" });
  });
});

describe("THX-3d F — a dish added to a feast gets its days", () => {
  const BUTTERMILK = [
    "In a large pot, whisk together 2 quarts cold water, ½ cup kosher salt, and 2 tablespoons cracked black pepper until the salt dissolves.",
    "Stir in 2 quarts full-fat buttermilk, 8 smashed garlic cloves, 4 rosemary sprigs, 8 thyme sprigs, 6 sage sprigs, and 3 bay leaves.",
    "Pat the turkey dry with paper towels — do not rinse. Place it in the large brining bag set inside a roasting pan or a cooler.",
    "Pour the brine over the turkey, seal the bag tightly, and refrigerate — brine 12 to 24 hours, turning the bag halfway through.",
    "Remove the turkey from the brine 1 hour before roasting; discard the brine. Pat the turkey thoroughly dry inside and out with paper towels.",
    "Roast at 325°F until the thickest part of the thigh reads 165°F, about 3 to 3½ hours.",
  ].map((text, stepIndex) => ({ stepIndex, text }));

  it("the Buttermilk turkey swapped for Classic's: the brine is Wednesday night, the roast Thursday, the thaw inherited", () => {
    const d = feastDaysForAddedDish({ title: "Buttermilk-Brined Roast Turkey", tags: ["thanksgiving", "thanksgiving-alternate", "course-turkey"], steps: BUTTERMILK, isWholeBird: true, replacedTags: ["thaw-6d", "brine-wed"] });
    assert.deepEqual([...d.texts.keys()], [0, 1, 2, 3, 4]);
    assert.ok([0, 1, 2, 3].every((i) => d.texts.get(i)!.startsWith("Make ahead (Wednesday night): ")));
    assert.ok(d.texts.get(4)!.startsWith("On Thursday: Remove the turkey"));
    assert.deepEqual(d.tags, ["thanksgiving", "thanksgiving-alternate", "course-turkey", "brine-wed", "thaw-6d"]);
    assert.equal(d.shift, 1);
    assert.deepEqual(d.creates.map((c) => `${c.stepIndex}:${c.text}`), ["0:Thaw (start Friday): If the turkey is frozen, move it to the fridge on Friday so it is fully thawed by Wednesday."]);
  });

  it("a pie added that bakes the day before: Wednesday, then sliced on Thursday", () => {
    const d = feastDaysForAddedDish({
      title: "Sweet Potato Pie", tags: ["thanksgiving", "thanksgiving-alternate", "course-dessert"], isWholeBird: false,
      steps: [
        { stepIndex: 0, text: "Preheat the oven to 400°F." },
        { stepIndex: 1, text: "Bake both pies at 350°F for 55–65 minutes." },
        { stepIndex: 2, text: "Cool at least 2 hours before slicing, or bake the day before and refrigerate overnight." },
      ],
    });
    assert.ok([0, 1, 2].every((i) => d.texts.get(i)!.startsWith("Make ahead (Wednesday): ")));
    assert.deepEqual(d.tags.slice(-1), ["ahead-wed"]);
    assert.deepEqual(d.creates, [{ stepIndex: 3, text: "On Thursday: Slice the Sweet Potato Pie and serve.", phaseType: "assemble", estimatedMinutes: 2 }]);
  });

  it("a dish that already names its days is left alone; a short rest is not a long wait", () => {
    const d = feastDaysForAddedDish({ title: "Pan Gravy", tags: [], steps: [{ stepIndex: 0, text: "Make ahead (Tuesday): Simmer." }], isWholeBird: false });
    assert.equal(d.texts.size, 0);
    assert.equal(statesLongWait("Rest 30–45 minutes before carving."), false);
    assert.equal(statesLongWait("Remove the turkey from the brine 1 hour before roasting."), false);
    assert.equal(statesLongWait("refrigerate overnight"), true);
  });
});
