// LIFE-1 — the lifecycle schedule, by clock. Pure: no database, no sender.
//
// Each email: not due before its time, due inside its window, not due after
// it. Then each skip rule (Day 1 with a plan; the free-time pair for a paying
// account and with billing not enforced), once-only (the send log), the
// opt-out, quiet hours, and how the November 2 date is formatted.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dueKinds,
  isQuietHour,
  formatEndDate,
  type LifecycleFacts,
} from "../lifecycle/schedule";

const H = 60 * 60 * 1000;
// Tuesday 2026-10-20 14:00 New York (18:00Z): inside sending hours.
const SIGNUP = new Date("2026-10-20T18:00:00Z");
// The D-WS9-310 / BUG-404 free-time end: 2026-11-02 23:59:59 America/New_York.
const NOV_2_END = new Date("2026-11-03T04:59:59Z");

function facts(over: Partial<LifecycleFacts> = {}): LifecycleFacts {
  return {
    createdAt: SIGNUP,
    timezone: "America/New_York",
    optedOut: false,
    hasPlan: false,
    freeTimeEndsAt: null,
    paying: false,
    billingEnforced: true,
    sent: new Set(),
    ...over,
  };
}
const at = (offsetH: number, base = SIGNUP) => new Date(base.getTime() + offsetH * H);

describe("LIFE-1 schedule — the four signup emails", () => {
  it("welcome: due at signup, still due at 23 h, gone at 24 h", () => {
    assert.deepEqual(dueKinds(facts(), at(0)), ["welcome"]);
    assert.deepEqual(dueKinds(facts(), at(23)), ["welcome"]);
    assert.deepEqual(dueKinds(facts({ sent: new Set(["welcome"]) }), at(23)), []);
    assert.ok(!dueKinds(facts(), at(24)).includes("welcome"));
  });

  it("day1: not at 23 h, due at 24 h, still at 47 h, gone at 48 h", () => {
    const sent = new Set(["welcome"]);
    assert.deepEqual(dueKinds(facts({ sent }), at(23)), []);
    assert.deepEqual(dueKinds(facts({ sent }), at(24)), ["day1"]);
    assert.deepEqual(dueKinds(facts({ sent }), at(47)), ["day1"]);
    assert.deepEqual(dueKinds(facts({ sent }), at(48)), []);
  });

  it("day3: not at 71 h, due at 72 h, gone at 96 h", () => {
    const sent = new Set(["welcome", "day1"]);
    assert.deepEqual(dueKinds(facts({ sent }), at(71)), []);
    assert.deepEqual(dueKinds(facts({ sent }), at(72)), ["day3"]);
    assert.deepEqual(dueKinds(facts({ sent }), at(96)), []);
  });

  it("day5: not at 119 h, due at 120 h, gone at 144 h", () => {
    const sent = new Set(["welcome", "day1", "day3"]);
    assert.deepEqual(dueKinds(facts({ sent }), at(119)), []);
    assert.deepEqual(dueKinds(facts({ sent }), at(120)), ["day5"]);
    assert.deepEqual(dueKinds(facts({ sent }), at(144)), []);
  });

  it("🔴 an account weeks old is due NOTHING — the first production tick sends no backlog", () => {
    assert.deepEqual(dueKinds(facts(), at(24 * 30)), []);
  });

  it("an unsent earlier email does not block a later one (a missed day1 does not hold day3)", () => {
    assert.deepEqual(dueKinds(facts({ sent: new Set(["welcome"]) }), at(90)), ["day3"]); // 08:00 EDT
  });
});

describe("LIFE-1 schedule — skip rules", () => {
  it("🔴 day1 skips an account that already has a plan", () => {
    const sent = new Set(["welcome"]);
    assert.deepEqual(dueKinds(facts({ sent, hasPlan: true }), at(30)), []);
    assert.deepEqual(dueKinds(facts({ sent, hasPlan: false }), at(30)), ["day1"]);
  });

  it("day3 and day5 go whether or not there is a plan", () => {
    assert.deepEqual(dueKinds(facts({ hasPlan: true, sent: new Set(["welcome"]) }), at(73)), ["day3"]);
    assert.deepEqual(dueKinds(facts({ hasPlan: true, sent: new Set(["welcome"]) }), at(121)), ["day5"]);
  });
});

describe("LIFE-1 schedule — the free-time pair", () => {
  const trial = (over: Partial<LifecycleFacts> = {}) =>
    facts({
      createdAt: new Date("2026-10-01T15:00:00Z"),
      freeTimeEndsAt: NOV_2_END,
      sent: new Set(["welcome", "day1", "day3", "day5"]),
      ...over,
    });

  it("trial_ending: not 73 h before the end, due inside the last 72 h, gone at the end", () => {
    // 72 h before 23:59:59 EST Nov 2 is 00:59:59 EDT Oct 31 (DST ends Nov 1) —
    // quiet hours hold it to 08:00 EDT.
    assert.deepEqual(dueKinds(trial(), new Date("2026-10-31T03:00:00Z")), []); // 23:00 ET Oct 30
    assert.deepEqual(dueKinds(trial(), new Date("2026-10-31T11:59:00Z")), []); // 07:59 ET
    assert.deepEqual(dueKinds(trial(), new Date("2026-10-31T12:00:00Z")), ["trial_ending"]); // 08:00 ET
    assert.deepEqual(dueKinds(trial(), new Date("2026-11-02T20:00:00Z")), ["trial_ending"]); // 15:00 EST, the last day
    assert.deepEqual(dueKinds(trial(), new Date("2026-11-03T04:00:00Z")), []); // 23:00 EST: quiet, and it never gets a later tick
    assert.ok(!dueKinds(trial(), NOV_2_END).includes("trial_ending"));
  });

  it("trial_ended: not before the end; due from the end (after quiet hours) for 48 h", () => {
    const sent = new Set(["welcome", "day1", "day3", "day5", "trial_ending"]);
    assert.deepEqual(dueKinds(trial({ sent }), new Date("2026-11-03T04:00:00Z")), []);
    // The end is 23:59:59 ET, inside quiet hours → 08:00 ET November 3.
    assert.deepEqual(dueKinds(trial({ sent }), new Date("2026-11-03T12:59:00Z")), []); // 07:59 EST
    assert.deepEqual(dueKinds(trial({ sent }), new Date("2026-11-03T13:00:00Z")), ["trial_ended"]); // 08:00 EST
    assert.deepEqual(dueKinds(trial({ sent }), new Date(NOV_2_END.getTime() + 48 * H)), []);
  });

  it("a 14-day trial ending mid-afternoon sends both at the plain offsets", () => {
    const end = new Date("2026-11-10T19:00:00Z"); // 14:00 EST
    const f = trial({ freeTimeEndsAt: end });
    assert.deepEqual(dueKinds(f, new Date(end.getTime() - 72 * H)), ["trial_ending"]);
    const f2 = trial({ freeTimeEndsAt: end, sent: new Set(["trial_ending"]) });
    assert.deepEqual(dueKinds(f2, end), ["trial_ended"]);
  });

  it("🔴 a paying subscriber gets neither", () => {
    assert.deepEqual(dueKinds(trial({ paying: true }), new Date("2026-11-01T15:00:00Z")), []);
    assert.deepEqual(
      dueKinds(trial({ paying: true, sent: new Set(["trial_ending"]) }), new Date("2026-11-03T15:00:00Z")),
      [],
    );
  });

  it("🔴 with BILLING_ENFORCED off nobody's free time ends, so neither is sent", () => {
    assert.deepEqual(dueKinds(trial({ billingEnforced: false }), new Date("2026-11-01T15:00:00Z")), []);
  });

  it("no free-time end (not trialing, or a paid rail) → neither", () => {
    assert.deepEqual(dueKinds(trial({ freeTimeEndsAt: null }), new Date("2026-11-01T15:00:00Z")), []);
  });
});

describe("LIFE-1 schedule — once only, the opt-out, priority", () => {
  it("🔴 a kind in the send log is never due again", () => {
    for (const k of ["welcome", "day1", "day3", "day5"] as const) {
      const offset = { welcome: 1, day1: 25, day3: 73, day5: 121 }[k];
      assert.ok(dueKinds(facts(), at(offset)).includes(k), `${k} due when unsent`);
      assert.ok(!dueKinds(facts({ sent: new Set([k]) }), at(offset)).includes(k), `${k} not due once sent`);
    }
  });

  it("🔴 an opted-out account is due nothing, including the welcome", () => {
    assert.deepEqual(dueKinds(facts({ optedOut: true }), at(0)), []);
    assert.deepEqual(dueKinds(facts({ optedOut: true, sent: new Set(["welcome"]) }), at(73)), []);
    assert.deepEqual(
      dueKinds(facts({ optedOut: true, freeTimeEndsAt: NOV_2_END, createdAt: new Date("2026-10-01T15:00:00Z") }), new Date("2026-11-01T15:00:00Z")),
      [],
    );
  });

  it("when two are due, the free-time one leads (the runner sends only the first)", () => {
    const f = facts({ freeTimeEndsAt: at(100), sent: new Set(["welcome"]) });
    assert.deepEqual(dueKinds(f, at(73)), ["trial_ending", "day3"]);
  });
});

describe("LIFE-1 schedule — quiet hours", () => {
  it("a signup at 23:30 ET gets its welcome at once (it answers the signup)", () => {
    const late = new Date("2026-10-21T03:30:00Z"); // 23:30 EDT
    assert.deepEqual(dueKinds(facts({ createdAt: late }), late), ["welcome"]);
  });

  it("but its Day 1 waits for 08:00 ET instead of going at 23:30", () => {
    const late = new Date("2026-10-21T03:30:00Z");
    const f = facts({ createdAt: late, sent: new Set(["welcome"]) });
    assert.deepEqual(dueKinds(f, new Date("2026-10-22T03:30:00Z")), []); // 23:30 EDT
    assert.deepEqual(dueKinds(f, new Date("2026-10-22T12:00:00Z")), ["day1"]); // 08:00 EDT
  });

  it("🔴 an email already due is still held through the night (a late tick never sends at 22:00)", () => {
    const sent = new Set(["welcome"]);
    assert.deepEqual(dueKinds(facts({ sent }), at(76)), ["day3"]); // 18:00 EDT
    assert.deepEqual(dueKinds(facts({ sent }), at(80)), []); // 22:00 EDT
    assert.deepEqual(dueKinds(facts({ sent }), at(90)), ["day3"]); // 08:00 EDT
  });

  it("isQuietHour: 21:00–07:59 on the account's clock, per time zone", () => {
    const tz = "America/Los_Angeles";
    assert.equal(isQuietHour(new Date("2026-10-20T19:00:00Z"), tz), false); // 12:00 PDT
    assert.equal(isQuietHour(new Date("2026-10-21T03:59:00Z"), tz), false); // 20:59 PDT
    assert.equal(isQuietHour(new Date("2026-10-21T04:00:00Z"), tz), true); // 21:00 PDT
    assert.equal(isQuietHour(new Date("2026-10-21T14:59:00Z"), tz), true); // 07:59 PDT
    assert.equal(isQuietHour(new Date("2026-10-21T15:00:00Z"), tz), false); // 08:00 PDT
    assert.equal(isQuietHour(new Date("2026-10-21T04:00:00Z"), "America/New_York"), true); // the same instant is 00:00 EDT
  });

  it("an invalid stored time zone falls back to New York instead of throwing", () => {
    assert.deepEqual(dueKinds(facts({ timezone: "Mars/Olympus", sent: new Set(["welcome"]) }), at(25)), ["day1"]);
  });
});

describe("LIFE-1 — the {endDate} format", () => {
  it("the November 2 free-time end reads 'Monday, November 2' in New York", () => {
    assert.equal(formatEndDate(NOV_2_END, "America/New_York"), "Monday, November 2");
  });
  it("…and in Los Angeles (20:59 there, still the 2nd)", () => {
    assert.equal(formatEndDate(NOV_2_END, "America/Los_Angeles"), "Monday, November 2");
  });
});
