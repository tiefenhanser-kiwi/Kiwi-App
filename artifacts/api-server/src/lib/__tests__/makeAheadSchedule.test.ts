// PREP-1 (D-WS9-314) — Part C: the make-ahead schedule, from dish tags and the
// plan's dates. Literal expected rows.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { brineHoursOf, buildMakeAheadSchedule, type MakeAheadDishInput } from "../makeAheadSchedule";

const FEAST = "22222222-2222-4222-8222-222222222222";
const d = (n: number, dishName: string, tags: string[], stepTexts: string[] = []): MakeAheadDishInput => ({
  dishId: `d${n}000000-0000-4000-8000-000000000000`, dishName, tags, stepTexts,
});
const id = (n: number) => `d${n}000000-0000-4000-8000-000000000000`;

// The Classic feast as THX-2G-E tags it, plus the stock Hans named.
const DISHES = [
  d(1, "Herb-Roasted Whole Turkey", ["thaw-5d", "brine-wed"], [
    "Pour the brine over the turkey, seal the bag tightly, and refrigerate — brine 12 to 24 hours, turning the bag halfway through.",
  ]),
  d(2, "Pan Gravy", []),
  d(3, "Sage and Onion Stuffing", ["ahead-wed", "keeps-2d"]),
  d(4, "Turkey Stock", ["ahead-tue", "keeps-4d"]),
  d(5, "Cranberry-Orange Sauce", ["ahead-mon", "keeps-7d"]),
  d(6, "Pumpkin Pie", ["ahead-wed", "keeps-3d"]),
];

describe("PREP-1 Part C — the make-ahead schedule", () => {
  it("a Monday-start plan, the feast on Thursday: literal rows, in day order", () => {
    const s = buildMakeAheadSchedule({
      startDate: new Date("2026-11-23T00:00:00Z"),
      feast: { mealId: FEAST, planItemId: "item-thu", assignedDayOfWeek: "Thursday", dishes: DISHES },
    });
    assert.deepEqual(s, {
      feastMealId: FEAST,
      feastPlanItemId: "item-thu",
      feastDayName: "Thursday",
      feastDate: "2026-11-26",
      rows: [
        { kind: "thaw", dayName: "Saturday", date: "2026-11-21", daysBefore: 5, mealId: FEAST, dishId: id(1), dishName: "Herb-Roasted Whole Turkey", thawDays: 5 },
        { kind: "make", dayName: "Monday", date: "2026-11-23", daysBefore: 3, mealId: FEAST, dishId: id(5), dishName: "Cranberry-Orange Sauce", keepsDays: 7 },
        { kind: "make", dayName: "Tuesday", date: "2026-11-24", daysBefore: 2, mealId: FEAST, dishId: id(4), dishName: "Turkey Stock", keepsDays: 4 },
        { kind: "make", dayName: "Wednesday", date: "2026-11-25", daysBefore: 1, mealId: FEAST, dishId: id(3), dishName: "Sage and Onion Stuffing", keepsDays: 2 },
        { kind: "make", dayName: "Wednesday", date: "2026-11-25", daysBefore: 1, mealId: FEAST, dishId: id(6), dishName: "Pumpkin Pie", keepsDays: 3 },
        { kind: "brine", dayName: "Wednesday", date: "2026-11-25", daysBefore: 1, mealId: FEAST, dishId: id(1), dishName: "Herb-Roasted Whole Turkey", brineHours: { min: 12, max: 24 } },
      ],
    });
  });

  it("the dates follow the plan: a Sunday start, and no start at all", () => {
    const sunday = buildMakeAheadSchedule({
      startDate: new Date("2026-11-22T00:00:00Z"),
      feast: { mealId: FEAST, assignedDayOfWeek: "Thursday", dishes: [DISHES[4]] },
    });
    assert.equal(sunday.feastDate, "2026-11-26");
    assert.deepEqual(sunday.rows.map((r) => [r.dayName, r.date]), [["Monday", "2026-11-23"]]);
    const undated = buildMakeAheadSchedule({ startDate: null, feast: { mealId: FEAST, assignedDayOfWeek: "Thursday", dishes: [DISHES[4]] } });
    assert.equal(undated.feastDate, null);
    assert.deepEqual(undated.rows.map((r) => [r.dayName, r.date]), [["Monday", null]]);
  });

  it("an unscheduled feast is Thursday — it is Thanksgiving", () => {
    const s = buildMakeAheadSchedule({ startDate: new Date("2026-11-23T00:00:00Z"), feast: { mealId: FEAST, assignedDayOfWeek: null, dishes: [DISHES[2]] } });
    assert.equal(s.feastDayName, "Thursday");
    assert.deepEqual(s.rows.map((r) => r.dayName), ["Wednesday"]);
  });

  it("no tags, no rows; a brine whose recipe states no hours has none", () => {
    assert.deepEqual(buildMakeAheadSchedule({ startDate: null, feast: { mealId: FEAST, assignedDayOfWeek: "Thursday", dishes: [DISHES[1]] } }).rows, []);
    const s = buildMakeAheadSchedule({ startDate: null, feast: { mealId: FEAST, assignedDayOfWeek: "Thursday", dishes: [d(7, "Turkey", ["brine-tue"], ["Brine the turkey overnight."])] } });
    assert.deepEqual(s.rows, [{ kind: "brine", dayName: "Tuesday", date: null, daysBefore: 2, mealId: FEAST, dishId: id(7), dishName: "Turkey" }]);
  });

  it("the brine's hours come only from a sentence that names the brine", () => {
    assert.deepEqual(brineHoursOf(["Brine for 8–12 hours in the fridge."]), { min: 8, max: 12 });
    // QA-1 B19 — THX-2G-F's two turkeys as stored, verbatim: the brine's own
    // "Make ahead (<Day> night):" steps. The dry brine never says "brine".
    assert.deepEqual(
      brineHoursOf([
        "Make ahead (Tuesday night): Mix ¼ cup kosher salt, 1 tablespoon black pepper, and 1 teaspoon baking powder in a small bowl.",
        "Make ahead (Tuesday night): Pat the turkey completely dry with paper towels — do not rinse it.",
        "Make ahead (Tuesday night): Rub the salt mixture all over the turkey, including under the breast skin and inside the cavity; set it uncovered on a rack in a roasting pan and refrigerate 36 to 48 hours.",
        "On Thursday: Remove the turkey from the fridge 1 hour before roasting to take the chill off; preheat the oven to 325°F.",
      ]),
      { min: 36, max: 48 },
    );
    assert.deepEqual(
      brineHoursOf([
        "Thaw (start Friday): If the turkey is frozen, transfer it to the fridge on Friday — a 14-lb bird takes 3–4 days to thaw fully, so it will be ready by Tuesday.",
        "Make ahead (Wednesday night): Dissolve ½ cup kosher salt and ¼ cup light brown sugar in 1 gallon cold water in a large brining bag set in a roasting pan or cooler.",
        "Make ahead (Wednesday night): Pat the turkey dry with paper towels, remove the neck and giblets (reserve for gravy), and submerge the bird in the brine, breast side down; seal the bag and refrigerate 12 to 24 hours, turning it once.",
        "On Thursday: Remove the turkey from the brine, discard the brine, and pat the bird very dry inside and out with paper towels; let it sit at room temperature for 1 hour.",
      ]),
      { min: 12, max: 24 },
    );
    // THX-2G-E's two turkeys, verbatim (the older phrasing, no night step).
    assert.deepEqual(
      brineHoursOf(["Place the turkey in a brining bag set in a roasting pan; pour the brine over it, seal, and refrigerate overnight (8 to 24 hours), turning the bag halfway through."]),
      { min: 8, max: 24 },
    );
    assert.deepEqual(
      brineHoursOf(["Pat the turkey completely dry with paper towels, then rub the dry brine all over — under the skin of the breast and thighs and on the back; place in a brining bag set in a roasting pan and refrigerate uncovered 48 hours, turning once half"]),
      { min: 48, max: 48 },
    );
    assert.equal(brineHoursOf(["Roast 3 to 4 hours. Pour the hot brine over the onions."]), undefined);
  });
});
