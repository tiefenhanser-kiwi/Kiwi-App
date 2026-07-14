// WS7-7-A B6 (D-WS5-033) — tests for the pure picker + handoff helpers in
// lib/groceryPicker.ts: the 0/1/2+ CTA decider, the fetch-all-pages loop (incl.
// the non-advancing-cursor guard), the This-Week-pinned list builder (search +
// sort over the rest), and the generate-result → action mapping.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPickerList,
  decideGroceryEntry,
  fetchAllPlans,
  resolveGenerateResult,
  resolveGroceryRoute,
} from "../groceryPicker";
import type { PlanListItem, PlanSummary } from "../api/plans";

// ── fixtures ─────────────────────────────────────────────────────────────────

function plan(overrides: Partial<PlanListItem> & { id: string }): PlanListItem {
  return {
    name: `Plan ${overrides.id}`,
    description: null,
    image: null,
    tags: [],
    source: "instance",
    status: "draft",
    startDate: null,
    endDate: null,
    isActiveThisWeek: false,
    ...overrides,
  };
}

function summary(id: string): PlanSummary {
  return {
    id,
    name: `Plan ${id}`,
    status: "this_week",
    startDate: null,
    endDate: null,
    revisionId: 1,
  };
}

// ── resolveGroceryRoute (WS9 3a / R4) ────────────────────────────────────────

test("R4: active plan WITH a list → open it", () => {
  assert.deepEqual(
    resolveGroceryRoute({ id: "p-1", groceryListId: "gl-9" }, [{ id: "p-1" }]),
    { kind: "open", listId: "gl-9" },
  );
});

test("R4: active plan with NO list → generate for that plan", () => {
  assert.deepEqual(
    resolveGroceryRoute({ id: "p-1", groceryListId: null }, [{ id: "p-1" }]),
    { kind: "generate", planId: "p-1" },
  );
});

test("R4: no active plan + 0 plans → wizard (no-plan branch)", () => {
  assert.deepEqual(resolveGroceryRoute(null, []), { kind: "wizard" });
});

test("R4: no active plan + exactly 1 plan → generate (409 handles has-list)", () => {
  assert.deepEqual(resolveGroceryRoute(null, [{ id: "p-7" }]), {
    kind: "generate",
    planId: "p-7",
  });
});

test("R4: no active plan + 2+ plans → picker (disambiguate first)", () => {
  assert.deepEqual(
    resolveGroceryRoute(null, [{ id: "p-1" }, { id: "p-2" }]),
    { kind: "picker" },
  );
});

test("R4: active plan wins over the count fallback (has-list, many plans)", () => {
  assert.deepEqual(
    resolveGroceryRoute({ id: "p-1", groceryListId: "gl-1" }, [
      { id: "p-1" },
      { id: "p-2" },
      { id: "p-3" },
    ]),
    { kind: "open", listId: "gl-1" },
  );
});

// ── decideGroceryEntry (0 / 1 / 2+) ──────────────────────────────────────────

test("decideGroceryEntry: 0 plans → empty (today's Groceries-tab behavior)", () => {
  assert.deepEqual(decideGroceryEntry([]), { kind: "empty" });
});

test("decideGroceryEntry: exactly 1 plan → single with that plan id", () => {
  assert.deepEqual(decideGroceryEntry([{ id: "plan-1" }]), {
    kind: "single",
    planId: "plan-1",
  });
});

test("decideGroceryEntry: 2+ plans → picker", () => {
  assert.deepEqual(
    decideGroceryEntry([{ id: "a" }, { id: "b" }]),
    { kind: "picker" },
  );
  assert.deepEqual(
    decideGroceryEntry([{ id: "a" }, { id: "b" }, { id: "c" }]),
    { kind: "picker" },
  );
});

// ── fetchAllPlans ────────────────────────────────────────────────────────────

test("fetchAllPlans: accumulates every page and terminates on a null cursor", async () => {
  const pages = [
    { plans: [plan({ id: "a" }), plan({ id: "b" })], activeThisWeek: summary("a"), nextCursor: "cur-1" },
    { plans: [plan({ id: "c" })], activeThisWeek: summary("a"), nextCursor: "cur-2" },
    { plans: [plan({ id: "d" })], activeThisWeek: summary("a"), nextCursor: null },
  ];
  const cursorsSeen: (string | undefined)[] = [];
  let i = 0;
  const result = await fetchAllPlans(async (cursor) => {
    cursorsSeen.push(cursor);
    return pages[i++];
  });
  // Page 1 fetched with no cursor, then each subsequent nextCursor.
  assert.deepEqual(cursorsSeen, [undefined, "cur-1", "cur-2"]);
  assert.deepEqual(result.plans.map((p) => p.id), ["a", "b", "c", "d"]);
  // activeThisWeek is request-stable → first page's value kept.
  assert.equal(result.activeThisWeek?.id, "a");
});

test("fetchAllPlans: single page (null cursor immediately) makes exactly one call", async () => {
  let calls = 0;
  const result = await fetchAllPlans(async () => {
    calls++;
    return { plans: [plan({ id: "only" })], activeThisWeek: null, nextCursor: null };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.plans.map((p) => p.id), ["only"]);
  assert.equal(result.activeThisWeek, null);
});

test("fetchAllPlans: a non-advancing (repeated) cursor terminates instead of looping forever", async () => {
  let calls = 0;
  const result = await fetchAllPlans(async () => {
    calls++;
    // Server bug: always returns the SAME cursor → must break on the repeat.
    return { plans: [plan({ id: `p${calls}` })], activeThisWeek: null, nextCursor: "stuck" };
  });
  // First call returns "stuck" (added to seen), second call returns "stuck"
  // again → guard breaks. Two calls, not infinite.
  assert.equal(calls, 2);
  assert.equal(result.plans.length, 2);
});

// ── buildPickerList (This Week pinned + search/sort over the rest) ───────────

test("buildPickerList: pins the activeThisWeek plan at top, rest excludes it", () => {
  const plans = [
    plan({ id: "a", name: "Alpha" }),
    plan({ id: "w", name: "Winner", isActiveThisWeek: true }),
    plan({ id: "b", name: "Bravo" }),
  ];
  const { pinned, rest } = buildPickerList(plans, summary("w"), { sort: "alpha" });
  assert.equal(pinned?.id, "w");
  assert.deepEqual(rest.map((p) => p.id), ["a", "b"]);
});

test("buildPickerList: falls back to the isActiveThisWeek item when no summary", () => {
  const plans = [
    plan({ id: "a", name: "Alpha" }),
    plan({ id: "w", name: "Winner", isActiveThisWeek: true }),
  ];
  const { pinned, rest } = buildPickerList(plans, null, { sort: "alpha" });
  assert.equal(pinned?.id, "w");
  assert.deepEqual(rest.map((p) => p.id), ["a"]);
});

test("buildPickerList: no This-Week plan → pinned null, all plans in rest", () => {
  const plans = [plan({ id: "a", name: "Alpha" }), plan({ id: "b", name: "Bravo" })];
  const { pinned, rest } = buildPickerList(plans, null, { sort: "alpha" });
  assert.equal(pinned, null);
  assert.deepEqual(rest.map((p) => p.id), ["a", "b"]);
});

test("buildPickerList: alpha sort orders the rest by name", () => {
  const plans = [
    plan({ id: "c", name: "Cherry" }),
    plan({ id: "a", name: "Apple" }),
    plan({ id: "b", name: "Banana" }),
  ];
  const { rest } = buildPickerList(plans, null, { sort: "alpha" });
  assert.deepEqual(rest.map((p) => p.name), ["Apple", "Banana", "Cherry"]);
});

test("buildPickerList: recent sort orders by startDate desc, nulls last", () => {
  const plans = [
    plan({ id: "old", name: "Old", startDate: "2026-01-01T00:00:00Z" }),
    plan({ id: "none", name: "Undated", startDate: null }),
    plan({ id: "new", name: "New", startDate: "2026-06-01T00:00:00Z" }),
  ];
  const { rest } = buildPickerList(plans, null, { sort: "recent" });
  assert.deepEqual(rest.map((p) => p.id), ["new", "old", "none"]);
});

test("buildPickerList: search filters the rest (but never the pinned plan)", () => {
  const plans = [
    plan({ id: "w", name: "Taco Tuesday", isActiveThisWeek: true }),
    plan({ id: "a", name: "Pasta Week" }),
    plan({ id: "b", name: "Taco Fiesta" }),
  ];
  const { pinned, rest } = buildPickerList(plans, summary("w"), {
    query: "taco",
    sort: "alpha",
  });
  // Pinned stays even though it also matches; rest is filtered to taco matches.
  assert.equal(pinned?.id, "w");
  assert.deepEqual(rest.map((p) => p.id), ["b"]);
});

// ── resolveGenerateResult (shared handoff mapping) ───────────────────────────

test("resolveGenerateResult: success → navigate to the new list", () => {
  assert.deepEqual(
    resolveGenerateResult({ success: true, groceryListId: "gl-9" }),
    { kind: "navigate", listId: "gl-9" },
  );
});

test("resolveGenerateResult: list_exists (409) → navigate to the existing list", () => {
  assert.deepEqual(
    resolveGenerateResult({
      success: false,
      error: "list_exists",
      existingListId: "gl-7",
    }),
    { kind: "navigate", listId: "gl-7" },
  );
});

test("resolveGenerateResult: errors map to alerts (no navigation)", () => {
  for (const result of [
    { success: false, error: "ai_failed" as const },
    { success: false, error: "plan_not_found" as const },
    { success: false, error: "unauthenticated" as const },
    { success: false, error: "unknown" as const },
  ]) {
    const action = resolveGenerateResult(result);
    assert.equal(action.kind, "alert");
  }
});
