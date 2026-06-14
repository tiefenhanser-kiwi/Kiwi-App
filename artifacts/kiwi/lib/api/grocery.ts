// Mobile client for the WS6 6c-4 grocery list endpoints.
//   POST /api/plans/:id/generate-grocery-list — Case 1 fresh-generate.
//   GET  /api/grocery-lists/:id — fetch a generated list + items.
//
// WS7-1 — migrated to apiClient + Zod validation.
//
// The POST helper opts into apiClient envelope mode and re-projects the
// envelope into the existing discriminated-union surface (`success` +
// per-status `error` codes) so consumers (Plan Review) stay type-safe on
// each failure branch. The other helpers use throw mode — caller catches.
//
// The GET helper normalizes the server response (Prisma row + items with
// `displayName` / `storeSection` / `unit` etc.) into the mobile-side
// `GroceryList` / `GroceryListItem` shape used by [id].tsx so the screen
// stays unaware of which source loaded it (real API vs demo stub).

import { z } from "zod";

import { apiClient } from "./client";
import { ApiError, UnauthenticatedError } from "./errors";
import type { GroceryList, GroceryListItem } from "../types";

// ─────────────────────────────────────────────────────────────────────────
// POST /plans/:id/generate-grocery-list
// ─────────────────────────────────────────────────────────────────────────

export type GenerateGroceryListResult =
  | { success: true; groceryListId: string }
  | { success: false; error: "list_exists"; existingListId: string }
  | { success: false; error: "plan_not_found" }
  | { success: false; error: "ai_failed"; message?: string }
  | { success: false; error: "unauthenticated" }
  | { success: false; error: "unknown"; status?: number };

const GenerateGroceryListSuccessSchema = z.object({
  groceryListId: z.string(),
});

export async function generateGroceryListForPlan(
  planId: string,
): Promise<GenerateGroceryListResult> {
  const res = await apiClient(
    `/plans/${encodeURIComponent(planId)}/generate-grocery-list`,
    {
      method: "POST",
      schema: GenerateGroceryListSuccessSchema,
      errorMode: "envelope",
    },
  );

  if (res.success) {
    return { success: true, groceryListId: res.data.groceryListId };
  }

  const err = res.error;
  if (err instanceof UnauthenticatedError) {
    return { success: false, error: "unauthenticated" };
  }
  if (err instanceof ApiError) {
    if (err.status === 409) {
      const body = err.body as { existingListId?: string } | null;
      return {
        success: false,
        error: "list_exists",
        existingListId: body?.existingListId ?? "",
      };
    }
    if (err.status === 404) {
      return { success: false, error: "plan_not_found" };
    }
    if (err.status === 502) {
      const body = err.body as { message?: string } | null;
      return { success: false, error: "ai_failed", message: body?.message };
    }
    return { success: false, error: "unknown", status: err.status };
  }
  // ApiNetworkError / ApiSchemaError — treat as unknown.
  return { success: false, error: "unknown" };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /grocery-lists/:id
// ─────────────────────────────────────────────────────────────────────────

// Wire shape — mirror of the server `GroceryList` + `GroceryListItem` Prisma
// rows the GET endpoint returns. Kept local to this module so the mobile-side
// `GroceryList` type in lib/types.ts stays untouched.

// `sectionKey` enum is held as `z.string()` for forward-compat — the server
// vocabulary may grow before the mobile UI surfaces a new section.
const SectionKeySchema = z.string() as z.ZodType<GroceryListItem["sectionKey"]>;

const GroceryListItemWireSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    quantity: z.number(),
    unit: z.string(),
    storeSection: SectionKeySchema,
    isChecked: z.boolean(),
    isOptional: z.boolean(),
    isAmbiguous: z.boolean(),
    isUniversalStaple: z.boolean(),
    isUserPantryStaple: z.boolean(),
    isRecurringItem: z.boolean(),
    // WS7-7-A Block 3 — per-list staple opt-in ("buying this week", §12.7),
    // now a real server column. Drives GroceryRow's active/dimmed staple
    // render; replaces the screen's local stapleOptedInSet.
    stapleOptedIn: z.boolean(),
    ambiguityOptions: z.array(z.string()),
    userResolvedTo: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .passthrough();

const GroceryListWireSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    mealPlanInstanceId: z.string().nullable(),
    // WS7-7-A Block 3 — `completed` added (B2 enum value). Without it, a
    // marked-done list FAILS to parse on read-back (ApiSchemaError). The
    // wire enum lists the full server vocabulary; normalizeList maps it to
    // the mobile-side union below.
    status: z.enum(["draft", "active", "completed", "ordered", "archived"]),
    createdAt: z.string(),
    items: z.array(GroceryListItemWireSchema),
    planInstance: z
      .object({
        id: z.string(),
        isActiveThisWeek: z.boolean(),
      })
      .nullable(),
  })
  .passthrough();

const GetGroceryListResponseSchema = z.object({
  list: GroceryListWireSchema,
  // WS7-7-A B5 — true when this read reconciled the list to plan changes.
  // Optional for forward-compat with any pre-B5 server.
  reconciled: z.boolean().optional(),
});

type GroceryListItemWire = z.infer<typeof GroceryListItemWireSchema>;
type GroceryListWire = z.infer<typeof GroceryListWireSchema>;

// Pretty-print a numeric Float + unit pair back into a human-readable
// "2 lbs" / "1/2 tsp" style string for the legacy `quantity` display field.
// `quantityAmount` stays string-typed (mirrors meal-builder convention so
// fractions round-trip through edit cleanly); for AI-generated lists the
// Float is always an integer or simple decimal, so toString() suffices.
function formatQuantityDisplay(quantity: number, unit: string): string {
  const amt = Number.isInteger(quantity) ? String(quantity) : String(quantity);
  return unit ? `${amt} ${unit}` : amt;
}

function normalizeListItem(wire: GroceryListItemWire): GroceryListItem {
  return {
    id: wire.id,
    name: wire.displayName,
    quantity: formatQuantityDisplay(wire.quantity, wire.unit),
    quantityAmount: String(wire.quantity),
    quantityUnit: wire.unit || undefined,
    sectionKey: wire.storeSection,
    // The mobile `GroceryListItem` has `isUniversalStaple` but no
    // separate `isUserPantryStaple` field today — fold both into the
    // universal-staple flag for UI dimming purposes (PRD §12.7).
    isUniversalStaple: wire.isUniversalStaple || wire.isUserPantryStaple,
    stapleOptedIn: wire.stapleOptedIn,
    isRecurringItem: wire.isRecurringItem,
    isAmbiguous: wire.isAmbiguous,
    ambiguityOptions:
      wire.ambiguityOptions.length > 0 ? wire.ambiguityOptions : undefined,
    userResolvedTo: wire.userResolvedTo ?? undefined,
    isOptional: wire.isOptional,
    isCompleted: wire.isChecked,
  };
}

function normalizeList(wire: GroceryListWire): GroceryList {
  // Map the schema's 4-state enum (draft/active/ordered/archived) to the
  // mobile-side 4-state union (draft/active/ordered/completed). 'archived'
  // doesn't surface in normal flows; map to 'completed' for safety.
  const status: GroceryList["status"] =
    wire.status === "archived" ? "completed" : wire.status;
  return {
    id: wire.id,
    // The plan-name display is best-effort: the server title is shaped
    // "Groceries: <planTitle>", so strip the prefix when present so the
    // header doesn't read "Groceries: Groceries: …".
    planName: wire.title.replace(/^Groceries:\s*/, ""),
    planId: wire.mealPlanInstanceId ?? undefined,
    items: wire.items.map(normalizeListItem),
    status,
    createdAt: wire.createdAt,
    isThisWeek: wire.planInstance?.isActiveThisWeek ?? false,
    ambiguousItemCount: wire.items.filter((i) => i.isAmbiguous).length,
  };
}

export interface GetGroceryListResult {
  list: GroceryList;
  // WS7-7-A B5 — drives the transient "updating to match plan changes" banner.
  reconciled: boolean;
}

export async function getGroceryList(
  listId: string,
): Promise<GetGroceryListResult> {
  const body = await apiClient(`/grocery-lists/${encodeURIComponent(listId)}`, {
    schema: GetGroceryListResponseSchema,
  });
  return { list: normalizeList(body.list), reconciled: body.reconciled ?? false };
}

// ─────────────────────────────────────────────────────────────────────────
// 6c-6 Block C — GET /grocery-items/lookup + POST /grocery-lists/:id/items
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mobile-side candidate shape. Mirrors LookupCandidateSchema (api-server)
 * but with `sectionKey` (mobile-canonical) instead of `storeSection` (DB
 * column name). Conversion happens at the wire boundary in this module so
 * UI components stay aligned with the rest of the screen's vocabulary.
 */
export interface GroceryItemCandidate {
  ingredientId: string | null;
  canonicalName: string;
  displayName: string;
  sectionKey: GroceryListItem["sectionKey"];
  defaultUnit: string;
  /** AI-source only — null/absent for lookup hits. e.g. "1 jar". */
  suggestedQuantity: string | null;
}

export interface LookupResponse {
  source: "lookup" | "ai";
  candidates: GroceryItemCandidate[];
}

const LookupCandidateWireSchema = z
  .object({
    ingredientId: z.string().nullable(),
    canonicalName: z.string(),
    displayName: z.string(),
    storeSection: SectionKeySchema,
    defaultUnit: z.string(),
    suggestedQuantity: z.string().nullable().optional(),
  })
  .passthrough();

const LookupResponseSchema = z.object({
  source: z.enum(["lookup", "ai"]),
  candidates: z.array(LookupCandidateWireSchema),
});

type LookupCandidateWire = z.infer<typeof LookupCandidateWireSchema>;

function normalizeCandidate(wire: LookupCandidateWire): GroceryItemCandidate {
  return {
    ingredientId: wire.ingredientId,
    canonicalName: wire.canonicalName,
    displayName: wire.displayName,
    sectionKey: wire.storeSection,
    defaultUnit: wire.defaultUnit,
    suggestedQuantity: wire.suggestedQuantity ?? null,
  };
}

/**
 * GET /api/grocery-items/lookup?q=<query>
 * Returns lookup-first candidates with AI fallback. Errors throw — caller
 * (debounced effect in grocery-list/[id].tsx) catches and resets to [].
 */
export async function lookupGroceryItemCandidates(
  query: string,
): Promise<LookupResponse> {
  const body = await apiClient(
    `/grocery-items/lookup?q=${encodeURIComponent(query)}`,
    { schema: LookupResponseSchema },
  );
  return {
    source: body.source,
    candidates: body.candidates.map(normalizeCandidate),
  };
}

/**
 * POST /api/grocery-lists/:id/items body. Mobile-canonical `sectionKey`
 * is converted to server-canonical `storeSection` on the wire below.
 */
export interface AddItemPayload {
  itemName: string;
  sectionKey: GroceryListItem["sectionKey"];
  quantity?: number;
  unit?: string;
  ingredientId?: string | null;
}

const AddItemResponseSchema = z.object({ item: GroceryListItemWireSchema });

/**
 * POST /api/grocery-lists/:listId/items
 * Creates a single item; returns the normalized mobile-side
 * GroceryListItem. Errors throw — caller (handleAddItem in
 * grocery-list/[id].tsx) catches and rolls back the optimistic add.
 */
export async function addGroceryListItem(
  listId: string,
  payload: AddItemPayload,
): Promise<GroceryListItem> {
  const body: Record<string, unknown> = {
    itemName: payload.itemName,
    storeSection: payload.sectionKey,
  };
  if (payload.quantity !== undefined) body.quantity = payload.quantity;
  if (payload.unit !== undefined) body.unit = payload.unit;
  if (payload.ingredientId !== undefined) {
    body.ingredientId = payload.ingredientId;
  }
  const json = await apiClient(
    `/grocery-lists/${encodeURIComponent(listId)}/items`,
    {
      method: "POST",
      body,
      schema: AddItemResponseSchema,
    },
  );
  return normalizeListItem(json.item);
}

/**
 * Parse an AI-supplied shopper-friendly quantity hint like "1 can",
 * "2 lbs", "1 jar" into a structured (quantity, unit) pair. Falls back
 * to (1, "each") when the hint is null/empty; if the leading token
 * isn't numeric, treats the whole hint as the unit so the chip still
 * surfaces "soft taco shells" verbatim in the unit slot.
 */
export function parseSuggestedQuantity(
  s: string | null | undefined,
): { quantity: number; unit: string } {
  if (!s) return { quantity: 1, unit: "each" };
  const trimmed = s.trim();
  if (!trimmed) return { quantity: 1, unit: "each" };
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (!match) return { quantity: 1, unit: trimmed };
  const qty = parseFloat(match[1]);
  if (!isFinite(qty) || qty <= 0) return { quantity: 1, unit: match[2] };
  return { quantity: qty, unit: match[2] };
}

// ─────────────────────────────────────────────────────────────────────────
// WS7-7-A Block 3 — item-mutation clients (PATCH list/item, DELETE, restore)
// ─────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/grocery-lists/:id — §12.6.3 mark-shopping-done. Bidirectional;
 * the server accepts only "active" | "completed". Returns the new status
 * (mobile-side union). The response carries the bare list row (no items), so
 * a minimal schema is used rather than the full GroceryListWireSchema.
 */
const UpdateListStatusResponseSchema = z.object({
  list: z
    .object({
      id: z.string(),
      status: z.enum(["draft", "active", "completed", "ordered", "archived"]),
    })
    .passthrough(),
});

export async function updateGroceryListStatus(
  listId: string,
  status: "active" | "completed",
): Promise<GroceryList["status"]> {
  const body = await apiClient(
    `/grocery-lists/${encodeURIComponent(listId)}`,
    {
      method: "PATCH",
      body: { status },
      schema: UpdateListStatusResponseSchema,
    },
  );
  // 'archived' never surfaces in normal flows; fold to 'completed' for the
  // mobile union (same mapping as normalizeList).
  return body.list.status === "archived" ? "completed" : body.list.status;
}

/**
 * PATCH /api/grocery-lists/:id/items/:itemId — partial item update. Pass any
 * subset of the editable fields; the server requires ≥1. Returns the
 * normalized mobile-side item. Errors throw — callers revert their optimistic
 * update and surface the failure.
 *
 * `userResolvedTo`/`isAmbiguous` belong to the B5 clarify UI; this block only
 * wires isChecked / quantity+unit / stapleOptedIn.
 */
export interface UpdateGroceryListItemPatch {
  isChecked?: boolean;
  quantity?: number;
  unit?: string;
  stapleOptedIn?: boolean;
  storeSection?: GroceryListItem["sectionKey"];
  displayName?: string;
  userResolvedTo?: string | null;
}

const UpdateItemResponseSchema = z.object({ item: GroceryListItemWireSchema });

export async function updateGroceryListItem(
  listId: string,
  itemId: string,
  patch: UpdateGroceryListItemPatch,
): Promise<GroceryListItem> {
  const body = await apiClient(
    `/grocery-lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      body: patch as Record<string, unknown>,
      schema: UpdateItemResponseSchema,
    },
  );
  return normalizeListItem(body.item);
}

/**
 * DELETE /api/grocery-lists/:id/items/:itemId — soft-delete. Returns the
 * deleted item shape (for the undo banner). The row id is preserved server-
 * side so {@link restoreGroceryListItem} resurrects the SAME row.
 */
export async function deleteGroceryListItem(
  listId: string,
  itemId: string,
): Promise<GroceryListItem> {
  const body = await apiClient(
    `/grocery-lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: "DELETE",
      schema: UpdateItemResponseSchema,
    },
  );
  return normalizeListItem(body.item);
}

/**
 * POST /api/grocery-lists/:id/items/:itemId/restore — undo a soft-delete.
 * Returns the restored item with its ORIGINAL id (D-WS6-082), so the undo
 * flow re-inserts the same row rather than minting a fresh one.
 */
export async function restoreGroceryListItem(
  listId: string,
  itemId: string,
): Promise<GroceryListItem> {
  const body = await apiClient(
    `/grocery-lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/restore`,
    {
      method: "POST",
      schema: UpdateItemResponseSchema,
    },
  );
  return normalizeListItem(body.item);
}
