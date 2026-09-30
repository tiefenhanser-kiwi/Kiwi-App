// 🔴 BUG-339 — the FILTER IS WIRED, not merely written.
//
// internalTags.test.ts pins the predicate. This pins that the mappers call it:
// a correct helper nobody calls is the shape of BUG-321 and of D-WS9-292's own
// seam, and it is what Part F break (204) removes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { instanceToListItem } from "../planQueries";

const LEAKY = ["fully-specified", "family-friendly", "mexican", "asian", "classic"];

function row(tags: string[]) {
  return {
    id: "plan-1",
    titleOverride: null,
    status: "active",
    startDate: new Date("2026-09-28T00:00:00Z"),
    endDate: new Date("2026-10-04T00:00:00Z"),
    _count: { items: 5 },
    template: {
      title: "A Week of Dinners",
      description: null,
      imageUrl: null,
      tags,
    },
  } as unknown as Parameters<typeof instanceToListItem>[0];
}

describe("BUG-339 — the plan list mapper filters internal tags", () => {
  it("🔴 the literal from the browser pass does not reach the list item", () => {
    const item = instanceToListItem(row(LEAKY), null);
    assert.deepEqual(item.tags, ["family-friendly", "mexican", "asian", "classic"]);
    assert.ok(!item.tags.includes("fully-specified"));
  });

  it("an ordinary plan's tags are untouched", () => {
    const tags = ["italian", "weeknight", "one-pan"];
    assert.deepEqual(instanceToListItem(row(tags), null).tags, tags);
  });

  it("a plan with no template, and one with no tags, are both safe", () => {
    assert.deepEqual(instanceToListItem(row([]), null).tags, []);
    const noTemplate = { ...row([]), template: null } as unknown as Parameters<
      typeof instanceToListItem
    >[0];
    assert.deepEqual(instanceToListItem(noTemplate, null).tags, []);
  });
});
