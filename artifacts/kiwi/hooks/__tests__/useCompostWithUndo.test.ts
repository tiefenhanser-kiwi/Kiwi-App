// WS9 3d Part 3c (B1) — regression test for the Plan Review compost crash.
// dropComposedPlanFromListCache is the optimistic-removal updater that
// setQueriesData runs over EVERY ["plans"]-prefixed cache. The crash was that
// the plan-DETAIL cache (["plans","detail",id]) — a PlanDetail with `items`
// and NO `plans` array — slipped through the same prefix filter, and the old
// updater called old.plans.filter on undefined ("Cannot read property 'filter'
// of undefined"), which fired before showToast and aborted the deferred DELETE
// so nothing was ever archived. These tests pin: list caches are filtered,
// detail (and any non-list) caches pass through untouched instead of throwing.

import assert from "node:assert/strict";
import { test } from "node:test";

import { dropComposedPlanFromListCache } from "../useCompostWithUndo";
import type { PlanListResponse } from "@/lib/api/plans";

function listResponse(): PlanListResponse {
  return {
    plans: [
      { id: "p-keep" } as PlanListResponse["plans"][number],
      { id: "p-drop" } as PlanListResponse["plans"][number],
    ],
    activeThisWeek: null,
    nextCursor: null,
  } as PlanListResponse;
}

test("list cache: removes the composted plan, keeps the rest", () => {
  const out = dropComposedPlanFromListCache(listResponse(), "p-drop");
  assert.ok(out);
  assert.deepEqual(
    out!.plans.map((p) => p.id),
    ["p-keep"],
  );
});

test("list cache: clears the This-Week callout when it is the composted plan", () => {
  const old = {
    ...listResponse(),
    activeThisWeek: { id: "p-drop" },
  } as unknown as PlanListResponse;
  const out = dropComposedPlanFromListCache(old, "p-drop");
  assert.equal(out!.activeThisWeek, null);
});

test("list cache: leaves an unrelated This-Week callout intact", () => {
  const old = {
    ...listResponse(),
    activeThisWeek: { id: "p-keep" },
  } as unknown as PlanListResponse;
  const out = dropComposedPlanFromListCache(old, "p-drop");
  assert.deepEqual(out!.activeThisWeek, { id: "p-keep" });
});

test("REGRESSION: detail-shaped cache (items, no plans) passes through untouched — no crash", () => {
  // The exact crash condition: composting from the plan-detail screen, whose
  // ["plans","detail",id] cache is a PlanDetail, not a PlanListResponse.
  const detailShaped = {
    id: "p-drop",
    name: "Backyard Grill Week",
    items: [{ planItemId: "i-1" }],
    macroDailyAverage: {},
    dietaryStale: false,
  } as unknown as PlanListResponse;
  // Must NOT throw, and must return the value unchanged (no .plans to filter).
  const out = dropComposedPlanFromListCache(detailShaped, "p-drop");
  assert.equal(out, detailShaped);
});

test("undefined cache passes through as undefined", () => {
  assert.equal(dropComposedPlanFromListCache(undefined, "p-drop"), undefined);
});
