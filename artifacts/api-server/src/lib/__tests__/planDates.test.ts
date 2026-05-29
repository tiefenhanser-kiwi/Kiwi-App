// WS7-5b-mobile-PRE — unit tests for the shared currentWeekRange() helper.
// "This week" is Sun-Saturday per PRD §8; both PATCH /plans/:id auto-date
// and POST /api/wizard/drafts/:id/activate consume the helper, so the
// envelope tests in plans.test.ts and wizard.test.ts cover the wiring —
// these tests pin the helper's own semantics.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { currentWeekRange } from "../planDates";

describe("currentWeekRange — Sunday-Saturday calendar week (UTC)", () => {
  it("on a Sunday, startDate is that Sunday and endDate is the following Saturday", () => {
    // 2026-05-24 is a Sunday (UTC).
    const sun = new Date("2026-05-24T00:00:00.000Z");
    const r = currentWeekRange(sun);
    assert.equal(r.startDate, "2026-05-24");
    assert.equal(r.endDate, "2026-05-30");
  });

  it("on a mid-week day, startDate is the prior Sunday and endDate is the following Saturday", () => {
    // 2026-05-27 is a Wednesday (UTC).
    const wed = new Date("2026-05-27T12:00:00.000Z");
    const r = currentWeekRange(wed);
    assert.equal(r.startDate, "2026-05-24");
    assert.equal(r.endDate, "2026-05-30");
  });

  it("on a Saturday, endDate is that Saturday and startDate is the prior Sunday", () => {
    // 2026-05-30 is a Saturday (UTC).
    const sat = new Date("2026-05-30T23:00:00.000Z");
    const r = currentWeekRange(sat);
    assert.equal(r.startDate, "2026-05-24");
    assert.equal(r.endDate, "2026-05-30");
  });

  it("emits YYYY-MM-DD strings (not ISO 8601) symmetric with toYmd", () => {
    const r = currentWeekRange(new Date("2026-01-07T00:00:00.000Z"));
    // 2026-01-07 is a Wednesday; week is 2026-01-04 (Sun) … 2026-01-10 (Sat).
    assert.equal(r.startDate, "2026-01-04");
    assert.equal(r.endDate, "2026-01-10");
    // Format invariants — zero-padded month/day, no time component.
    assert.match(r.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.endDate, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("spans exactly 7 calendar days (Sun → Sat is +6)", () => {
    const r = currentWeekRange(new Date("2026-05-27T00:00:00.000Z"));
    const start = new Date(r.startDate);
    const end = new Date(r.endDate);
    const diffDays = (end.getTime() - start.getTime()) / 86_400_000;
    assert.equal(diffDays, 6);
  });

  it("handles month boundary (Sunday in one month, Saturday in next)", () => {
    // 2026-07-30 is a Thursday; week is 2026-07-26 (Sun) … 2026-08-01 (Sat).
    const r = currentWeekRange(new Date("2026-07-30T00:00:00.000Z"));
    assert.equal(r.startDate, "2026-07-26");
    assert.equal(r.endDate, "2026-08-01");
  });

  it("handles year boundary (Sunday in one year, Saturday in next)", () => {
    // 2026-12-30 is a Wednesday; week is 2026-12-27 (Sun) … 2027-01-02 (Sat).
    const r = currentWeekRange(new Date("2026-12-30T00:00:00.000Z"));
    assert.equal(r.startDate, "2026-12-27");
    assert.equal(r.endDate, "2027-01-02");
  });
});
