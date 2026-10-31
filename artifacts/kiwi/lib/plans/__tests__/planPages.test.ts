// CLIENT-9 E (BUG-467) — the Plans tab's paging helpers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { flattenPlanPages, nearListEnd, planSearchParam, PLAN_PAGE_SIZE } from "../planPages";
import type { PlanListResponse } from "../../api/plans";

const page = (ids: string[], nextCursor: string | null = null): PlanListResponse =>
  ({ plans: ids.map((id) => ({ id })), activeThisWeek: null, nextCursor }) as unknown as PlanListResponse;

describe("CLIENT-9 E — flattenPlanPages", () => {
  it("every page's plans, in server order", () => {
    assert.deepEqual(flattenPlanPages([page(["a", "b"], "c"), page(["c", "d"])]).map((p) => p.id), ["a", "b", "c", "d"]);
  });

  it("a plan seen on an earlier page is not shown twice", () => {
    assert.deepEqual(flattenPlanPages([page(["a", "b"]), page(["b", "c"])]).map((p) => p.id), ["a", "b", "c"]);
  });

  it("no pages yet is no rows", () => {
    assert.deepEqual(flattenPlanPages(undefined), []);
  });
});

describe("CLIENT-9 E — nearListEnd", () => {
  it("within the threshold of the end", () => {
    assert.equal(nearListEnd({ contentHeight: 3000, viewportHeight: 800, offsetY: 1700 }), true);
    assert.equal(nearListEnd({ contentHeight: 3000, viewportHeight: 800, offsetY: 1500 }), false);
  });

  it("a page that does not fill the window asks for the next one", () => {
    assert.equal(nearListEnd({ contentHeight: 500, viewportHeight: 800, offsetY: 0 }), true);
  });

  it("nothing measured yet asks for nothing", () => {
    assert.equal(nearListEnd({ contentHeight: 0, viewportHeight: 800, offsetY: 0 }), false);
    assert.equal(nearListEnd({ contentHeight: 900, viewportHeight: 0, offsetY: 0 }), false);
  });
});

describe("CLIENT-9 E — the search and the page", () => {
  it("the search is trimmed, inner spaces folded, case kept", () => {
    assert.equal(planSearchParam("  Taco   Night "), "Taco Night");
    assert.equal(planSearchParam("   "), "");
  });

  it("asks for pages of 20", () => {
    assert.equal(PLAN_PAGE_SIZE, 20);
  });
});
