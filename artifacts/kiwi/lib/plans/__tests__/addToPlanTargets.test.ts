// BOOK-1C1 (D-WS9-312) — "Add to a plan": live plans only, then the plan's days.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isLivePlan, livePlans, planDayOptions } from "../addToPlanTargets";

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
    assert.deepEqual(planDayOptions({ startDate: null, endDate: null }), []);
  });
});
