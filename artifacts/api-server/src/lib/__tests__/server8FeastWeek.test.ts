// SERVER-8 A (BUG-567) — Thanksgiving dates for any feast day. A day the recipe names
// is its offset in the authored Thursday plan, said as the weekday that offset lands on;
// "On Thursday:" is the feast-day token and stays (D-WS9-351); a Thursday feast is the
// identity.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { applyFeastWeekToRead, authoredLeadDays, feastWeekTag, feastWeekText, FEAST_DAY_TOKEN } from "../feastWeek";
import { buildMakeAheadSchedule, weighedThaw, type MakeAheadDishInput } from "../makeAheadSchedule";
import { onTheDaySteps } from "../mealTiming";
import { loadPrepWeekInput } from "../prepWeekAggregation";

const SUN = 0, WED = 3, THU = 4, FRI = 5, SAT = 6;

// The catalog's day words (the census of dev's 116 feast meals), verbatim up to a clause.
const TEXTS = [
  "On Thursday: Remove the turkey from the brine, discard the brine, and pat the turkey thoroughly dry.",
  "Make ahead (Wednesday night): pour the brine over the turkey and refrigerate 12 to 24 hours.",
  "Make ahead (Monday): cook, stirring occasionally; cover and refrigerate until Thursday.",
  "Thaw (start Friday): If the turkey is frozen, move it to the fridge on Friday so it is fully thawed by Wednesday.",
  "Chill at least 4 hours — refrigerate overnight and pull it out Thursday morning.",
  "Bring to room temperature on Thursday. Thursday is for the oven.",
  "a 14-lb bird takes about 4 days to thaw fully before Wednesday's brine.",
];

describe("SERVER-8 A — feastWeek: the authored week said for the feast's", () => {
  it("a Thursday feast is the identity, byte for byte, whichever way the token is read", () => {
    for (const t of TEXTS) {
      assert.equal(feastWeekText(t, THU, "keep"), t);
      assert.equal(feastWeekText(t, THU, "weekday"), t);
    }
    assert.equal(feastWeekTag("ahead-wed", THU), "ahead-wed");
  });

  it("a Saturday feast: every weekday moves two days on, the feast is 'feast day', the token stays", () => {
    assert.deepEqual(TEXTS.map((t) => feastWeekText(t, SAT, "keep")), [
      "On Thursday: Remove the turkey from the brine, discard the brine, and pat the turkey thoroughly dry.",
      "Make ahead (Friday night): pour the brine over the turkey and refrigerate 12 to 24 hours.",
      "Make ahead (Wednesday): cook, stirring occasionally; cover and refrigerate until feast day.",
      "Thaw (start Sunday): If the turkey is frozen, move it to the fridge on Sunday so it is fully thawed by Friday.",
      "Chill at least 4 hours — refrigerate overnight and pull it out the morning of the feast.",
      "Bring to room temperature on feast day. Feast day is for the oven.",
      "a 14-lb bird takes about 4 days to thaw fully before Friday's brine.",
    ]);
    assert.equal(FEAST_DAY_TOKEN, "On Thursday:");
  });

  it("the server's own readers get the token as the feast's weekday (prepFeastClose stepDayOf)", () => {
    assert.equal(feastWeekText(TEXTS[0], SAT, "weekday"), "On Saturday: Remove the turkey from the brine, discard the brine, and pat the turkey thoroughly dry.");
    assert.equal(feastWeekText(TEXTS[0], SUN, "weekday").slice(0, 10), "On Sunday:");
  });

  it("a Wednesday and a Sunday feast: the brine is the night before, a make day may land on Thursday", () => {
    assert.equal(feastWeekText(TEXTS[1], WED, "keep"), "Make ahead (Tuesday night): pour the brine over the turkey and refrigerate 12 to 24 hours.");
    assert.equal(feastWeekText(TEXTS[2], SUN, "keep"), "Make ahead (Thursday): cook, stirring occasionally; cover and refrigerate until feast day.");
    assert.equal(feastWeekTag("brine-wed", WED), "brine-tue");
    assert.equal(feastWeekTag("ahead-mon", SUN), "ahead-thu");
    assert.equal(feastWeekTag("keeps-4d", SUN), "keeps-4d");
  });

  // Not yet in the shared list (CLIENT-6's feastDayVectors.mts): the rotation is what makes it.
  it("a Sunday feast's 'Make ahead (Thursday):' is a make day, never the feast-day token", () => {
    const steps = [TEXTS[2], "Cook 12 minutes.", TEXTS[0]].map((t) => ({ text: feastWeekText(t, SUN, "keep") }));
    assert.equal(steps[0].text.slice(0, 22), "Make ahead (Thursday):");
    assert.deepEqual(onTheDaySteps(steps).map((s) => steps.indexOf(s)), [2]);
  });

  it("an authored weekday's lead is its Thursday plan's: Wednesday 1, Monday 3, Friday 6", () => {
    assert.deepEqual([3, 2, 1, 5, 6].map(authoredLeadDays), [1, 2, 3, 6, 5]);
  });
});

// The two feasts QA-7 tabled, by their tags (dev's Classic and Make-Ahead).
const dish = (dishId: string, dishName: string, tags: string[], stepTexts: string[] = []): MakeAheadDishInput => ({ dishId, dishName, tags, stepTexts });
const CLASSIC = [
  dish("turkey", "Herb-Roasted Whole Turkey", ["thaw-6d", "brine-wed"], ["Make ahead (Wednesday night): pour the brine over the turkey and refrigerate 12 to 24 hours."]),
  dish("cran", "Cranberry-Orange Sauce", ["ahead-mon", "keeps-4d"]),
  dish("gravy", "Pan Gravy", ["ahead-tue", "keeps-2d"]),
  dish("stuffing", "Sage and Onion Stuffing", ["ahead-wed", "keeps-1d", "assemble"]),
  dish("beans", "Green Bean Casserole", ["ahead-wed", "keeps-1d", "assemble"]),
  dish("pie", "Pumpkin Pie", ["ahead-wed", "keeps-4d"]),
];
const MAKE_AHEAD = [
  dish("turkey", "Dry-Brined Roast Turkey", ["thaw-6d", "brine-tue"]),
  dish("cran", "Cranberry-Orange Sauce", ["ahead-mon", "keeps-4d"]),
  dish("gravy", "Make-Ahead Turkey Gravy", ["ahead-tue", "keeps-2d"]),
  dish("stuffing", "Overnight Sage Stuffing", ["ahead-tue", "ahead-wed", "keeps-1d", "assemble"]),
  dish("mash", "Mashed Potato Casserole", ["ahead-wed", "keeps-1d", "assemble"]),
];
const DAY_DATE: Record<string, string> = { Sunday: "2026-11-22", Wednesday: "2026-11-25", Thursday: "2026-11-26", Friday: "2026-11-27", Saturday: "2026-11-28" };
const schedule = (dishes: MakeAheadDishInput[], day: string, bird = true) =>
  buildMakeAheadSchedule({
    startDate: new Date("2026-11-22T00:00:00.000Z"),
    feast: { mealId: "m", assignedDayOfWeek: day, dishes, ...(bird ? { bird: { dishId: "turkey", lb: 14 } } : {}) },
  });
const rowsOf = (s: ReturnType<typeof schedule>) => s.rows.map((r) => `${r.kind} ${r.dishId} ${r.daysBefore}d ${r.dayName} ${r.date}`);

describe("SERVER-8 A — the Hub's make-ahead rows on any feast day", () => {
  it("Thursday: exactly the rows it had (QA-7's Thursday column)", () => {
    assert.deepEqual(rowsOf(schedule(CLASSIC, "Thursday")), [
      "thaw turkey 5d Saturday 2026-11-21",
      "make cran 3d Monday 2026-11-23",
      "make gravy 2d Tuesday 2026-11-24",
      "make stuffing 1d Wednesday 2026-11-25",
      "make beans 1d Wednesday 2026-11-25",
      "make pie 1d Wednesday 2026-11-25",
      "brine turkey 1d Wednesday 2026-11-25",
    ]);
  });

  it("Wednesday: nothing a week early — the brine is Tuesday night and the thaw counts back from it", () => {
    assert.deepEqual(rowsOf(schedule(CLASSIC, "Wednesday")), [
      "thaw turkey 5d Friday 2026-11-20",
      "make cran 3d Sunday 2026-11-22",
      "make gravy 2d Monday 2026-11-23",
      "make stuffing 1d Tuesday 2026-11-24",
      "make beans 1d Tuesday 2026-11-24",
      "make pie 1d Tuesday 2026-11-24",
      "brine turkey 1d Tuesday 2026-11-24",
    ]);
  });

  it("Saturday: the 1-day casseroles the day before, the gravy 2 days out, the brine Friday night", () => {
    assert.deepEqual(rowsOf(schedule(CLASSIC, "Saturday")), [
      "thaw turkey 5d Monday 2026-11-23",
      "make cran 3d Wednesday 2026-11-25",
      "make gravy 2d Thursday 2026-11-26",
      "make stuffing 1d Friday 2026-11-27",
      "make beans 1d Friday 2026-11-27",
      "make pie 1d Friday 2026-11-27",
      "brine turkey 1d Friday 2026-11-27",
    ]);
  });

  it("Make-Ahead's stuffing dries its bread the day before it is assembled, on every feast day", () => {
    for (const day of ["Sunday", "Wednesday", "Thursday", "Friday", "Saturday"]) {
      const rows = schedule(MAKE_AHEAD, day).rows.filter((r) => r.dishId === "stuffing");
      assert.deepEqual(rows.map((r) => r.daysBefore), [2, 1], day);
      assert.ok(rows[0].date! < rows[1].date!, day);
      assert.equal(rows[1].keepsDays, 1);
    }
  });

  it("every feast day: the authored offsets, every keep window held, and every row before the feast", () => {
    for (const dishes of [CLASSIC, MAKE_AHEAD]) {
      const thursday = schedule(dishes, "Thursday").rows.map((r) => `${r.kind} ${r.dishId} ${r.daysBefore}`);
      for (const day of ["Sunday", "Wednesday", "Friday", "Saturday"]) {
        const s = schedule(dishes, day);
        assert.deepEqual(s.rows.map((r) => `${r.kind} ${r.dishId} ${r.daysBefore}`), thursday, day);
        assert.equal(s.feastDate, DAY_DATE[day]);
        for (const r of s.rows) {
          if (r.keepsDays !== undefined) assert.ok(r.daysBefore <= r.keepsDays, `${day} ${r.dishName} made ${r.daysBefore}d out keeps ${r.keepsDays}d`);
          assert.ok(r.date! < s.feastDate!, `${day} ${r.dishName}`);
        }
      }
    }
  });

  it("the tag thaw (no bird) and a step-named day move the same way", () => {
    const small = [dish("breast", "Roast Turkey Breast", ["thaw-2d"]), dish("crisp", "Apple Crisp", [], ["Make ahead (Wednesday): assemble the crisp.", "On Thursday: bake."])];
    assert.deepEqual(rowsOf(schedule(small, "Saturday", false)), ["thaw breast 2d Thursday 2026-11-26", "make crisp 1d Friday 2026-11-27"]);
  });
});

describe("SERVER-8 A — the weighed thaw counts back from the recipe's brine, in the feast's week", () => {
  const args = (feastDow: number) => ({ tags: ["thaw-6d", "brine-wed"], stepTexts: [], feastDow, lb: 14 });
  it("Thursday: Saturday, ready by Wednesday night (as before)", () => {
    assert.deepEqual(weighedThaw(args(THU)), { daysBefore: 5, startDay: "Saturday", readyBy: "Wednesday night" });
  });
  it("Saturday: Monday, ready by Friday night; Wednesday: Friday, ready by Tuesday night", () => {
    assert.deepEqual(weighedThaw(args(SAT)), { daysBefore: 5, startDay: "Monday", readyBy: "Friday night" });
    assert.deepEqual(weighedThaw(args(WED)), { daysBefore: 5, startDay: "Friday", readyBy: "Tuesday night" });
    assert.deepEqual(weighedThaw({ ...args(FRI), tags: ["thaw-6d", "brine-tue"] }), { daysBefore: 6, startDay: "Saturday", readyBy: "Wednesday night" });
  });
});

describe("SERVER-8 A — the meal read in its plan", () => {
  const read = () => ({
    dishes: [{
      steps: [
        // "Wednesday" → "Friday" is 3 characters shorter: the ref after it moves with it.
        { text: "Make ahead (Wednesday night): stir 1 gallon cold water into the brine.", amountRefs: [{ ingredientId: "w", quantity: 1, unit: "gallon", charStart: 35, charEnd: 43 }], unmatchedAmount: false },
        { text: "On Thursday: Remove the turkey from the brine.", amountRefs: null, unmatchedAmount: false },
      ],
      ingredients: [{ preparationNote: "reserved from turkey; used Tuesday to simmer stock" }, { preparationNote: null }],
    }],
  });

  it("a Saturday feast: steps and notes in its week, the token kept, every ref on its words", () => {
    const meal = read();
    applyFeastWeekToRead(meal, "Saturday");
    const [brine, day] = meal.dishes[0].steps;
    assert.equal(brine.text, "Make ahead (Friday night): stir 1 gallon cold water into the brine.");
    assert.equal(brine.text.slice(brine.amountRefs![0].charStart, brine.amountRefs![0].charEnd), "1 gallon");
    assert.equal(brine.unmatchedAmount, false);
    assert.equal(day.text, "On Thursday: Remove the turkey from the brine.");
    assert.equal(meal.dishes[0].ingredients[0].preparationNote, "reserved from turkey; used Thursday to simmer stock");
  });

  it("a Thursday feast, and an unscheduled one, are untouched", () => {
    for (const day of ["Thursday", null]) {
      const meal = read();
      applyFeastWeekToRead(meal, day);
      assert.deepEqual(meal, read());
    }
  });
});

describe("SERVER-8 A — Prep the feast loads the feast in its own week", () => {
  const stub = (day: string) => ({
    mealPlanInstance: {
      findUnique: async () => ({
        id: "p", userId: "u", revisionId: 1, titleOverride: null, startDate: null,
        items: [{
          id: "i", mealId: "m", positionIndex: 0, servingsOverride: null, assignedDayOfWeek: day, birdWeightLb: null,
          meal: {
            id: "m", title: "Feast", cuisineType: null, servingsDefault: 4, tags: ["thanksgiving-feast"],
            dishLinks: [{
              dishId: "d", positionIndex: 0, roleLabel: null,
              dish: {
                id: "d", title: "Pan Gravy", servingsDefault: 4, authoredServingsDefault: 4, tags: ["ahead-tue", "keeps-2d"],
                dishIngredients: [{ quantity: 1, unit: "each", preparationNote: "reserved from turkey; used Tuesday to simmer stock", positionIndex: 0, ingredient: { id: "neck", displayName: "turkey neck", category: "Meat" } }],
              },
            }],
          },
        }],
      }),
    },
    recipeInstructionStep: {
      findMany: async ({ where }: { where: { ownerType: string } }) =>
        where.ownerType !== "dish" ? [] : [
          { ownerId: "d", stepIndex: 0, stepTextRaw: "Make ahead (Tuesday): simmer the neck.", stepTextTranslated: "Make ahead (Tuesday): simmer the neck.", componentKey: null, pathKey: null, amountRefs: null, phaseType: "cook" },
          { ownerId: "d", stepIndex: 1, stepTextRaw: "On Thursday: whisk in the drippings.", stepTextTranslated: "On Thursday: whisk in the drippings.", componentKey: null, pathKey: null, amountRefs: null, phaseType: "cook" },
        ],
    },
    ingredientRelation: { findMany: async () => [] },
  }) as unknown as PrismaClient;
  const loaded = async (day: string) => (await loadPrepWeekInput({ planId: "p", userId: "u", prisma: stub(day), now: new Date("2026-11-20T12:00:00Z") })).input.meals[0].dishes[0];

  it("Saturday: the make day is Thursday, the token names Saturday, the note says Thursday", async () => {
    const d = await loaded("Saturday");
    assert.deepEqual(d.makeAheadDays, ["thu"]);
    assert.deepEqual(d.componentSteps.map((s) => s.text), ["Make ahead (Thursday): simmer the neck.", "On Saturday: whisk in the drippings."]);
    assert.deepEqual(d.stepTexts, ["Make ahead (Thursday): simmer the neck.", "On Saturday: whisk in the drippings."]);
    assert.equal(d.ingredients[0].preparationNote, "reserved from turkey; used Thursday to simmer stock");
  });

  it("Thursday: the stored words and tags, unchanged", async () => {
    const d = await loaded("Thursday");
    assert.deepEqual(d.makeAheadDays, ["tue"]);
    assert.deepEqual(d.componentSteps.map((s) => s.text), ["Make ahead (Tuesday): simmer the neck.", "On Thursday: whisk in the drippings."]);
    assert.equal(d.ingredients[0].preparationNote, "reserved from turkey; used Tuesday to simmer stock");
  });
});
