// CLIENT-9 D (BUG-472) — a user's staples: "I always have this" on a grocery row,
// and Profile → Staples. SERVER-13 A's routes (api-server routes/me.ts,
// lib/pantryStaples.ts):
//
//   POST   /me/staples { groceryItemId } → 201 { id, ingredientId, name, createdAt }
//          404 not the user's row · 422 no catalog ingredient · 409 already a staple
//          (the 409 body carries the existing `staple`)
//   GET    /me/staples → { items: [...] }, newest first
//   DELETE /me/staples/:id → 204 · 404 no such staple
//
// The server marks the user's OPEN lists' rows of that ingredient on create and
// clears them on delete (isUserPantryStaple), so a list read after either call
// already says it. lib/api/grocery.ts folds isUserPantryStaple into
// isUniversalStaple: the row dims and leaves the Instacart cart as any staple does.

import { z } from "zod";

import { apiClient } from "./client";
import { ApiError } from "./errors";

export const StapleSchema = z.object({
  id: z.string(),
  ingredientId: z.string().nullable(),
  name: z.string(),
  createdAt: z.string(),
});
export type Staple = z.infer<typeof StapleSchema>;

const StaplesSchema = z.object({ items: z.array(StapleSchema) });

/** Profile → Staples' query (app/staples.tsx). */
export const STAPLES_QUERY_KEY = ["me", "staples"] as const;

/** GET /me/staples — the user's staples, newest first. */
export async function getStaples(): Promise<Staple[]> {
  const body = await apiClient("/me/staples", { schema: StaplesSchema });
  return body.items;
}

/**
 * POST /me/staples — the grocery row's ingredient becomes a staple. A 409 (it
 * already is one, from another list or another device) is the same outcome for
 * the cook, so it resolves with the existing staple rather than throwing.
 */
export async function addStaple(groceryItemId: string): Promise<Staple> {
  try {
    return await apiClient("/me/staples", {
      method: "POST",
      body: { groceryItemId },
      schema: StapleSchema,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const existing = StapleSchema.safeParse((err.body as { staple?: unknown } | null)?.staple);
      if (existing.success) return existing.data;
    }
    throw err;
  }
}

/** DELETE /me/staples/:id — 204. A 404 (already gone) is the outcome asked for. */
export async function removeStaple(id: string): Promise<void> {
  try {
    await apiClient(`/me/staples/${encodeURIComponent(id)}`, {
      method: "DELETE",
      schema: z.void(),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}
