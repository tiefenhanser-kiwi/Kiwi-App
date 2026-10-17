// PREP-1 (D-WS9-314) — the Hub's "Thanksgiving make-ahead" card and the Prep the
// Week session copy, as pure models.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MakeAheadSchema, PlanDetailSchema, type MakeAhead } from "@/lib/api/plans";
import {
  buildMakeAheadCard,
  FEAST_HAS_OWN_PREP_LINE,
  localIsoDate,
  makeAheadDishRoute,
  prepSessionCopy,
  shortDate,
} from "@/lib/cooking/makeAheadModel";

const FEAST = "22222222-2222-4222-8222-222222222222";
// The server's literal rows for the Classic feast (api-server makeAheadSchedule.test.ts).
const SCHEDULE: MakeAhead = {
  feastMealId: FEAST,
  feastDayName: "Thursday",
  feastDate: "2026-11-26",
  rows: [
    { kind: "thaw", dayName: "Saturday", date: "2026-11-21", daysBefore: 5, mealId: FEAST, dishId: "d1", dishName: "Herb-Roasted Whole Turkey", thawDays: 5 },
    { kind: "make", dayName: "Monday", date: "2026-11-23", daysBefore: 3, mealId: FEAST, dishId: "d5", dishName: "Cranberry-Orange Sauce", keepsDays: 7 },
    { kind: "make", dayName: "Tuesday", date: "2026-11-24", daysBefore: 2, mealId: FEAST, dishId: "d4", dishName: "Turkey Stock", keepsDays: 4 },
    { kind: "make", dayName: "Wednesday", date: "2026-11-25", daysBefore: 1, mealId: FEAST, dishId: "d3", dishName: "Sage and Onion Stuffing", keepsDays: 2 },
    { kind: "make", dayName: "Wednesday", date: "2026-11-25", daysBefore: 1, mealId: FEAST, dishId: "d6", dishName: "Pumpkin Pie" },
    { kind: "brine", dayName: "Wednesday", date: "2026-11-25", daysBefore: 1, mealId: FEAST, dishId: "d1", dishName: "Herb-Roasted Whole Turkey", brineHours: { min: 12, max: 24 } },
  ],
};

describe("PREP-1 — the make-ahead card", () => {
  it("groups by day, the brine on its own night, with the words for each row", () => {
    const card = buildMakeAheadCard(SCHEDULE);
    assert.equal(card.title, "Thanksgiving make-ahead");
    assert.equal(card.feastLine, "Thanksgiving is Thursday, Nov 26.");
    assert.equal(card.emptyLine, null);
    assert.deepEqual(
      card.days.map((d) => [d.label, d.rows.map((r) => `${r.title} — ${r.note}`)]),
      [
        ["Saturday · Nov 21", ["Herb-Roasted Whole Turkey — Into the fridge to thaw — 5 days before"]],
        ["Monday · Nov 23", ["Cranberry-Orange Sauce — Make ahead · keeps 7 days"]],
        ["Tuesday · Nov 24", ["Turkey Stock — Make ahead · keeps 4 days"]],
        ["Wednesday · Nov 25", ["Sage and Onion Stuffing — Make ahead · keeps 2 days", "Pumpkin Pie — Make ahead"]],
        ["Wednesday night · Nov 25", ["Herb-Roasted Whole Turkey — Into the brine · hands-off 12–24 h"]],
      ],
    );
    // Each row links to its dish's recipe.
    assert.deepEqual(card.days[0].rows[0].dishId, "d1");
  });

  it("an undated plan names the weekday only; a feast with no tagged dish is just the button", () => {
    const undated = buildMakeAheadCard({ ...SCHEDULE, feastDate: null, rows: SCHEDULE.rows.slice(1, 2).map((r) => ({ ...r, date: null })) });
    assert.equal(undated.feastLine, "Thanksgiving is Thursday.");
    assert.deepEqual(undated.days.map((d) => d.label), ["Monday"]);
    const empty = buildMakeAheadCard({ ...SCHEDULE, rows: [] });
    assert.deepEqual(empty.days, []);
    assert.ok(empty.emptyLine);
  });

  it("a dry brine's one figure reads as one figure", () => {
    const card = buildMakeAheadCard({ ...SCHEDULE, rows: [{ ...SCHEDULE.rows[5], brineHours: { min: 48, max: 48 } }] });
    assert.equal(card.days[0].rows[0].note, "Into the brine · hands-off 48 h");
  });

  it("shortDate reads a calendar date without a time zone", () => {
    assert.equal(shortDate("2026-11-01"), "Nov 1");
    assert.equal(shortDate("2026-12-31"), "Dec 31");
    assert.equal(shortDate("not a date"), null);
  });

  it("the wire mirror: makeAhead is optional on the plan, and parses the server's rows", () => {
    assert.ok(MakeAheadSchema.safeParse(SCHEDULE).success);
    const shape = PlanDetailSchema.shape.makeAhead;
    assert.ok(shape.safeParse(undefined).success);
  });
});

describe("PREP-2 item 1 — the timeline against today", () => {
  const view = (todayIso: string | null) => {
    const c = buildMakeAheadCard(SCHEDULE, null, todayIso);
    return {
      done: c.doneDays.map((d) => d.label),
      line: c.doneDaysLine,
      days: c.days.map((d) => `${d.highlight ? `${d.highlight}: ` : ""}${d.label} [${d.when}]`),
    };
  };

  it("Tuesday: Saturday and Monday are done, Tuesday is today, the rest are coming", () => {
    assert.deepEqual(view("2026-11-24"), {
      done: ["Saturday · Nov 21", "Monday · Nov 23"],
      line: "Done days (2)",
      days: [
        "Today: Tuesday · Nov 24 [current]",
        "Wednesday · Nov 25 [upcoming]",
        "Wednesday night · Nov 25 [upcoming]",
      ],
    });
  });

  it("a day with no work (Sunday): the next day is highlighted as Next", () => {
    assert.deepEqual(view("2026-11-22"), {
      done: ["Saturday · Nov 21"],
      line: "Done days (1)",
      days: ["Next: Monday · Nov 23 [current]", "Tuesday · Nov 24 [upcoming]", "Wednesday · Nov 25 [upcoming]", "Wednesday night · Nov 25 [upcoming]"],
    });
  });

  it("Wednesday: the day and its night light up together", () => {
    assert.deepEqual(view("2026-11-25").days, ["Today: Wednesday · Nov 25 [current]", "Today: Wednesday night · Nov 25 [current]"]);
  });

  it("after the feast every day is done; no date (or no plan dates) folds nothing", () => {
    const after = buildMakeAheadCard(SCHEDULE, null, "2026-11-27");
    assert.equal(after.days.length, 0);
    assert.equal(after.doneDaysLine, "Done days (5)");
    assert.deepEqual(view(null), {
      done: [],
      line: null,
      days: ["Saturday · Nov 21 [upcoming]", "Monday · Nov 23 [upcoming]", "Tuesday · Nov 24 [upcoming]", "Wednesday · Nov 25 [upcoming]", "Wednesday night · Nov 25 [upcoming]"],
    });
    const undated = buildMakeAheadCard({ ...SCHEDULE, rows: SCHEDULE.rows.map((r) => ({ ...r, date: null })) }, null, "2026-11-24");
    assert.equal(undated.doneDays.length, 0);
    assert.ok(undated.days.every((d) => d.when === "upcoming" && d.highlight === null));
  });

  it("an `assemble` dish reads 'Assemble ahead · bake <feast day>'; others keep their days", () => {
    const rows = [
      { ...SCHEDULE.rows[3], dishName: "Green Bean Casserole", assemble: true as const, keepsDays: 1 },
      SCHEDULE.rows[3],
    ];
    const card = buildMakeAheadCard({ ...SCHEDULE, rows });
    assert.deepEqual(card.days[0].rows.map((r) => r.note), ["Assemble ahead · bake Thursday", "Make ahead · keeps 2 days"]);
    assert.ok(MakeAheadSchema.safeParse({ ...SCHEDULE, rows }).success);
  });

  it("localIsoDate is the phone's calendar date", () => {
    assert.equal(localIsoDate(new Date(2026, 10, 5, 23, 59)), "2026-11-05");
  });
});

describe("PREP-1 — the session copy on Prep the Week", () => {
  it("the feast session is 'Prep the feast', labelled with its day", () => {
    assert.deepEqual(prepSessionCopy({ session: "feast", isSubset: false, sessionDay: "Wednesday", planHasFeast: true }), {
      title: "Prep the feast",
      notice: "For Wednesday, the day before the feast.",
    });
  });
  it("the week says where the feast's prep went, and only when the plan has a feast", () => {
    assert.deepEqual(prepSessionCopy({ isSubset: false, planHasFeast: true }), { title: "Prep the Week", notice: FEAST_HAS_OWN_PREP_LINE });
    assert.deepEqual(prepSessionCopy({ isSubset: false, planHasFeast: false }), { title: "Prep the Week", notice: null });
    assert.equal(prepSessionCopy({ isSubset: true, planHasFeast: true }).title, "Prep Selected Meals");
  });
});

// PREP-2 item 2 replaces PREP-1 F's route (the feast MEAL) with the DISH, read out of
// the feast meal in plan context so it still scales to the plan's servings.
describe("PREP-2 item 2 — a make-ahead row opens its DISH, in the feast's plan context", () => {
  const PLAN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  it("the route is the row's dish, carrying the feast meal, the plan item and the row's day", () => {
    const card = buildMakeAheadCard({ ...SCHEDULE, feastPlanItemId: "item-thu" });
    assert.deepEqual(makeAheadDishRoute(PLAN, card.days[1].rows[0]), {
      pathname: "/dish/[id]",
      params: { id: "d5", mealId: FEAST, run: "make:Monday", planId: PLAN, planItemId: "item-thu" },
    });
    // The brine is its day's night; the thaw is its own kind.
    const brine = card.days[4].rows[0];
    assert.equal(makeAheadDishRoute(PLAN, brine).params.run, "brine:Wednesday");
    assert.equal(makeAheadDishRoute(PLAN, card.days[0].rows[0]).params.run, "thaw:Saturday");
  });
  it("an older server without the plan item: the Hub's own lookup fills it; with neither, the feast meal at its own servings", () => {
    const fromItems = buildMakeAheadCard(SCHEDULE, "item-from-plan");
    assert.equal(fromItems.days[0].rows[0].planItemId, "item-from-plan");
    assert.deepEqual(makeAheadDishRoute(PLAN, buildMakeAheadCard(SCHEDULE).days[0].rows[0]), {
      pathname: "/dish/[id]",
      params: { id: "d1", mealId: FEAST, run: "thaw:Saturday" },
    });
  });
});
