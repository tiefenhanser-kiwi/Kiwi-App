// Mobile client for the WS6 6c-4 grocery list endpoints.
//   POST /api/plans/:id/generate-grocery-list — Case 1 fresh-generate.
//   GET  /api/grocery-lists/:id — fetch a generated list + items.
//
// The POST helper returns a discriminated-union result that captures the
// 409 "list exists" path (Case 1 enforcement) without throwing — callers
// branch on `result.success` + `result.error` to either route to the new
// list or route to the existing one. AI failure (502) surfaces as
// `error: 'ai_failed'` with an optional message so the UI can show a
// retry-friendly alert.
//
// The GET helper normalizes the server response (Prisma row + items with
// `displayName` / `storeSection` / `unit` etc.) into the mobile-side
// `GroceryList` / `GroceryListItem` shape used by [id].tsx so the screen
// stays unaware of which source loaded it (real API vs demo stub).

import { readToken } from "../auth";
import type { GroceryList, GroceryListItem } from "../types";

const apiBase =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "http://localhost:3000/api");

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

export async function generateGroceryListForPlan(
  planId: string,
): Promise<GenerateGroceryListResult> {
  const token = await readToken();
  if (!token) {
    return { success: false, error: "unauthenticated" };
  }

  const res = await fetch(
    `${apiBase}/plans/${encodeURIComponent(planId)}/generate-grocery-list`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (res.status === 200) {
    const body = (await res.json()) as { groceryListId: string };
    return { success: true, groceryListId: body.groceryListId };
  }
  if (res.status === 409) {
    const body = (await res.json()) as { existingListId: string };
    return {
      success: false,
      error: "list_exists",
      existingListId: body.existingListId,
    };
  }
  if (res.status === 404) {
    return { success: false, error: "plan_not_found" };
  }
  if (res.status === 401) {
    return { success: false, error: "unauthenticated" };
  }
  if (res.status === 502) {
    let message: string | undefined;
    try {
      const body = (await res.json()) as { message?: string };
      message = body.message;
    } catch {
      // ignore — keep message undefined
    }
    return { success: false, error: "ai_failed", message };
  }
  return { success: false, error: "unknown", status: res.status };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /grocery-lists/:id
// ─────────────────────────────────────────────────────────────────────────

// Wire shape — mirror of the server `GroceryList` + `GroceryListItem` Prisma
// rows the GET endpoint returns. Kept local to this module so the mobile-side
// `GroceryList` type in lib/types.ts stays untouched.
interface GroceryListItemWire {
  id: string;
  displayName: string;
  quantity: number;
  unit: string;
  storeSection: GroceryListItem["sectionKey"];
  isChecked: boolean;
  isOptional: boolean;
  isAmbiguous: boolean;
  isUniversalStaple: boolean;
  isUserPantryStaple: boolean;
  isRecurringItem: boolean;
  ambiguityOptions: string[];
  userResolvedTo: string | null;
  notes: string | null;
}

interface GroceryListWire {
  id: string;
  title: string;
  mealPlanInstanceId: string | null;
  status: "draft" | "active" | "ordered" | "archived";
  createdAt: string;
  items: GroceryListItemWire[];
  planInstance: {
    id: string;
    isActiveThisWeek: boolean;
  } | null;
}

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

export async function getGroceryList(listId: string): Promise<GroceryList> {
  const token = await readToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const res = await fetch(
    `${apiBase}/grocery-lists/${encodeURIComponent(listId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (res.status !== 200) {
    throw new Error(`getGroceryList failed: ${res.status}`);
  }
  const body = (await res.json()) as { list: GroceryListWire };
  return normalizeList(body.list);
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

interface LookupCandidateWire {
  ingredientId: string | null;
  canonicalName: string;
  displayName: string;
  storeSection: GroceryListItem["sectionKey"];
  defaultUnit: string;
  suggestedQuantity?: string | null;
}

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
  const token = await readToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  const res = await fetch(
    `${apiBase}/grocery-items/lookup?q=${encodeURIComponent(query)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (res.status !== 200) {
    throw new Error(`lookupGroceryItemCandidates failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    source: "lookup" | "ai";
    candidates: LookupCandidateWire[];
  };
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
  const token = await readToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  const body: Record<string, unknown> = {
    itemName: payload.itemName,
    storeSection: payload.sectionKey,
  };
  if (payload.quantity !== undefined) body.quantity = payload.quantity;
  if (payload.unit !== undefined) body.unit = payload.unit;
  if (payload.ingredientId !== undefined) {
    body.ingredientId = payload.ingredientId;
  }
  const res = await fetch(
    `${apiBase}/grocery-lists/${encodeURIComponent(listId)}/items`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
  );
  if (res.status !== 201) {
    throw new Error(`addGroceryListItem failed: ${res.status}`);
  }
  const json = (await res.json()) as { item: GroceryListItemWire };
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
