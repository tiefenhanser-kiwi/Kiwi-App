// WS7-6 (E) Block 2 §2 — Sunday-based date helper pins. The PlanDateRangeEditor
// preset relies on getDay() === 0 anchoring; if a refactor flips the anchor day
// these tests fail loudly.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  addDays,
  computeNextWeekStart,
  computeThisWeekStart,
  parseLocalDate,
  toLocalDateString,
} from "../dates";

// Pin Date.now() across the test so computeThisWeekStart() is reproducible
// regardless of when the suite runs.
const RealDate = Date;
function freezeDate(iso: string): void {
  const fixed = new RealDate(`${iso}T12:00:00`);
  class FakeDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof RealDate>) {
      if (args.length === 0) {
        super(fixed.getTime());
        return;
      }
      super(...(args as [number]));
    }
    static now(): number {
      return fixed.getTime();
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Date = FakeDate;
}
function restoreDate(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Date = RealDate;
}

afterEach(restoreDate);

test("computeThisWeekStart returns the Sunday on a Wednesday", () => {
  // 2026-06-10 is a Wednesday → expect 2026-06-07 (Sunday).
  freezeDate("2026-06-10");
  assert.equal(computeThisWeekStart(), "2026-06-07");
});

test("computeThisWeekStart returns itself when today IS Sunday", () => {
  // 2026-06-07 is a Sunday.
  freezeDate("2026-06-07");
  assert.equal(computeThisWeekStart(), "2026-06-07");
});

test("computeNextWeekStart returns the upcoming Sunday from a mid-week day", () => {
  // 2026-06-10 (Wed) → next Sunday is 2026-06-14.
  freezeDate("2026-06-10");
  assert.equal(computeNextWeekStart(), "2026-06-14");
});

test("computeNextWeekStart on Sunday returns the FOLLOWING Sunday (7 days later)", () => {
  freezeDate("2026-06-07");
  assert.equal(computeNextWeekStart(), "2026-06-14");
});

test("addDays handles end-of-month rollover via local Date arithmetic", () => {
  assert.equal(addDays("2026-06-30", 1), "2026-07-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("parseLocalDate round-trips through toLocalDateString (no TZ drift)", () => {
  const iso = "2026-06-07";
  assert.equal(toLocalDateString(parseLocalDate(iso)), iso);
});
