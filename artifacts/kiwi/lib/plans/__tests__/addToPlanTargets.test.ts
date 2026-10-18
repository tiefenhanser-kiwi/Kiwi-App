// BOOK-1C1 (D-WS9-312) — "Add to a plan": live plans only, then the plan's days.
// BOOK-1C2 — "live" now includes undated plans (the + flow's own new plan).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { addToPlanTargets, isLivePlan, isUndatedPlan, livePlans, planDayOptions } from "../addToPlanTargets";

type P = { id: string; source: "instance" | "template"; startDate: string | null; endDate: string | null };
const plan = (id: string, startDate: string | null, endDate: string | null, source: P["source"] = "instance"): P => ({
  id,
  source,
  startDate,
  endDate,
});

const TODAY = "2026-10-14";

describe("live plans", () => {
  test("active (today inside) and upcoming are live; past, undated and templates are not", () => {
    assert.equal(isLivePlan(plan("active", "2026-10-11", "2026-10-17"), TODAY), true);
    assert.equal(isLivePlan(plan("ends-today", "2026-10-08", "2026-10-14"), TODAY), true);
    assert.equal(isLivePlan(plan("upcoming", "2026-10-18", "2026-10-24"), TODAY), true);
    assert.equal(isLivePlan(plan("past", "2026-10-01", "2026-10-13"), TODAY), false);
    assert.equal(isLivePlan(plan("undated", null, null), TODAY), false);
    assert.equal(isLivePlan(plan("tpl", "2026-10-18", "2026-10-24", "template"), TODAY), false);
  });

  test("soonest first: the active plan leads", () => {
    const out = livePlans(
      [
        plan("later", "2026-10-25", "2026-10-31"),
        plan("past", "2026-10-01", "2026-10-07"),
        plan("active", "2026-10-11", "2026-10-17"),
        plan("next", "2026-10-18", "2026-10-24"),
      ],
      TODAY,
    );
    assert.deepEqual(out.map((p) => p.id), ["active", "next", "later"]);
  });
});

describe("planDayOptions", () => {
  test("the plan's own days, in order, with weekday names the server takes", () => {
    const days = planDayOptions({ startDate: "2026-11-23", endDate: "2026-11-27" });
    assert.deepEqual(
      days.map((d) => d.day),
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    );
    assert.equal(days[3].label, "Thursday · Nov 26");
    assert.equal(days[0].date, "2026-11-23");
  });

  test("a plan longer than a week offers each weekday once (a weekday is all the wire can address)", () => {
    const days = planDayOptions({ startDate: "2026-11-01", endDate: "2026-11-14" });
    assert.equal(days.length, 7);
    assert.equal(new Set(days.map((d) => d.day)).size, 7);
    assert.equal(days[0].day, "Sunday");
  });

  test("a one-day plan, and an undated one", () => {
    assert.deepEqual(planDayOptions({ startDate: "2026-11-26", endDate: null }).map((d) => d.day), ["Thursday"]);
    // BOOK-1C2 — an undated plan is offered now, so its day step is the seven
    // weekday names, no dates (the wire takes a weekday name either way).
    const undated = planDayOptions({ startDate: null, endDate: null });
    assert.deepEqual(
      undated.map((d) => d.label),
      ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    );
    assert.ok(undated.every((d) => d.date === null && d.label === d.day));
  });
});

describe("addToPlanTargets (BOOK-1C2)", () => {
  // The dev row Hans could not find: POST /plans from the sheet's own "Create
  // a new plan", renamed — status draft, no dates.
  const justMade = { ...plan("c19c955c", null, null), status: "draft", name: "My plan this week 1016" };

  test("a plan just made from the + flow (draft, undated) is offered — and leads (FIX-5)", () => {
    const out = addToPlanTargets([justMade, plan("active", "2026-10-11", "2026-10-17")], TODAY);
    assert.deepEqual(out.map((p) => p.id), ["c19c955c", "active"]);
  });

  // FIX-5 — one list, newest added first. The input is GET /plans my_plans
  // order (createdAt DESC on the server); the targets keep it, dated and
  // undated interleaved, and drop only past plans and templates.
  test("FIX-5: one list in date-added order (newest first), undated plans in place; past plans and templates never", () => {
    const out = addToPlanTargets(
      [
        plan("undated-new", null, null),
        plan("later", "2026-10-25", "2026-10-31"),
        plan("past", "2026-10-01", "2026-10-07"),
        plan("undated-old", null, null),
        plan("active", "2026-10-11", "2026-10-17"),
        plan("tpl-undated", null, null, "template"),
        plan("tpl", "2026-10-18", "2026-10-24", "template"),
      ],
      TODAY,
    );
    assert.deepEqual(out.map((p) => p.id), ["undated-new", "later", "undated-old", "active"]);
  });

  test("FIX-5: the dates never re-sort it — an older upcoming plan stays below a newer active one and vice versa", () => {
    const out = addToPlanTargets(
      [
        plan("newest-far-future", "2026-12-01", "2026-12-07"),
        plan("middle-undated", null, null),
        plan("oldest-active", "2026-10-11", "2026-10-17"),
      ],
      TODAY,
    );
    assert.deepEqual(out.map((p) => p.id), ["newest-far-future", "middle-undated", "oldest-active"]);
  });

  test("status is not the rule: a dated draft that is upcoming is offered, a past 'upcoming' is not", () => {
    const out = addToPlanTargets(
      [
        { ...plan("draft-upcoming", "2026-10-16", "2026-10-20"), status: "draft" },
        { ...plan("stale-upcoming", "2026-09-01", "2026-09-07"), status: "upcoming" },
      ],
      TODAY,
    );
    assert.deepEqual(out.map((p) => p.id), ["draft-upcoming"]);
  });

  test("isUndatedPlan: an instance with neither date", () => {
    assert.equal(isUndatedPlan(plan("u", null, null)), true);
    assert.equal(isUndatedPlan(plan("d", "2026-10-16", null)), false);
    assert.equal(isUndatedPlan(plan("t", null, null, "template")), false);
  });
});
