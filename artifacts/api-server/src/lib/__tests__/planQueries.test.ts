// WS7-4-D c16 — unit tests for the toYmd helper. The helper formats a Date
// (DateTime column read from Prisma) as a calendar-date YYYY-MM-DD string
// using UTC components. UTC matches the store side: PATCH /plans/:id
// canonicalizes incoming YYYY-MM-DD via `new Date("YYYY-MM-DD")`, which JS
// interprets as UTC midnight. Symmetric extraction on read keeps the
// round-trip stable regardless of the server process's local timezone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toYmd } from "../planQueries";

describe("toYmd — calendar-date wire formatter", () => {
  it("returns null for null input", () => {
    assert.equal(toYmd(null), null);
  });

  it("formats a UTC-midnight Date as YYYY-MM-DD", () => {
    const d = new Date("2026-06-07T00:00:00.000Z");
    assert.equal(toYmd(d), "2026-06-07");
  });

  it("pads single-digit month and day with leading zero", () => {
    const d = new Date("2026-01-05T00:00:00.000Z");
    assert.equal(toYmd(d), "2026-01-05");
  });

  it("uses UTC components (a UTC-midnight Date returns the calendar date the user wrote, not the server's local-time date)", () => {
    // `new Date("YYYY-MM-DD")` parses as UTC midnight per the JS spec — same
    // path PATCH /plans/:id takes via toNullableDate. UTC extraction on read
    // must hand back the exact YYYY-MM-DD the user wrote, regardless of where
    // the server is running.
    const d = new Date("2026-12-31");
    assert.equal(toYmd(d), "2026-12-31");
  });

  it("preserves the date even when local time would shift it (TZ-agnostic on the server)", () => {
    // A Date constructed at UTC midnight 2026-06-07 reads as 2026-06-07 in
    // UTC components, full stop. The mobile parser receives the same string
    // and parses it with local-time semantics — that's where the calendar
    // date lives for the user, and the symmetry is the point.
    const d = new Date(Date.UTC(2026, 5, 7, 0, 0, 0, 0));
    assert.equal(toYmd(d), "2026-06-07");
  });
});
