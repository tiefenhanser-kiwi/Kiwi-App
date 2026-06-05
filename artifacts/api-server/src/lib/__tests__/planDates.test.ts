// WS7-5b-mobile-PRE — unit tests for the shared currentWeekRange() helper.
// "This week" is Sun-Saturday per PRD §8; both PATCH /plans/:id auto-date
// and POST /api/wizard/drafts/:id/activate consume the helper, so the
// envelope tests in plans.test.ts and wizard.test.ts cover the wiring —
// these tests pin the helper's own semantics.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  currentWeekRange,
  didNewlyCoverNow,
  isInstanceActiveThisWeek,
} from "../planDates";

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

// WS7-6 (E) Block 1 — date-range predicate that replaces the dropped
// isActiveThisWeek column. The boolean still ships on the wire (decision
// #2); these tests pin the predicate's edge cases so the readers in
// plans.ts / home.ts / groceryLists.ts / planQueries.ts agree on
// semantics with the Postgres EXCLUDE constraint (`tsrange '[]'`).
describe("isInstanceActiveThisWeek — date-range predicate", () => {
  const NOW = new Date("2026-06-03T12:00:00.000Z");

  it("returns true when now is strictly inside the range", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: new Date("2026-05-31T00:00:00.000Z"),
          endDate: new Date("2026-06-06T00:00:00.000Z"),
        },
        NOW,
      ),
      true,
    );
  });

  it("returns true on the inclusive start edge", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        { startDate: NOW, endDate: new Date("2026-06-09T00:00:00.000Z") },
        NOW,
      ),
      true,
    );
  });

  it("returns true on the inclusive end edge", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        { startDate: new Date("2026-05-31T00:00:00.000Z"), endDate: NOW },
        NOW,
      ),
      true,
    );
  });

  it("returns false when now is before the range", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: new Date("2026-07-01T00:00:00.000Z"),
          endDate: new Date("2026-07-07T00:00:00.000Z"),
        },
        NOW,
      ),
      false,
    );
  });

  it("returns false when now is after the range", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: new Date("2026-05-01T00:00:00.000Z"),
          endDate: new Date("2026-05-07T00:00:00.000Z"),
        },
        NOW,
      ),
      false,
    );
  });

  it("returns false when startDate is null (null-dated plan)", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        { startDate: null, endDate: new Date("2026-06-09T00:00:00.000Z") },
        NOW,
      ),
      false,
    );
  });

  it("returns false when endDate is null (null-dated plan)", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        { startDate: new Date("2026-05-31T00:00:00.000Z"), endDate: null },
        NOW,
      ),
      false,
    );
  });

  it("returns false when both dates are null", () => {
    assert.equal(
      isInstanceActiveThisWeek({ startDate: null, endDate: null }, NOW),
      false,
    );
  });
});

describe("didNewlyCoverNow — re-pointed plan_activated_this_week trigger", () => {
  const NOW = new Date("2026-06-03T12:00:00.000Z");
  const covers = {
    startDate: new Date("2026-05-31T00:00:00.000Z"),
    endDate: new Date("2026-06-06T00:00:00.000Z"),
  };
  const past = {
    startDate: new Date("2026-05-01T00:00:00.000Z"),
    endDate: new Date("2026-05-07T00:00:00.000Z"),
  };
  const future = {
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-07T00:00:00.000Z"),
  };
  const undated = { startDate: null, endDate: null };

  it("undated → covers-now: fires", () => {
    assert.equal(didNewlyCoverNow(undated, covers, NOW), true);
  });

  it("past → covers-now: fires", () => {
    assert.equal(didNewlyCoverNow(past, covers, NOW), true);
  });

  it("future → covers-now: fires", () => {
    assert.equal(didNewlyCoverNow(future, covers, NOW), true);
  });

  it("covers-now → covers-now (same-state re-date): does NOT fire", () => {
    assert.equal(didNewlyCoverNow(covers, covers, NOW), false);
  });

  it("covers-now → past: silent demotion, does NOT fire", () => {
    assert.equal(didNewlyCoverNow(covers, past, NOW), false);
  });

  it("past → future (both non-covering): does NOT fire", () => {
    assert.equal(didNewlyCoverNow(past, future, NOW), false);
  });

  it("undated → undated: does NOT fire", () => {
    assert.equal(didNewlyCoverNow(undated, undated, NOW), false);
  });

  it("covers-now → undated: does NOT fire (silent demotion)", () => {
    assert.equal(didNewlyCoverNow(covers, undated, NOW), false);
  });
});
