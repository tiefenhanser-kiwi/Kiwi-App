// THX-4 (D-WS9-324) — THE TURKEY'S WEIGHT, SET BY THE COOK. The bird's dish follows the
// chosen weight (not the servings), the roast follows it (never under FSIS's low end
// for a whole bird), the thaw follows it (⌈lb ÷ 4⌉ days before the brine), and nothing
// moves when no weight is chosen. The pinned table is the one the client lane pins
// (artifacts/kiwi birdRule.test.ts) for the stepper.
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dishRowMultipliers, weighedTurkeyOf } from "../prepQuantity";
import { formatMeasure } from "../prepWeekAssembly";
import { buildPrepCombineInput } from "../prepCombineAdapter";
import type { PrepLoadedPlan } from "../prepWeekAggregation";
import { chosenBirdOf } from "../prepWeekAggregation";
import {
  aboutDuration,
  birdRoastEdit,
  birdRoastMinutes,
  birdThawStepText,
  birdLineAtWeight,
  birdWeightProblem,
  editStep,
  mealBirdOf,
  roastStepEdits,
  thawFridgeDays,
  usdaWholeLowMinutes,
  withBirdRoast,
} from "../birdWeight";
import { buildMakeAheadSchedule, weighedThaw } from "../makeAheadSchedule";

// Classic's "Herb-Roasted Whole Turkey" (prod copy b39d5876, 10 servings): the bird, the
// brine's salt and water, the bag, and a neck.
const TURKEY = [
  { quantity: 14, unit: "pound", name: "whole turkey" },
  { quantity: 0.5, unit: "cup", name: "kosher salt" },
  { quantity: 1, unit: "gallon", name: "cold water" },
  { quantity: 1, unit: "each", name: "large brining bag" },
  { quantity: 1, unit: "each", name: "turkey neck" },
];
// The Buttermilk-Brined alternate (dev b8fcb9f9): one bird by count, its weight in the note.
const BUTTERMILK = [
  { quantity: 1, unit: "each", name: "whole turkey", note: "12–14 lb, neck and giblets removed and reserved" },
  { quantity: 2, unit: "quart", name: "buttermilk" },
  { quantity: 0.5, unit: "cup", name: "Kosher salt" },
  { quantity: 1, unit: "each", name: "large brining bag" },
  { quantity: 1, unit: "each", name: "turkey neck" },
];
const shown = (rows: readonly { quantity: number; unit: string; name: string }[], m: number[]) => rows.map((r, i) => formatMeasure(r.quantity * m[i], r.unit, r.name));

describe("THX-4 — the bird's dish follows the chosen weight, at any servings", () => {
  // chosen lb → bird · salt · water · bag · neck (servings 4, 10 and 20 all alike)
  const TABLE: Array<[number, string[]]> = [
    [8, ["8 lb", "¼ cup", "⅝ gallon", "1", "1"]],
    [10, ["10 lb", "⅓ cup", "¾ gallon", "1", "1"]],
    [12, ["12 lb", "½ cup", "⅞ gallon", "1", "1"]],
    [14, ["14 lb", "½ cup", "1 gallon", "1", "1"]],
    [16, ["16 lb", "½ cup", "1⅛ gallon", "1", "1"]],
    [20, ["20 lb", "¾ cup", "1⅜ gallon", "1", "1"]],
  ];
  for (const [lb, want] of TABLE) {
    it(`${lb} lb → ${want.join(" · ")}`, () => {
      for (const servings of [4, 10, 20]) assert.deepEqual(shown(TURKEY, dishRowMultipliers(TURKEY, servings / 10, { feast: true, birdLb: lb })), want);
    });
  }

  it("no floor under a chosen weight: 8 lb is 8 lb (the servings rule floors a turkey at 10)", () => {
    assert.equal(shown(TURKEY, dishRowMultipliers(TURKEY, 0.4))[0], "10 lb");
    assert.equal(shown(TURKEY, dishRowMultipliers(TURKEY, 0.4, { birdLb: 8 }))[0], "8 lb");
  });

  it("a bird written by count is ONE bird; its dish follows chosen ÷ the note's weight", () => {
    // chosen lb → birds · buttermilk · salt · bag · neck
    const want: Array<[number, string[]]> = [
      [10, ["1", "1⅜ quart", "⅓ cup", "1", "1"]],
      [14, ["1", "2 quart", "½ cup", "1", "1"]],
      [20, ["1", "2⅞ quart", "¾ cup", "1", "1"]],
    ];
    // At 20 servings the servings rule says two birds; a chosen weight says one.
    assert.equal(shown(BUTTERMILK, dishRowMultipliers(BUTTERMILK, 2, { feast: true }))[0], "2");
    for (const [lb, w] of want) for (const s of [4, 10, 20]) assert.deepEqual(shown(BUTTERMILK, dishRowMultipliers(BUTTERMILK, s / 10, { feast: true, birdLb: lb })), w);
  });

  it("nothing changes without a weight, or for a dish with no turkey", () => {
    for (const s of [0.4, 0.8, 1, 2]) {
      assert.deepEqual(dishRowMultipliers(TURKEY, s, { feast: true }), dishRowMultipliers(TURKEY, s, { feast: true, ...{} }));
      const gravy = [{ quantity: 1, unit: "each", name: "turkey neck" }, { quantity: 2, unit: "stalk", name: "celery" }];
      assert.deepEqual(dishRowMultipliers(gravy, s, { feast: true, birdLb: 16 }), dishRowMultipliers(gravy, s, { feast: true }));
    }
  });

  it("weighs turkeys only: a breast, a chicken, a count turkey with no weight anywhere", () => {
    assert.deepEqual(weighedTurkeyOf(TURKEY), { row: 0, recipeLb: 14, byCount: false });
    assert.deepEqual(weighedTurkeyOf(BUTTERMILK), { row: 0, recipeLb: 14, byCount: true });
    assert.deepEqual(weighedTurkeyOf([{ quantity: 1, unit: "each", name: "whole turkey (12–14 lb)" }]), { row: 0, recipeLb: 14, byCount: true });
    assert.equal(weighedTurkeyOf([{ quantity: 5, unit: "pound", name: "bone-in turkey breast" }]), null);
    assert.equal(weighedTurkeyOf([{ quantity: 4, unit: "pound", name: "whole chicken" }]), null);
    assert.equal(weighedTurkeyOf([{ quantity: 1, unit: "each", name: "whole turkey" }]), null);
  });

  it("Prep the feast reads it (adapter): the bird and the brine at 16 lb, the gravy's neck one", () => {
    const ing = (id: string, name: string, quantity: number, unit: string, category = "Pantry") => ({
      ingredientId: id, ingredientName: name, category, quantity, unit, preparationNote: null, sourceYield: null,
    });
    const loaded = {
      meals: [{
        mealId: "m", mealName: "Feast", servingsOverride: 4, feast: true, bird: { dishId: "turkey", lb: 16 },
        dishes: [
          { dishId: "turkey", dishName: "Turkey", dishRole: "main", baseServings: 10, authoredBaseServings: 10, stepTexts: [], componentSteps: [],
            ingredients: [ing("t", "whole turkey", 14, "pound", "Protein"), ing("s", "kosher salt", 0.5, "cup")] },
          { dishId: "gravy", dishName: "Gravy", dishRole: "sauce", baseServings: 10, authoredBaseServings: 10, stepTexts: [], componentSteps: [],
            ingredients: [ing("n", "turkey neck", 1, "each", "Protein"), ing("f", "all-purpose flour", 0.5, "cup")] },
        ],
      }],
    } as unknown as PrepLoadedPlan;
    const out = buildPrepCombineInput(loaded);
    const q = (dish: string, id: string) => out.meals[0].dishes.find((d) => d.dishId === dish)!.ingredients.find((i) => i.ingredientId === id)!.quantity;
    assert.ok(Math.abs(q("turkey", "t") - 16) < 1e-12);
    assert.ok(Math.abs(q("turkey", "s") - 0.5 * (16 / 14)) < 1e-12);
    assert.equal(q("gravy", "n"), 1);
    assert.ok(Math.abs(q("gravy", "f") - 0.2) < 1e-12);
  });

  it("the loader adds `bird` only when a weight is set (every fingerprint unchanged at null)", () => {
    const meal = {
      tags: ["thanksgiving-feast"],
      dishLinks: [{ dish: { id: "turkey", title: "Herb-Roasted Whole Turkey", dishIngredients: [{ quantity: 14, unit: "pound", preparationNote: null, ingredient: { displayName: "whole turkey" } }] } }],
    };
    assert.deepEqual(chosenBirdOf(null, meal), {});
    assert.deepEqual(chosenBirdOf(undefined, meal), {});
    assert.deepEqual(chosenBirdOf(16.5, meal), { bird: { dishId: "turkey", lb: 16.5 } });
    assert.deepEqual(chosenBirdOf(16, { ...meal, tags: ["american"] }), {});
  });
});

describe("THX-4 — the meal's bird: kind, range, default; the PATCH's refusal", () => {
  const dish = (title: string, rows: { quantity: number; unit: string; name: string; note?: string }[]) => ({ dishId: title, title, rows });
  it("a feast's whole turkey is 8–20 lb; a spatchcock 8–16; default the recipe's", () => {
    const whole = mealBirdOf({ tags: ["thanksgiving-feast"], dishes: [dish("Pan Gravy", [{ quantity: 1, unit: "each", name: "turkey neck" }]), dish("Herb-Roasted Whole Turkey", TURKEY)] })!;
    assert.equal(whole.dishId, "Herb-Roasted Whole Turkey");
    assert.deepEqual([whole.kind, whole.range], ["whole", { min: 8, max: 20, step: 0.5, default: 14 }]);
    const flat = mealBirdOf({ tags: ["thanksgiving-feast"], dishes: [dish("Citrus-Herb Spatchcock Turkey", [{ quantity: 14, unit: "pound", name: "whole turkey", note: "spatchcocked" }])] })!;
    assert.deepEqual([flat.kind, flat.range.max], ["spatchcock", 16]);
    // A Thanksgiving turkey alternate on its own; not a weeknight roast.
    assert.ok(mealBirdOf({ tags: ["thanksgiving", "course-turkey"], dishes: [dish("Buttermilk-Brined Roast Turkey", BUTTERMILK)] }));
    assert.equal(mealBirdOf({ tags: ["american"], dishes: [dish("Roast Turkey", TURKEY)] }), null);
    assert.equal(mealBirdOf({ tags: ["thanksgiving-feast"], dishes: [dish("Roast Turkey Breast", [{ quantity: 5, unit: "pound", name: "bone-in turkey breast" }])] }), null);
  });

  it("refuses out of range, off the ½-lb grid, and a meal with no turkey, naming the range", () => {
    const whole = { range: { min: 8, max: 20, step: 0.5, default: 14 } };
    const flat = { range: { min: 8, max: 16, step: 0.5, default: 14 } };
    for (const ok of [8, 12.5, 14, 20]) assert.equal(birdWeightProblem(ok, whole), null);
    assert.equal(birdWeightProblem(7.5, whole), "birdWeightLb must be 8–20 lb in ½-lb steps");
    assert.equal(birdWeightProblem(20.5, whole), "birdWeightLb must be 8–20 lb in ½-lb steps");
    assert.equal(birdWeightProblem(12.3, whole), "birdWeightLb must be 8–20 lb in ½-lb steps");
    assert.equal(birdWeightProblem(16.5, flat), "birdWeightLb must be 8–16 lb in ½-lb steps");
    assert.equal(birdWeightProblem(Number.NaN, whole), "birdWeightLb must be 8–20 lb in ½-lb steps");
    assert.equal(birdWeightProblem(14, null), "this meal has no turkey to weigh");
  });
});

describe("THX-4 — the roast follows the weight (call 2)", () => {
  it("FSIS's unstuffed low end, a bracket edge taking the lighter bracket", () => {
    assert.deepEqual([8, 12, 12.5, 14, 14.5, 18, 18.5, 20, 22].map(usdaWholeLowMinutes), [165, 165, 180, 180, 225, 225, 255, 255, 270]);
  });

  it("the recipe's own minutes per pound, never under it for a whole bird; spatchcock its own rate", () => {
    // Classic 187 min at 14 lb (13.4 min/lb); Make-Ahead 171 (12.2 → the low end); New Twist 103.
    assert.deepEqual([8, 10, 12, 14, 16, 20].map((lb) => birdRoastMinutes("whole", 187, 14, lb)), [165, 165, 165, 187, 225, 267]);
    assert.deepEqual([8, 10, 12, 14, 16, 20].map((lb) => birdRoastMinutes("whole", 171, 14, lb)), [165, 165, 165, 180, 225, 255]);
    assert.deepEqual([8, 10, 12, 14, 16].map((lb) => birdRoastMinutes("spatchcock", 103, 14, lb)), [59, 74, 88, 103, 118]);
  });

  // Classic's day steps: the main roast, the raise, the finish, the rest, the carve.
  const DAY = [
    { stepIndex: 7, estimatedMinutes: 20, phaseType: "preheat", text: "Preheat the oven to 325°F." },
    { stepIndex: 11, estimatedMinutes: 162, phaseType: "cook", text: "Roast the turkey at 325°F for about 2¾ hours; baste with pan drippings every 45 minutes." },
    { stepIndex: 12, estimatedMinutes: 5, phaseType: "preheat", text: "Raise the oven to 350°F and put in the Sage and Onion Stuffing." },
    { stepIndex: 13, estimatedMinutes: 25, phaseType: "cook", text: "Keep roasting the turkey at 350°F for about 25 more minutes, until an instant-read thermometer reads 165°F." },
    { stepIndex: 14, estimatedMinutes: 25, phaseType: "rest", text: "Transfer the turkey to a carving board and rest 20–30 minutes." },
  ];
  it("the main roast takes the whole change; the finish, the rest and the carve keep theirs", () => {
    assert.deepEqual(birdRoastEdit(DAY, { kind: "whole", recipeLb: 14 }, 20), { stepIndex: 11, minutes: 242, authoredMinutes: 162, cookMinutes: 267 });
    assert.deepEqual(birdRoastEdit(DAY, { kind: "whole", recipeLb: 14 }, 14), { stepIndex: 11, minutes: 162, authoredMinutes: 162, cookMinutes: 187 });
    const moved = withBirdRoast([{ dishId: "t", steps: DAY }, { dishId: "g", steps: DAY }], { dishId: "t", kind: "whole", recipeLb: 14 }, 10);
    assert.deepEqual(moved[0].steps.map((s) => s.estimatedMinutes), [20, 140, 5, 25, 25]);
    assert.equal(moved[1].steps, DAY);
  });

  it("the main roast's words follow its minutes; the finish's 'about 25 more minutes' is not the roast's", () => {
    const say = (text: string, minutes: number, lb: number) => editStep(text, null, roastStepEdits(text, minutes, lb)).text;
    assert.equal(say(DAY[1].text, 242, 20), "Roast the turkey at 325°F for about 4 hours; baste with pan drippings every 45 minutes.");
    assert.equal(say(DAY[1].text, 140, 10), "Roast the turkey at 325°F for about 2¼ hours; baste with pan drippings every 45 minutes.");
    assert.equal(say("Set the turkey skin-side up and roast at 400°F for about 1 hour.", 17, 8), "Set the turkey skin-side up and roast at 400°F for about 15 minutes.");
    assert.equal(say(DAY[3].text, 40, 20), DAY[3].text);
    assert.equal(
      say("Roast at 325°F until the thigh reads 165°F, about 3 to 3½ hours (13–15 minutes per pound) for a 12–14 lb bird.", 240, 16),
      "Roast at 325°F until the thigh reads 165°F, about 4 hours (13–15 minutes per pound) for a 16-lb bird.",
    );
    assert.deepEqual([45, 59, 60, 74, 165, 267].map(aboutDuration), ["about 45 minutes", "about 1 hour", "about 1 hour", "about 1¼ hours", "about 2¾ hours", "about 4½ hours"]);
  });

  it("a ref after an edit moves with its text; one inside it goes", () => {
    const text = "Roast for about 2¾ hours, then baste with 2 cups broth.";
    const at = text.indexOf("2 cups");
    const out = editStep(text, [{ charStart: at, charEnd: at + 6 }, { charStart: text.indexOf("2¾"), charEnd: text.indexOf("2¾") + 2 }], roastStepEdits(text, 242, 20));
    assert.equal(out.text, "Roast for about 4 hours, then baste with 2 cups broth.");
    assert.deepEqual(out.amountRefs, [{ charStart: out.text.indexOf("2 cups"), charEnd: out.text.indexOf("2 cups") + 6 }]);
  });
});

describe("THX-4 — the thaw follows the weight (call 5)", () => {
  it("⌈lb ÷ 4⌉ fridge days", () => {
    assert.deepEqual([8, 10, 12, 12.5, 14, 16, 16.5, 20].map(thawFridgeDays), [2, 3, 3, 4, 4, 4, 5, 5]);
  });

  it("counted back from the brine: Classic's Wednesday night, Make-Ahead's Tuesday night, else the feast day", () => {
    const at = (tags: string[], lb: number, texts: string[] = []) => weighedThaw({ tags, stepTexts: texts, feastDow: 4, lb });
    assert.deepEqual(at(["thaw-6d", "brine-wed"], 14), { daysBefore: 5, startDay: "Saturday", readyBy: "Wednesday night" });
    assert.deepEqual(at(["thaw-6d", "brine-wed"], 20), { daysBefore: 6, startDay: "Friday", readyBy: "Wednesday night" });
    assert.deepEqual(at(["thaw-6d", "brine-tue"], 14), { daysBefore: 6, startDay: "Friday", readyBy: "Tuesday night" });
    assert.deepEqual(at(["thaw-6d", "brine-tue"], 20), { daysBefore: 7, startDay: "Thursday", readyBy: "Tuesday night" });
    assert.deepEqual(at([], 12, ["Make ahead (Wednesday night): mix the brine."]), { daysBefore: 4, startDay: "Sunday", readyBy: "Wednesday night" });
    assert.deepEqual(at([], 12), { daysBefore: 3, startDay: "Monday", readyBy: "Thursday" });
  });

  it("the Hub's thaw row reads it for the weighed bird; the tag stays the default", () => {
    const feast = (bird?: { dishId: string; lb: number }) => buildMakeAheadSchedule({
      startDate: null,
      feast: { mealId: "m", assignedDayOfWeek: "Thursday", ...(bird ? { bird } : {}), dishes: [{ dishId: "t", dishName: "Turkey", tags: ["thaw-6d", "brine-wed"], stepTexts: [] }] },
    }).rows.find((r) => r.kind === "thaw");
    assert.deepEqual([feast()?.dayName, feast()?.thawDays], ["Friday", 6]);
    assert.deepEqual([feast({ dishId: "t", lb: 16 })?.dayName, feast({ dishId: "t", lb: 16 })?.thawDays], ["Saturday", 5]);
    assert.deepEqual([feast({ dishId: "t", lb: 20 })?.dayName, feast({ dishId: "t", lb: 20 })?.thawDays], ["Friday", 6]);
    assert.deepEqual([feast({ dishId: "other", lb: 20 })?.dayName], ["Friday"]);
  });

  it("the thaw step, code-written", () => {
    assert.equal(
      birdThawStepText({ birdWord: "turkey", lb: 16.5, startDay: "Friday", readyBy: "Wednesday night" }),
      "Thaw (start Friday): If the turkey is frozen, move it to the fridge on Friday — a 16½-lb bird takes about 5 days to thaw fully, so it is ready by Wednesday night.",
    );
  });
});

// SERVER-6 C — D-WS9-326 ruled: the step floor stays (a weight on a bracket edge belongs
// to the lower bracket, as FSIS lists "12 to 14 pounds"). What the ruling asks to hold:
// across the stepper's whole range, the roast never gets SHORTER for a heavier bird.
// server6Birds.json is every weighable Thanksgiving meal on dev (one per title): the
// bird's dish rows and its on-the-day steps, as stampMealTiming reads them.
describe("SERVER-6 — the roast never decreases with weight (D-WS9-326)", () => {
  type Fixture = Record<string, { tags: string[]; dish: { title: string; rows: { quantity: number; unit: string; name: string; note: string | null }[] }; daySteps: { stepIndex: number; estimatedMinutes: number; phaseType: string; text: string }[] }>;
  const birds = JSON.parse(readFileSync(new URL("./fixtures/server6Birds.json", import.meta.url), "utf8")) as Fixture;

  it("pins six meals: two Classics, two Make-Aheads, New Twist and the Buttermilk alternate", () => {
    assert.equal(Object.keys(birds).length, 6);
  });

  for (const [title, f] of Object.entries(birds)) {
    it(`${title}: 8 lb to the range's top in ½-lb steps, the roast and the main roast never fall`, () => {
      const bird = mealBirdOf({ tags: f.tags, dishes: [{ dishId: "d", title: f.dish.title, rows: f.dish.rows }] });
      assert.ok(bird, "a weighable turkey");
      let last = -Infinity;
      let lastMain = -Infinity;
      for (let lb = bird.range.min; lb <= bird.range.max + 1e-9; lb += bird.range.step) {
        const edit = birdRoastEdit(f.daySteps, bird, lb);
        assert.ok(edit, "the bird has an oven cook step");
        assert.ok(edit.cookMinutes >= last, `${lb} lb roasts ${edit.cookMinutes}, under ${last}`);
        assert.ok(edit.minutes >= lastMain, `${lb} lb main roast ${edit.minutes}, under ${lastMain}`);
        last = edit.cookMinutes;
        lastMain = edit.minutes;
      }
    });
  }
});

// SERVER-6 BUG-537 — the server half: the text a count bird is written with says the
// chosen weight (the meal screen's line is the client's; see the report's hand-off).
describe("SERVER-6 — BUG-537 a turkey by count says the chosen weight", () => {
  it("rewrites the weight in the name or the note; adds it to the name when only the note had it", () => {
    assert.deepEqual(birdLineAtWeight({ name: "whole turkey", note: "12–14 lb, neck and giblets removed" }, 16), { name: "whole turkey (16 lb)", note: "16 lb, neck and giblets removed" });
    assert.deepEqual(birdLineAtWeight({ name: "whole turkey (12–14 lb)", note: null }, 9.5), { name: "whole turkey (9½ lb)", note: null });
    assert.deepEqual(birdLineAtWeight({ name: "whole turkey (12 to 14 pounds)", note: "giblets removed" }, 14), { name: "whole turkey (14 lb)", note: "giblets removed" });
  });

  it("Prep the feast's note says it too (adapter); the dish still follows chosen ÷ the note's 14 lb", () => {
    const ing = (id: string, name: string, quantity: number, unit: string, preparationNote: string | null = null) => ({
      ingredientId: id, ingredientName: name, category: "Protein", quantity, unit, preparationNote, sourceYield: null,
    });
    const loaded = (bird: { dishId: string; lb: number } | undefined) => ({
      meals: [{
        mealId: "m", mealName: "Buttermilk", servingsOverride: null, feast: false, ...(bird ? { bird } : {}),
        dishes: [
          { dishId: "turkey", dishName: "Buttermilk-Brined Roast Turkey", dishRole: "main", baseServings: 10, authoredBaseServings: 10, stepTexts: [], componentSteps: [],
            ingredients: [ing("t", "whole turkey", 1, "each", "12–14 lb, neck and giblets removed and reserved"), ing("b", "buttermilk", 2, "quart")] },
        ],
      }],
    }) as unknown as PrepLoadedPlan;
    const row = (p: PrepLoadedPlan, id: string) => buildPrepCombineInput(p).meals[0].dishes[0].ingredients.find((i) => i.ingredientId === id)!;
    assert.equal(row(loaded({ dishId: "turkey", lb: 16 }), "t").preparationNote, "16 lb, neck and giblets removed and reserved");
    assert.equal(row(loaded({ dishId: "turkey", lb: 16 }), "t").quantity, 1);
    assert.ok(Math.abs(row(loaded({ dishId: "turkey", lb: 16 }), "b").quantity - 2 * (16 / 14)) < 1e-12);
    assert.equal(row(loaded(undefined), "t").preparationNote, "12–14 lb, neck and giblets removed and reserved");
  });
});
