// Mobile client for the WS7-3 A2 grocery-list read — GET /grocery-lists.
// WS7-3 Block C1 — API-client + hook foundation; no screens migrate here.
//
// Schema transcribed from the real server route (artifacts/api-server/src/
// routes/groceryLists.ts).
//
// BUG-139 — GET /grocery-lists IS paginated. It gained a keyset cursor in
// WS7-7-A Block 6 (`clampLimit` defaults to 20, and the body carries a
// `nextCursor`), and this comment's original claim that it was not is what let
// the client keep sending no `limit` and never following the cursor: the tab
// silently showed only the 20 newest lists, with no scroll-to-load and no way
// to reach anything older. Measured live: 8 of one account's 28 lists were
// unreachable in the app, and because the Groceries screen sorts and searches
// over the rows it already has, neither A–Z nor the search box could find them.
//
// This asks for the server's ceiling instead. It is a STOPGAP, not the fix —
// the real one is useInfiniteQuery (as useDishes/useMeals already do) plus
// server-side sort and search, which needs the screen off ScrollView+map.

import { z } from "zod";

import { apiClient } from "./client";

// ── Filter keys ────────────────────────────────────────────────────────────
// ?filter= accept-list — mirrors GROCERY_LIST_FILTER_KEYS. `active` =
// non-archived + created in the last 7 days; `past` = older. Omitted ⇒ all
// lists. Note: this two-state recency filter is NOT the PRD §12.14 four-state
// status vocabulary (Draft/Active/Ordered/Completed) — see C1 Phase 1 §7.
export const GROCERY_LIST_FILTER_KEYS = ["active", "past"] as const;
export type GroceryListFilterKey = (typeof GROCERY_LIST_FILTER_KEYS)[number];

// ── Schema ─────────────────────────────────────────────────────────────────

// One row of the grocery-lists screen. `status` is the raw server enum value
// kept as a plain string (the PRD's status vocabulary is not ratified here —
// C1 Phase 1 §7). `mealPlanInstanceId` is the source plan's id (not its name),
// and is null for lists not derived from a plan. `isActiveThisWeek` is the
// resolver-derived flag (WS7-6 (E) Block 2): true on the single list whose
// linked plan is the user's This-Week winner; false otherwise (including for
// lists with no linked plan instance).
export const GroceryListListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  sourceType: z.string(),
  mealPlanInstanceId: z.string().nullable(),
  isActiveThisWeek: z.boolean(),
  itemCount: z.number(),
  lastGeneratedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type GroceryListListItem = z.infer<typeof GroceryListListItemSchema>;

// WS7-7-A B6 item 5 — grocery-card chip whitelist. The resolver-driven
// This-Week winner wins the single badge slot; otherwise only `completed` and
// `ordered` surface a chip. Draft / Active / Archived render no chip (this
// replaces the old title-case-everything statusBadgeLabel). Lives here next to
// the list-item type so the groceries screen and its tests share one source.
export function chipLabel(
  list: Pick<GroceryListListItem, "isActiveThisWeek" | "status">,
): string | null {
  if (list.isActiveThisWeek) return "This Week";
  if (list.status === "completed") return "Completed";
  if (list.status === "ordered") return "Ordered";
  return null;
}

// WS7-7-A B6 item 6 — "View Meal Plan" link target. Returns the /plan/[id]
// nav descriptor (same shape Home uses, app/(tabs)/index.tsx) when the list is
// plan-derived, or null when it has no linked plan instance — in which case the
// card renders no link. Keeps the render condition + nav param shape in one
// unit-testable place (the groceries screen lives under app/, outside the test
// glob).
export function planLinkTarget(
  list: Pick<GroceryListListItem, "mealPlanInstanceId">,
): { pathname: "/plan/[id]"; params: { id: string } } | null {
  if (!list.mealPlanInstanceId) return null;
  return { pathname: "/plan/[id]", params: { id: list.mealPlanInstanceId } };
}

// `nextCursor` is deliberately absent: zod strips it, and declaring a field
// this client never follows would read as "pagination handled". It is not —
// see the BUG-139 note at the top of this file.
const GroceryListsResponseSchema = z.object({
  groceryLists: z.array(GroceryListListItemSchema),
});

/**
 * The server's own ceiling (`clampLimit` in api-server/src/lib/listQuery.ts
 * clamps to [1, 100]), asked for explicitly so the tab stops silently
 * truncating at the default 20. A user who passes 100 lists is truncated again,
 * silently — that is BUG-139's remaining half, not something this constant can
 * solve.
 */
const GROCERY_LIST_PAGE_LIMIT = 100;

// ── Getter ─────────────────────────────────────────────────────────────────

/**
 * GET /grocery-lists — the user's grocery lists, newest first. `filter`
 * narrows by the active/past recency window; omitted returns all lists.
 * Propagates the apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiSchemaError` on a response-shape mismatch.
 */
export async function getGroceryLists(
  filter?: GroceryListFilterKey,
): Promise<GroceryListListItem[]> {
  const params = new URLSearchParams();
  if (filter) params.set("filter", filter);
  params.set("limit", String(GROCERY_LIST_PAGE_LIMIT));
  const body = await apiClient(`/grocery-lists?${params.toString()}`, {
    schema: GroceryListsResponseSchema,
  });
  return body.groceryLists;
}
