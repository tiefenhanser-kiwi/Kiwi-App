// WS9 Redesign Arc post-pass Part D ([WS9-arc-PS-D]) — the deterministic
// picks-plan name: format + fallback pinned.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatWeekOfDate, picksPlanTitle, UNNAMED_PICKS_TITLE } from "../planTitle";

describe("picksPlanTitle", () => {
  it("'{first name}'s meals, week of {start}' — short month + UTC day", () => {
    assert.equal(picksPlanTitle("Hans", new Date("2026-09-16T00:00:00Z")), "Hans's meals, week of Sep 16");
    assert.equal(picksPlanTitle(" Ana ", new Date("2027-01-03T00:00:00Z")), "Ana's meals, week of Jan 3");
  });
  it("no stored name (null / empty / blank) → 'Meals for the week of {start}'", () => {
    for (const n of [null, undefined, "", "   "]) {
      assert.equal(picksPlanTitle(n, new Date("2026-12-30T00:00:00Z")), "Meals for the week of Dec 30");
    }
  });
  it("reads the UTC calendar day (a UTC-midnight plan date never rolls back a day)", () => {
    assert.equal(formatWeekOfDate(new Date("2026-10-01T00:00:00Z")), "Oct 1");
  });
  it("the client's sentinel is the Pick screen's constant", () => {
    assert.equal(UNNAMED_PICKS_TITLE, "Your picks");
  });
});
