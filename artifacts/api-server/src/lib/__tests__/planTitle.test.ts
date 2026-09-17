// WS9 Redesign Arc post-pass Part D ([WS9-arc-PS-D]) — the deterministic
// picks-plan name: format + fallback pinned.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  disambiguatePlanTitle,
  formatWeekOfDate,
  loadTakenPlanTitles,
  picksPlanTitle,
  storedPlanTitle,
  UNNAMED_PICKS_TITLE,
} from "../planTitle";

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

// BUG-290 — two plans, one name: the suffix rule and what it reads.
describe("disambiguatePlanTitle", () => {
  it("a free base is returned unchanged — never ' (1)'", () => {
    assert.equal(disambiguatePlanTitle("Hans's meals, week of Sep 16", []), "Hans's meals, week of Sep 16");
    assert.equal(disambiguatePlanTitle("X", ["Y", "X (2)"]), "X");
  });
  it("a taken base → ' (2)', then ' (3)' — the first free number, holes filled", () => {
    const base = "Hans's meals, week of Sep 16";
    assert.equal(disambiguatePlanTitle(base, [base]), `${base} (2)`);
    assert.equal(disambiguatePlanTitle(base, [base, `${base} (2)`]), `${base} (3)`);
    assert.equal(disambiguatePlanTitle(base, [base, `${base} (3)`]), `${base} (2)`);
  });
  it("compares exact stored strings — case and padding are not folded", () => {
    assert.equal(disambiguatePlanTitle("Taco week", ["taco week", "Taco week "]), "Taco week");
  });
});

describe("loadTakenPlanTitles", () => {
  it("reads the user's non-archived, non-draft rows and folds titleOverride ?? template.title; blanks dropped", async () => {
    const calls: unknown[] = [];
    const db = {
      mealPlanInstance: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return [
            { titleOverride: null, template: { title: "A" } },
            { titleOverride: "B", template: { title: "old B" } },
            { titleOverride: null, template: null },
          ];
        },
      },
    };
    const taken = await loadTakenPlanTitles(db, "u1");
    assert.deepEqual([...taken].sort(), ["A", "B"]);
    assert.deepEqual(calls, [
      {
        where: { userId: "u1", isArchived: false, isWizardDraft: false },
        select: { titleOverride: true, template: { select: { title: true } } },
      },
    ]);
  });
  it("storedPlanTitle is what My Plans renders: override wins, else the template, else ''", () => {
    assert.equal(storedPlanTitle({ titleOverride: "B", template: { title: "T" } }), "B");
    assert.equal(storedPlanTitle({ titleOverride: null, template: { title: "T" } }), "T");
    assert.equal(storedPlanTitle({ titleOverride: null, template: null }), "");
  });
});
