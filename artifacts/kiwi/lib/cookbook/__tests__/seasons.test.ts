// BOOK-1C1 (D-WS9-312) — the seasonal band: the window (by the server's
// clock), the count, the per-user-per-device dismissal, and the copy.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  collectionSubline,
  dismissalKey,
  dismissSeason,
  loadSeasonDismissals,
  parseSeasonDismissals,
  seasonBandVisible,
  seasonEyebrow,
  seasonSubline,
  visibleCourses,
} from "../seasons";

const season = {
  tag: "thanksgiving",
  startsAt: "2026-11-02T05:00:00.000Z",
  endsAt: "2026-12-01T05:00:00.000Z",
  endsOn: "2026-11-30",
  count: 12,
  blurb: "turkeys, sides, pies",
};

describe("seasonBandVisible — the window", () => {
  test("inside the window, with meals, not dismissed: shown", () => {
    assert.equal(seasonBandVisible(season, "2026-11-20T15:00:00.000Z", false), true);
    assert.equal(seasonBandVisible(season, "2026-11-02T05:00:00.000Z", false), true);
  });

  test("the first and last instants: start inclusive, end exclusive", () => {
    assert.equal(seasonBandVisible(season, "2026-11-02T04:59:59.999Z", false), false);
    assert.equal(seasonBandVisible(season, "2026-12-01T04:59:59.999Z", false), true);
    assert.equal(seasonBandVisible(season, "2026-12-01T05:00:00.000Z", false), false);
  });

  test("a count of 0 hides it; so does a dismissal", () => {
    assert.equal(seasonBandVisible({ ...season, count: 0 }, "2026-11-20T15:00:00.000Z", false), false);
    assert.equal(seasonBandVisible(season, "2026-11-20T15:00:00.000Z", true), false);
  });

  test("an unparseable instant never shows it", () => {
    assert.equal(seasonBandVisible(season, "soon", false), false);
    assert.equal(seasonBandVisible({ ...season, endsAt: "never" }, "2026-11-20T15:00:00.000Z", false), false);
  });
});

describe("the copy", () => {
  test("eyebrow, subline, collection subline", () => {
    assert.equal(seasonEyebrow(season), "SEASONAL · UNTIL NOV 30");
    assert.equal(seasonSubline(season), "12 recipes · turkeys, sides, pies");
    assert.equal(seasonSubline({ ...season, count: 1 }), "1 recipe · turkeys, sides, pies");
    assert.equal(collectionSubline(season), "Seasonal collection · until Nov 30");
  });

  test("a course chip with nothing in it is hidden", () => {
    assert.deepEqual(
      visibleCourses([
        { label: "Feasts", tag: "thanksgiving-feast", count: 0 },
        { label: "Turkey", tag: "course-turkey", count: 3 },
      ]).map((c) => c.label),
      ["Turkey"],
    );
  });
});

describe("dismissal — per user, per device, per season-year", () => {
  test("the key carries the user, the tag and the last day", () => {
    assert.equal(dismissalKey("u1", season), "u1|thanksgiving|2026-11-30");
    assert.notEqual(dismissalKey("u2", season), dismissalKey("u1", season));
    assert.notEqual(dismissalKey("u1", { ...season, endsOn: "2027-11-30" }), dismissalKey("u1", season));
  });

  test("written through storage and read back; garbage reads as nothing", async () => {
    assert.equal((await loadSeasonDismissals()).size, 0);
    const key = dismissalKey("u1", season);
    const next = await dismissSeason(key, new Set());
    assert.equal(next.has(key), true);
    assert.equal((await loadSeasonDismissals()).has(key), true);
    assert.equal(parseSeasonDismissals("nope").size, 0);
    assert.deepEqual([...parseSeasonDismissals(["a", 3, null, "b"])], ["a", "b"]);
  });
});
