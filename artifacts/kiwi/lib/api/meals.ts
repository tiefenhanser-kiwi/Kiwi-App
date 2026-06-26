// Mobile client for the /api/meals namespace.
// WS6 6b-1 — POST /meals/find-similar: replaces the cuisine-only client
//   filter on FindSimilarSheet with a real semantic-similarity AI call.
// WS7-1 — migrated to apiClient + Zod validation.
// WS7-3 Block B — GET /meals/:id: meal-detail read (see getMeal below).
// WS7-3 Block C1 — GET /me/meals: filtered meal-list read. MealListItemSchema
//   (the renamed-flat list shape) is added here; MealDetailSchema now extends it.
//
// Contract is client-sends-full-payload: the sheet unions all four candidate
// catalogs (saved + featured + top rated + hosting per PRD §8.4) and posts
// them with each request. WS7 will keep the same server contract while
// switching the client to fetch real data from the API first.

import { z } from "zod";

import { apiClient } from "./client";
import type { MealSummary } from "../types";

// Trim shape sent to the server. Mirror of MealCandidateSchema in
// artifacts/api-server/src/lib/ai/schemas/findSimilar.ts.
export interface MealCandidatePayload {
  id: string;
  title: string;
  cuisine: string | null;
  mealType: string;
  keyIngredients?: string[];
  tags?: string[];
}

// ── Zod schemas ──────────────────────────────────────────────────────────
// Transcribed from server-side findSimilar.ts + route response shape.
// Server's FindSimilarResultSchema has only `matches`; mobile-visible
// `metadata` is attached at the route boundary (artifacts/api-server/src/
// routes/meals.ts:220-225).

const FindSimilarMatchSchema = z.object({
  mealId: z.string(),
  similarityScore: z.number(),
  reason: z.string(),
});

const FindSimilarResponseSchema = z.object({
  matches: z.array(FindSimilarMatchSchema),
  metadata: z
    .object({
      promptVersion: z.number().nullable(),
      latencyMs: z.number(),
      mode: z.enum(["ai", "fallback_cuisine"]),
    })
    .optional(),
});

export interface FindSimilarMatch {
  mealId: string;
  similarityScore: number;
  reason: string;
}

export interface FindSimilarResponse {
  matches: FindSimilarMatch[];
  metadata?: {
    promptVersion: number | null;
    latencyMs: number;
    mode: "ai" | "fallback_cuisine";
  };
}

export interface FindSimilarRequest {
  source: MealCandidatePayload;
  candidates: MealCandidatePayload[];
  limit?: number;
}

// MealSummary doesn't carry mealType today; FindSimilar runs from the Plan
// Review sheet so dinner is the safe default. WS7 surfaces real mealType.
export function mealSummaryToCandidate(meal: MealSummary): MealCandidatePayload {
  return {
    id: meal.id,
    title: meal.title,
    cuisine: meal.cuisineType ?? null,
    mealType: "dinner",
  };
}

export async function findSimilarMeals(
  input: FindSimilarRequest,
): Promise<FindSimilarResponse> {
  return apiClient("/meals/find-similar", {
    method: "POST",
    body: input,
    schema: FindSimilarResponseSchema,
  });
}

// ── Meal detail (GET /api/meals/:id) ──────────────────────────────────────
// WS7-3 Block B — replaces the lib/stubs.ts getMealById fixture with the real
// catalog detail endpoint. Schemas are transcribed from the server's
// composeMealDetail (artifacts/api-server/src/routes/meals.ts): the renamed-
// flat meal envelope (cuisine / minutes / servings / calories… / image) plus
// a dishes[] array carrying per-dish ingredients + steps, and a top-level
// meal-owned steps[] fallback for legacy single-dish meals.

// A recipe step — shared by the per-dish steps and the top-level meal-owned
// fallback array. `stepIndex` is 0-based and restarts per owner.
// WS7-8b BUG-003 Block 1 — sidecar step→ingredient reference link. One entry
// per matched amount span; `quantity` is the AUTHORED LITERAL at base servings
// (0.75 for "¾ cup"), scaled at render by the meal-detail multiplier. Absent or
// null on every legacy step (→ plain-text render, exactly as today).
export const AmountRefSchema = z.object({
  ingredientId: z.string(),
  quantity: z.number(),
  unit: z.string(),
  charStart: z.number(),
  charEnd: z.number(),
});

export const MealStepSchema = z.object({
  stepIndex: z.number(),
  text: z.string(),
  estimatedMinutes: z.number(),
  phaseType: z.string(),
  parallelGroup: z.string().nullable(),
  requiresPreheat: z.boolean(),
  requiresRest: z.boolean(),
  requiresMarination: z.boolean(),
  isTimingSensitive: z.boolean(),
  // Optional + nullable: legacy steps omit it / send null.
  amountRefs: z.array(AmountRefSchema).nullish(),
  // WS7-8b BUG-003 Block 1 — DERIVED read-side (server toStepShape), never
  // stored. true only when a wired step has ≥1 non-by-design amount that
  // resolved to no unique ingredient → drives the subtle clarify-any-time
  // signal. Absent/false on legacy + fully-matched steps.
  unmatchedAmount: z.boolean().optional(),
});

export const MealDetailIngredientSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  preparationNote: z.string().nullable(),
  category: z.string(),
  isOptional: z.boolean(),
});

// One sub-dish of a meal. `roleLabel` / `difficulty` / `phaseType` are server
// enums kept as plain strings — matches the server's own composeMealDetail
// types and the lib/api/me.ts convention of not over-constraining columns the
// mobile UI only reads.
const MealDetailDishSchema = z.object({
  dishId: z.string(),
  title: z.string(),
  roleLabel: z.string(),
  positionIndex: z.number(),
  minutes: z.number(),
  difficulty: z.string(),
  servings: z.number(),
  // WS7-8 BUG-003 — per-dish authored-servings anchor. Server always emits it
  // (authoredServingsDefault ?? servingsDefault), so it's never absent.
  authoredServingsDefault: z.number(),
  ingredients: z.array(MealDetailIngredientSchema),
  steps: z.array(MealStepSchema),
});

// The renamed-flat meal-list shape (server `toListShape` — cuisineType→cuisine,
// estimatedTimeMinutes→minutes, *PerServing→bare macros, imageUrl→image).
// `cuisine` is always a string ("" when the meal has none — never null).
// Returned by GET /me/meals and embedded as `todaysMeal.meal` in GET /home.
export const MealListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  cuisine: z.string(),
  minutes: z.number(),
  servings: z.number(),
  // WS7-8 BUG-003 — immutable authored-servings anchor; the Meal Detail and
  // Cook Mode ingredient scalers divide by THIS, not `servings`. Server always
  // emits it (authoredServingsDefault ?? servingsDefault), so never absent.
  authoredServingsDefault: z.number(),
  calories: z.number(),
  protein: z.number(),
  carbs: z.number(),
  fat: z.number(),
  tags: z.array(z.string()),
  image: z.string().nullable(),
});

// The full meal-detail payload. Extends the list shape with the detail-only
// fields — the server's own type is `MealDetail extends MealListItem`, so the
// eleven shared meta fields stay single-sourced here too. `notes` is always
// null today — the server has no meal-notes column (see WS7-3 B report §7).
export const MealDetailSchema = MealListItemSchema.extend({
  description: z.string().nullable(),
  difficulty: z.string(),
  mealType: z.string(),
  sourceType: z.string(),
  isPublic: z.boolean(),
  userId: z.string().nullable(),
  dishes: z.array(MealDetailDishSchema),
  steps: z.array(MealStepSchema),
  notes: z.null(),
  // WS7-8b (D-WS7-169 keystone) — the plan-instance-resolved servings
  // (servingsOverride ?? servingsDefault). Distinct from the authored
  // `servings`, which the Meal Detail ingredient scaler uses as its
  // denominator. Without a plan item, the server returns it === `servings`.
  effectiveServings: z.number(),
});

const MealDetailEnvelopeSchema = z.object({ meal: MealDetailSchema });

export type AmountRef = z.infer<typeof AmountRefSchema>;
export type MealListItem = z.infer<typeof MealListItemSchema>;
export type MealStep = z.infer<typeof MealStepSchema>;
export type MealDetailIngredient = z.infer<typeof MealDetailIngredientSchema>;
export type MealDetailDish = z.infer<typeof MealDetailDishSchema>;
export type MealDetail = z.infer<typeof MealDetailSchema>;

/**
 * GET /meals/:id — public meal-catalog detail. Returns the renamed-flat meal
 * envelope with per-dish ingredients + steps. Propagates the apiClient typed
 * errors: `ApiError` (status 404 for a missing or archived meal),
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 *
 * WS7-7-A B5 (D-WS7-090 read-side) — when opened from a plan item, pass
 * `planItemId` so the server applies that item's per-instance recipeOverrideJson
 * ("just this time" edit, incl. a removed ingredient) to the returned detail.
 * Omitted → the canonical meal.
 */
export async function getMeal(
  id: string,
  planItemId?: string,
): Promise<MealDetail> {
  const query = planItemId
    ? `?planItemId=${encodeURIComponent(planItemId)}`
    : "";
  const body = await apiClient(`/meals/${encodeURIComponent(id)}${query}`, {
    schema: MealDetailEnvelopeSchema,
  });
  return body.meal;
}

// ── Meal list (GET /api/me/meals) ─────────────────────────────────────────
// WS7-3 Block C1 — the Meals-tab catalog read. Foundation only; the Meals
// screen migrates in a later C-block.

// ?filter= accept-list — mirrors the server's MEALS_FILTER_KEYS
// (artifacts/api-server/src/routes/me.ts). Multi-select: any subset may be
// passed; the server unions each filter's result block and dedupes by id.
export const MEAL_FILTER_KEYS = [
  "my_meals",
  "featured",
  "top_rated",
  "hosting",
] as const;
export type MealFilterKey = (typeof MEAL_FILTER_KEYS)[number];

// ── Sort keys ────────────────────────────────────────────────────────────
// WS7-6 G2 — server-accepted ?sort= values for GET /me/meals. Mirrors the
// server's MEAL_SORT_KEYS (artifacts/api-server/src/lib/listQuery.ts): the
// dish keys minus the dish-only times_cooked / last_cooked. The SortDropdown's
// extra keys stay greyed in meal contexts (see lib/meals/sortMapping).
export const MEAL_SORT_KEYS = ["alpha", "date_created", "cook_time"] as const;
export type MealSortKey = (typeof MEAL_SORT_KEYS)[number];

/**
 * Narrows a server-supplied string[] (e.g. user.lastMealsFilters) to the typed
 * MealFilterKey union, dropping unknown values silently. Relocated from
 * lib/stubs.ts in WS7-3 C3 — outlives the stub file because the Meals-tab
 * filter persistence reads through it.
 */
export function asMealsFilters(
  arr: string[] | undefined | null,
): MealFilterKey[] {
  if (!arr) return [];
  return arr.filter((k): k is MealFilterKey =>
    (MEAL_FILTER_KEYS as readonly string[]).includes(k),
  );
}

// GET /me/meals response — the cursor-paginated meal-list union.
const MealListResponseSchema = z.object({
  meals: z.array(MealListItemSchema),
  nextCursor: z.string().nullable(),
});
export type MealListResponse = z.infer<typeof MealListResponseSchema>;

/**
 * GET /me/meals — the authenticated user's meal catalog, filtered by the
 * Meals-tab discovery chips. `filter` is a multi-select subset of
 * MEAL_FILTER_KEYS; omitted/empty defers to the server default (`my_meals`).
 * Returns the cursor-paginated union. Propagates the apiClient typed errors:
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 */
// WS7-6 G2 scope (iii): `opts` carries the keyset-pagination + sort params,
// mirroring getDishes. `sort` maps 1:1 to the server's MEAL_SORT_KEYS; `cursor`
// is the opaque `nextCursor` from a prior page; `limit` clamps server-side to
// [1, 100]. Each option is appended only when provided, so the existing
// no-opts call shape (and its wire) is byte-for-byte unchanged.
export interface GetMealsOptions {
  limit?: number;
  cursor?: string;
  sort?: MealSortKey;
}

export async function getMeals(
  filter?: readonly MealFilterKey[],
  opts: GetMealsOptions = {},
): Promise<MealListResponse> {
  const params = new URLSearchParams();
  if (filter && filter.length > 0) params.set("filter", filter.join(","));
  if (opts.sort) params.set("sort", opts.sort);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const query = params.toString();
  return apiClient(`/me/meals${query ? `?${query}` : ""}`, {
    schema: MealListResponseSchema,
  });
}

// ── Save-canonical (WS7-6 Block 1E) ─────────────────────────────────────
// POST /me/meals — write the row graph for a meal built in the mobile
// Meal Builder (manual Mode B, combined Mode C, or imported draft).
// Schemas mirror postMeMealSchema at artifacts/api-server/src/routes/me.ts.
// Difficulty enum here is the server's (`easy | medium | fancy`); callers
// translate `hard → fancy` via `toServerDifficulty` from lib/api/builder.

export interface SaveMealMacrosPerServing {
  caloriesPerServing?: number;
  proteinGPerServing?: number;
  carbsGPerServing?: number;
  fatGPerServing?: number;
}

export interface SaveMealIngredient {
  name: string;
  quantity: number;
  unit: string;
  preparationNote?: string | null;
  isOptional?: boolean;
}

export interface SaveMealStep {
  text: string;
  estimatedMinutes?: number;
  phaseType?: "prep" | "preheat" | "cook" | "rest" | "assemble" | "hold";
  parallelGroup?: string | null;
  isTimingSensitive?: boolean;
}

export type SaveMealDishRole =
  | "main"
  | "side"
  | "sauce"
  | "topping"
  | "base"
  | "optional";

export type SaveMealDish =
  | {
      kind: "new";
      title: string;
      role: SaveMealDishRole;
      positionIndex: number;
      estimatedTimeMinutes?: number;
      difficulty?: "easy" | "medium" | "fancy";
      servingsDefault?: number;
      ingredients: SaveMealIngredient[];
      steps: SaveMealStep[];
      macros?: SaveMealMacrosPerServing;
    }
  | {
      kind: "link";
      dishId: string;
      role: SaveMealDishRole;
      positionIndex: number;
    };

export interface SaveMealInput {
  title: string;
  description?: string | null;
  cuisineType?: string | null;
  mealType?: "breakfast" | "lunch" | "dinner" | "snack" | "mixed";
  servingsDefault?: number;
  estimatedTimeMinutes?: number;
  difficulty?: "easy" | "medium" | "fancy";
  tags?: string[];
  sourceType?: "manual" | "wizard" | "directed" | "curated";
  macros?: SaveMealMacrosPerServing;
  dishes: SaveMealDish[];
}

const SaveMealResponseSchema = z.object({
  meal: z.object({
    id: z.string(),
    dishIds: z.array(z.string()),
    linksCreated: z.number(),
  }),
});

export interface SaveMealResponse {
  id: string;
  dishIds: string[];
  linksCreated: number;
}

/**
 * POST /api/me/meals — save-canonical entry for the Meal Builder.
 *
 * Returns the row-graph IDs created by the server (`id` = the new Meal,
 * `dishIds` = the canonical dish ids the link rows now point at, including
 * existing ids for `kind:"link"` entries). Callers use `id` to chain into
 * `addMealToPlan` for the "save + add to plan" flow.
 *
 * Propagates apiClient typed errors: `ApiError` (400 validation, 403 linked
 * dish not owned, 404 linked dish not found, 429 rate limit, 500 tx),
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function saveMeal(
  input: SaveMealInput,
  opts: { signal?: AbortSignal } = {},
): Promise<SaveMealResponse> {
  const body = await apiClient("/me/meals", {
    method: "POST",
    body: input,
    schema: SaveMealResponseSchema,
    signal: opts.signal,
  });
  return body.meal;
}

// ── PATCH /me/meals/:id (WS7-6 1A + 1F) ─────────────────────────────────
// Edit-surface for both library-context global edits (PRD §8.4.4) and the
// §2.5 "Apply always" branch from a plan-context Meal Builder edit. The
// server's PATCH route accepts a partial body (at-least-one-field) and
// runs the wipe-and-recreate path when `dishes[]` is present. Scalar-only
// patches skip the wipe.

// All fields optional; at-least-one-field is enforced server-side.
export interface UpdateMealInput {
  title?: string;
  description?: string | null;
  cuisineType?: string | null;
  mealType?: "breakfast" | "lunch" | "dinner" | "snack" | "mixed";
  servingsDefault?: number;
  estimatedTimeMinutes?: number;
  difficulty?: "easy" | "medium" | "fancy";
  tags?: string[];
  imageUrl?: string | null;
  macros?: SaveMealMacrosPerServing;
  dishes?: SaveMealDish[];
  // WS7-7-A B5 — "apply every time" from inside a plan. When set, the server
  // bumps THIS plan instance's revision in the same transaction as the edit so
  // the current plan's grocery list reconciles. Other plans keep their
  // snapshot. Omitted for plain library edits (D-WS7-136 forward-only).
  bumpPlanId?: string;
}

// Server's PATCH meal response has two shapes depending on whether dishes[]
// was in the patch (rematerialize echoes dishIds + linksCreated; scalar-only
// returns just the id). The mobile client unions both.
const UpdateMealResponseSchema = z.object({
  meal: z.object({
    id: z.string(),
    dishIds: z.array(z.string()).optional(),
    linksCreated: z.number().optional(),
  }),
});

export interface UpdateMealResponse {
  id: string;
  dishIds?: string[];
  linksCreated?: number;
}

/**
 * PATCH /api/me/meals/:id — global edit of a saved meal. Used by both the
 * Meal Detail edit flow (§8.4.4, no prompt) and the §2.5 "Apply always"
 * branch from a plan-context Meal Builder edit. Returns the meal id (+
 * sub-graph echo when dishes were patched).
 *
 * Propagates apiClient typed errors: `ApiError` (400 validation, 403 not
 * owned, 404 missing/archived/curated, 429 rate limit, 500 tx),
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function updateMeal(
  id: string,
  patch: UpdateMealInput,
  opts: { signal?: AbortSignal } = {},
): Promise<UpdateMealResponse> {
  const body = await apiClient(`/me/meals/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
    schema: UpdateMealResponseSchema,
    signal: opts.signal,
  });
  return body.meal;
}
