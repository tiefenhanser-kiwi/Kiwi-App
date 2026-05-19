// Mobile client for POST /api/recipes/import-url (WS6 6c-1),
// POST /api/recipes/import-image (WS6 6c-2), POST /api/recipes/import-text
// (WS6 6c-3). Calls the server endpoint and adapts the canonical recipe
// response into the DraftMeal shape the existing meal-review/edit screen
// consumes.
//
// WS7-1 — migrated to apiClient (envelope mode) + Zod validation.
//
// Server contract is "typed envelope": 200 status for both success
// (`{ success: true, recipe, source, sourceUrl, caveats }`) and per-flow
// failure (`{ success: false, reason, userFacingMessage, suggestedAction }`).
// Caller stays on the typed result; wrapper envelope only surfaces for
// 4xx/5xx (which we translate to the same union via `sdk_error` /
// `rate_limited`).
//
// The canonical → DraftMeal adapter is a deliberate throwaway: it lives at
// the client boundary so the rest of the app stays on the legacy DraftMeal
// shape until WS7 lands a first-class import flow. The server preserves
// the full canonical recipe in LLMCallLog, so nothing is lost in the
// adapter.

import * as ImageManipulator from "expo-image-manipulator";
import { z } from "zod";

import { apiClient } from "./client";
import { ApiError } from "./errors";
import type { DraftMeal, ReviewMealDish, ReviewMealStep } from "../types";

// ─────────────────────────────────────────────────────────────────
// Zod schemas — mirror artifacts/api-server/src/lib/ai/schemas/reformat.ts
// `.passthrough()` everywhere because the canonical recipe shape is
// still expanding (Block C audit flagged it as "broad and partial").
// ─────────────────────────────────────────────────────────────────

const CanonicalIngredientWireSchema = z
  .object({
    name: z.string(),
    quantity: z.number(),
    unit: z.string(),
    preparationNote: z.string().optional(),
    isOptional: z.boolean().optional(),
  })
  .passthrough();

const CanonicalStepWireSchema = z
  .object({
    stepIndex: z.number(),
    stepTextRaw: z.string(),
    stepTextTranslated: z.string(),
    estimatedMinutes: z.number(),
    phaseType: z.string(),
    parallelGroup: z.string().nullable().optional(),
    requiresPreheat: z.boolean(),
    requiresRest: z.boolean(),
    requiresMarination: z.boolean(),
    isTimingSensitive: z.boolean(),
  })
  .passthrough();

const CanonicalDishWireSchema = z
  .object({
    title: z.string(),
    role: z.string(),
    positionIndex: z.number().optional(),
    ingredients: z.array(CanonicalIngredientWireSchema),
    steps: z.array(CanonicalStepWireSchema).optional(),
  })
  .passthrough();

const CanonicalMealMetaWireSchema = z
  .object({
    title: z.string(),
    description: z.string().optional(),
    cuisineType: z.string(),
    mealType: z.string(),
    estimatedTimeMinutes: z.number(),
    difficulty: z.enum(["easy", "medium", "fancy"]),
    servingsDefault: z.number(),
    sourceUrl: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

const CanonicalRecipeContentWireSchema = z
  .object({
    meal: CanonicalMealMetaWireSchema,
    dishes: z.array(CanonicalDishWireSchema),
  })
  .passthrough();

export type CanonicalRecipeContentWire = z.infer<
  typeof CanonicalRecipeContentWireSchema
>;

// ── Per-endpoint response envelopes ──────────────────────────────────────

const SuccessSourceSchema = z.enum([
  "structured_data",
  "ai_fallback",
  "image",
  "text",
]);

// success branch is shared across all three endpoints — server returns the
// same envelope for url / image / text imports (with different `source`
// discriminants). The success body schema is reused as-is.
const ImportSuccessSchema = z
  .object({
    success: z.literal(true),
    recipe: CanonicalRecipeContentWireSchema,
    source: SuccessSourceSchema,
    sourceUrl: z.string().nullable(),
    caveats: z.array(z.string()).optional(),
  })
  .passthrough();

// Failure branches: per-endpoint `reason` enums and `suggestedAction` enums.
// We use the most-permissive shape (a `z.string()` for both) so a new server-
// added reason doesn't fail validation in the mobile client. Consumers narrow
// to known reasons only.
const ImportFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.string(),
    userFacingMessage: z.string(),
    suggestedAction: z.string().optional(),
    internalError: z.string().optional(),
  })
  .passthrough();

const ImportEnvelopeSchema = z.discriminatedUnion("success", [
  ImportSuccessSchema,
  ImportFailureSchema,
]);

type ImportEnvelope = z.infer<typeof ImportEnvelopeSchema>;

// ─────────────────────────────────────────────────────────────────
// Adapter — canonical recipe → DraftMeal (legacy flat shape)
// ─────────────────────────────────────────────────────────────────

function mapDifficulty(d: "easy" | "medium" | "fancy"): DraftMeal["difficulty"] {
  return d === "fancy" ? "hard" : d;
}

function canonicalToDraftMeal(
  canonical: CanonicalRecipeContentWire,
  sourceUrl: string | null,
): DraftMeal {
  const dishes: ReviewMealDish[] = canonical.dishes.map((d) => ({
    name: d.title,
    ingredients: d.ingredients.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
    })),
  }));

  // Flatten per-dish steps into a meal-level list and renumber stepNumber 1..N.
  let stepCounter = 1;
  const steps: ReviewMealStep[] = [];
  for (const dish of canonical.dishes) {
    for (const step of dish.steps ?? []) {
      steps.push({
        stepNumber: stepCounter++,
        text: step.stepTextTranslated,
        estimatedMinutes: step.estimatedMinutes,
        isTimingSensitive: step.isTimingSensitive,
      });
    }
  }

  return {
    title: canonical.meal.title,
    description: canonical.meal.description,
    cuisineType: canonical.meal.cuisineType,
    difficulty: mapDifficulty(canonical.meal.difficulty),
    estimatedTimeMinutes: canonical.meal.estimatedTimeMinutes,
    servingsDefault: canonical.meal.servingsDefault,
    tags: canonical.meal.tags ?? [],
    caloriesPerServing: 0,
    proteinGPerServing: 0,
    carbsGPerServing: 0,
    fatGPerServing: 0,
    dishes,
    steps,
    // DraftMeal.sourceUrl is `string?`; collapse null (image import) to undefined.
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────
// Shared envelope → typed-result projector
// ─────────────────────────────────────────────────────────────────

function rateLimitedFailure(): {
  success: false;
  reason: "rate_limited";
  userFacingMessage: string;
} {
  return {
    success: false,
    reason: "rate_limited",
    userFacingMessage:
      "Kiwi is catching up on imports — give it a moment and try again.",
  };
}

function sdkErrorFailure(): {
  success: false;
  reason: "sdk_error";
  userFacingMessage: string;
} {
  return {
    success: false,
    reason: "sdk_error",
    userFacingMessage: "Kiwi couldn't read this recipe. Try again in a moment.",
  };
}

// ─────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────

export interface ImportRecipeFromUrlOptions {
  url: string;
}

export type ImportRecipeFromUrlResult =
  | {
      success: true;
      draft: DraftMeal;
      source: "structured_data" | "ai_fallback";
      caveats: string[];
    }
  | {
      success: false;
      userFacingMessage: string;
      reason: "url_parse_failed" | "fetch_error" | "rate_limited" | "sdk_error";
    };

export async function importRecipeFromUrl(
  opts: ImportRecipeFromUrlOptions,
): Promise<ImportRecipeFromUrlResult> {
  const res = await apiClient("/recipes/import-url", {
    method: "POST",
    body: { url: opts.url },
    schema: ImportEnvelopeSchema,
    errorMode: "envelope",
  });

  return projectUrlResult(res);
}

function projectUrlResult(
  res: { success: true; data: ImportEnvelope } | { success: false; error: unknown },
): ImportRecipeFromUrlResult {
  if (!res.success) {
    const err = res.error;
    if (err instanceof ApiError && err.status === 429) {
      return rateLimitedFailure();
    }
    return sdkErrorFailure();
  }
  const body = res.data;
  if (!body.success) {
    // Server `reason` is widened to `z.string()` in the schema for forward-
    // compat. Cast back to the consumer-facing union — unknown reasons fall
    // through as the literal string and consumers default to a generic
    // "import failed" treatment.
    return {
      success: false,
      reason: body.reason as
        | "url_parse_failed"
        | "fetch_error"
        | "rate_limited"
        | "sdk_error",
      userFacingMessage: body.userFacingMessage,
    };
  }
  return {
    success: true,
    draft: canonicalToDraftMeal(body.recipe, body.sourceUrl),
    source: body.source as "structured_data" | "ai_fallback",
    caveats: body.caveats ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────
// Image import (WS6 6c-2)
// ─────────────────────────────────────────────────────────────────

export interface ImportRecipeFromImageOptions {
  imageUris: string[];
}

export type ImportRecipeFromImageResult =
  | {
      success: true;
      draft: DraftMeal;
      source: "image";
      caveats: string[];
    }
  | {
      success: false;
      userFacingMessage: string;
      reason: "url_parse_failed" | "rate_limited" | "sdk_error";
    };

// 1568px @ JPEG 0.7 per Anthropic vision API recommendation — keeps payloads
// ≤200KB to avoid TCP edge drops on larger uploads (locked decision revision
// from Block D, 2026-05-12).
// Two-pass: pass 1 reads original dimensions (empty actions, no base64),
// pass 2 resizes by the longer axis (aspect preserved automatically).
async function prepareImageForUpload(
  uri: string,
): Promise<{ mediaType: "image/jpeg"; data: string }> {
  const probe = await ImageManipulator.manipulateAsync(uri, [], {
    base64: false,
  });
  const longerIsWidth = probe.width >= probe.height;
  const resizeAction: ImageManipulator.Action =
    longerIsWidth
      ? { resize: { width: Math.min(1568, probe.width) } }
      : { resize: { height: Math.min(1568, probe.height) } };

  const processed = await ImageManipulator.manipulateAsync(
    uri,
    [resizeAction],
    {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    },
  );

  if (!processed.base64) {
    throw new Error("ImageManipulator returned no base64 data");
  }

  return { mediaType: "image/jpeg", data: processed.base64 };
}

export async function importRecipeFromImage(
  opts: ImportRecipeFromImageOptions,
): Promise<ImportRecipeFromImageResult> {
  let images: { mediaType: "image/jpeg"; data: string }[];
  try {
    images = await Promise.all(opts.imageUris.map(prepareImageForUpload));
  } catch {
    return {
      success: false,
      reason: "sdk_error",
      userFacingMessage:
        "Kiwi couldn't read one of those photos. Try picking it again.",
    };
  }

  const res = await apiClient("/recipes/import-image", {
    method: "POST",
    body: { images },
    schema: ImportEnvelopeSchema,
    errorMode: "envelope",
  });

  if (!res.success) {
    const err = res.error;
    if (err instanceof ApiError && err.status === 429) {
      return rateLimitedFailure();
    }
    return sdkErrorFailure();
  }
  const body = res.data;
  if (!body.success) {
    return {
      success: false,
      reason: body.reason as "url_parse_failed" | "rate_limited" | "sdk_error",
      userFacingMessage: body.userFacingMessage,
    };
  }
  return {
    success: true,
    draft: canonicalToDraftMeal(body.recipe, body.sourceUrl),
    source: "image",
    caveats: body.caveats ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────
// Text import (WS6 6c-3)
// ─────────────────────────────────────────────────────────────────

export interface ImportRecipeFromTextOptions {
  rawText: string;
}

export type ImportRecipeFromTextResult =
  | {
      success: true;
      draft: DraftMeal;
      source: "text";
      caveats: string[];
    }
  | {
      success: false;
      userFacingMessage: string;
      reason: "url_parse_failed" | "rate_limited" | "sdk_error";
    };

export async function importRecipeFromText(
  opts: ImportRecipeFromTextOptions,
): Promise<ImportRecipeFromTextResult> {
  const res = await apiClient("/recipes/import-text", {
    method: "POST",
    body: { rawText: opts.rawText },
    schema: ImportEnvelopeSchema,
    errorMode: "envelope",
  });

  if (!res.success) {
    const err = res.error;
    if (err instanceof ApiError && err.status === 429) {
      return rateLimitedFailure();
    }
    return sdkErrorFailure();
  }
  const body = res.data;
  if (!body.success) {
    return {
      success: false,
      reason: body.reason as "url_parse_failed" | "rate_limited" | "sdk_error",
      userFacingMessage: body.userFacingMessage,
    };
  }
  return {
    success: true,
    draft: canonicalToDraftMeal(body.recipe, body.sourceUrl),
    source: "text",
    caveats: body.caveats ?? [],
  };
}
