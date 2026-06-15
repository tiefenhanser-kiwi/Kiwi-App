// WS7-7-A B6 (D-WS5-033 / D-WS7-143) — pure helpers for the multi-plan grocery
// picker + the plan→grocery generate handoff. The screen (app/grocery-plan-
// picker.tsx) and the Home CTA branch (app/(tabs)/index.tsx) live under app/,
// outside the test glob, so all the decision logic lives here where it can be
// unit-tested.

import type { GenerateGroceryListResult } from "@/lib/api/grocery";
import type { PlanListItem, PlanSummary } from "@/lib/api/plans";

// ── Home "Get Groceries" CTA decider (0 / 1 / 2+ branch) ─────────────────────

export type GroceryEntryDecision =
  // 0 plans (or not yet loaded) → preserve today's behavior: open the
  // Groceries tab (it renders its own empty state).
  | { kind: "empty" }
  // Exactly 1 plan → straight to that plan's grocery flow (shared handoff),
  // no picker shown.
  | { kind: "single"; planId: string }
  // 2+ plans → the intermediate picker screen.
  | { kind: "picker" };

export function decideGroceryEntry(
  plans: readonly Pick<PlanListItem, "id">[],
): GroceryEntryDecision {
  if (plans.length === 0) return { kind: "empty" };
  if (plans.length === 1) return { kind: "single", planId: plans[0].id };
  return { kind: "picker" };
}

// ── Fetch-all-pages (the picker needs the full plan set in memory) ───────────

interface PlansPage {
  plans: PlanListItem[];
  activeThisWeek: PlanSummary | null;
  nextCursor: string | null;
}

// Loop a page-fetcher until the server stops handing back a cursor, accumulating
// every plan. `activeThisWeek` is request-stable (same on every page), so the
// first page's value is kept. Guards against an infinite loop if the server
// ever returns a non-advancing or repeated cursor (belt-and-suspenders — a bad
// cursor must terminate, not spin).
export async function fetchAllPlans(
  fetchPage: (cursor: string | undefined) => Promise<PlansPage>,
): Promise<{ plans: PlanListItem[]; activeThisWeek: PlanSummary | null }> {
  const all: PlanListItem[] = [];
  let activeThisWeek: PlanSummary | null = null;
  let cursor: string | undefined = undefined;
  const seen = new Set<string>();
  let guard = 0;

  for (;;) {
    const page = await fetchPage(cursor);
    all.push(...page.plans);
    if (activeThisWeek === null) activeThisWeek = page.activeThisWeek;

    const next = page.nextCursor;
    // Terminate on null/empty cursor, a repeated cursor, or the hard cap.
    if (!next || seen.has(next) || guard >= 1000) break;
    seen.add(next);
    cursor = next;
    guard += 1;
  }

  return { plans: all, activeThisWeek };
}

// ── Pinned-list builder (This Week pinned + search/sort over the rest) ────────

export type PickerSort = "recent" | "alpha";

export interface PickerList {
  // The This-Week plan, always pinned at the top (exempt from search/sort).
  pinned: PlanListItem | null;
  // Every other plan, after the search filter + sort.
  rest: PlanListItem[];
}

// Resolve which plan is "This Week": prefer the response's activeThisWeek
// summary id; fall back to the list item flagged isActiveThisWeek.
function resolvePinnedId(
  plans: readonly PlanListItem[],
  activeThisWeek: PlanSummary | null,
): string | null {
  if (activeThisWeek) return activeThisWeek.id;
  return plans.find((p) => p.isActiveThisWeek)?.id ?? null;
}

export function buildPickerList(
  plans: readonly PlanListItem[],
  activeThisWeek: PlanSummary | null,
  opts: { query?: string; sort?: PickerSort } = {},
): PickerList {
  const pinnedId = resolvePinnedId(plans, activeThisWeek);
  const pinned = pinnedId
    ? plans.find((p) => p.id === pinnedId) ?? null
    : null;

  const q = (opts.query ?? "").trim().toLowerCase();
  const sort: PickerSort = opts.sort ?? "recent";

  const rest = plans
    .filter((p) => p.id !== pinnedId)
    .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
    .sort((a, b) => {
      if (sort === "alpha") return a.name.localeCompare(b.name);
      // "recent": startDate desc, nulls last; name as the stable tiebreaker.
      const at = a.startDate ? Date.parse(a.startDate) : NaN;
      const bt = b.startDate ? Date.parse(b.startDate) : NaN;
      const aNull = Number.isNaN(at);
      const bNull = Number.isNaN(bt);
      if (aNull && bNull) return a.name.localeCompare(b.name);
      if (aNull) return 1;
      if (bNull) return -1;
      return bt - at || a.name.localeCompare(b.name);
    });

  return { pinned, rest };
}

// ── Generate-handoff result mapping (plan → grocery list) ────────────────────
// Pure mapping from the shared generateGroceryListForPlan result to a UI action.
// BOTH the 200-new and 409-exists cases navigate to the same list screen (the
// user can't tell the difference); every error maps to a friendly alert. The
// hook (useGroceryGeneration) performs the navigate/alert from this descriptor,
// so there is ONE handoff path — no parallel generate flow.

export type HandoffAction =
  | { kind: "navigate"; listId: string }
  | { kind: "alert"; title: string; message: string };

export function resolveGenerateResult(
  result: GenerateGroceryListResult,
): HandoffAction {
  if (result.success) return { kind: "navigate", listId: result.groceryListId };
  if (result.error === "list_exists")
    return { kind: "navigate", listId: result.existingListId };
  if (result.error === "ai_failed")
    return {
      kind: "alert",
      title: "Could not generate list",
      message: "Our AI hit a hiccup. Please try again in a moment.",
    };
  if (result.error === "plan_not_found")
    return {
      kind: "alert",
      title: "Plan not found",
      message: "We couldn't find this plan. Try reloading.",
    };
  if (result.error === "unauthenticated")
    return {
      kind: "alert",
      title: "Session expired",
      message: "Please sign in again to keep going.",
    };
  return {
    kind: "alert",
    title: "Something went wrong",
    message: "Please try again in a moment.",
  };
}
