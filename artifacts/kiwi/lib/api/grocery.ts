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
    // Drift: server schema has no isRecurringItem column. Always false
    // until 6c-4 close decides whether to add the column.
    isRecurringItem: false,
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
    // WS6 6c-4 doesn't surface "is current week" from the API yet — the
    // screen tolerates `false` (subtitle just shows the plan name).
    isThisWeek: false,
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
