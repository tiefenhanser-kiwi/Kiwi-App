// Mobile client for the WS7-3 A2 grocery-list read — GET /grocery-lists.
// WS7-3 Block C1 — API-client + hook foundation; no screens migrate here.
//
// Schema transcribed from the real server route (artifacts/api-server/src/
// routes/groceryLists.ts). GET /grocery-lists is NOT paginated (no nextCursor)
// — per-user list counts are small.

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
// and is null for lists not derived from a plan.
export const GroceryListListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  sourceType: z.string(),
  mealPlanInstanceId: z.string().nullable(),
  itemCount: z.number(),
  lastGeneratedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type GroceryListListItem = z.infer<typeof GroceryListListItemSchema>;

const GroceryListsResponseSchema = z.object({
  groceryLists: z.array(GroceryListListItemSchema),
});

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
  const query = filter ? `?filter=${encodeURIComponent(filter)}` : "";
  const body = await apiClient(`/grocery-lists${query}`, {
    schema: GroceryListsResponseSchema,
  });
  return body.groceryLists;
}
