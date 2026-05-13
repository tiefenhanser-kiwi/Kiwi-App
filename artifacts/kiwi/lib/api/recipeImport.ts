// Mobile client for POST /api/recipes/import-url (WS6 6c-1) and
// POST /api/recipes/import-image (WS6 6c-2). Calls the server endpoint and
// adapts the canonical recipe response into the DraftMeal shape the existing
// meal-review/edit screen consumes.
//
// The canonical → DraftMeal adapter is a deliberate throwaway: it lives at
// the client boundary so the rest of the app stays on the legacy DraftMeal
// shape until WS7 lands a first-class import flow. The server preserves
// the full canonical recipe in LLMCallLog, so nothing is lost in the
// adapter.

import * as ImageManipulator from "expo-image-manipulator";

import { readToken } from "../auth";
import type { DraftMeal, ReviewMealDish, ReviewMealStep } from "../types";

const apiBase =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "http://localhost:3000/api");

// ─────────────────────────────────────────────────────────────────
// Wire shapes — mirror artifacts/api-server/src/lib/ai/schemas/reformat.ts
// ─────────────────────────────────────────────────────────────────

interface CanonicalIngredientWire {
  name: string;
  quantity: number;
  unit: string;
  preparationNote?: string;
  isOptional?: boolean;
}

interface CanonicalStepWire {
  stepIndex: number;
  stepTextRaw: string;
  stepTextTranslated: string;
  estimatedMinutes: number;
  phaseType: string;
  parallelGroup?: string | null;
  requiresPreheat: boolean;
  requiresRest: boolean;
  requiresMarination: boolean;
  isTimingSensitive: boolean;
}

interface CanonicalDishWire {
  title: string;
  role: string;
  positionIndex?: number;
  ingredients: CanonicalIngredientWire[];
  steps?: CanonicalStepWire[];
}

interface CanonicalMealMetaWire {
  title: string;
  description?: string;
  cuisineType: string;
  mealType: string;
  estimatedTimeMinutes: number;
  difficulty: "easy" | "medium" | "fancy";
  servingsDefault: number;
  sourceUrl?: string;
  tags?: string[];
}

export interface CanonicalRecipeContentWire {
  meal: CanonicalMealMetaWire;
  dishes: CanonicalDishWire[];
}

// 6c-3 — source widened to include 'image' and 'text' for the image/text routes.
// The URL endpoint still only returns 'structured_data' | 'ai_fallback' at
// runtime; consumers should narrow against sourceUrl !== null when needed.
interface ImportUrlSuccessResponse {
  success: true;
  recipe: CanonicalRecipeContentWire;
  source: "structured_data" | "ai_fallback" | "image" | "text";
  sourceUrl: string | null;
  caveats?: string[];
}

interface ImportUrlFailureResponse {
  success: false;
  reason: "url_parse_failed" | "fetch_error" | "rate_limited" | "sdk_error";
  userFacingMessage: string;
  suggestedAction: "try_image_import";
  internalError?: string;
}

export type URLImportResult = ImportUrlSuccessResponse | ImportUrlFailureResponse;

interface ImportImageFailureResponse {
  success: false;
  reason: "url_parse_failed" | "rate_limited" | "sdk_error";
  userFacingMessage: string;
  suggestedAction: "try_text_import";
  internalError?: string;
}

type ImageImportResult = ImportUrlSuccessResponse | ImportImageFailureResponse;

// 6c-3 — text import suggests image as the cleanest fallback for a failed paste.
interface ImportTextFailureResponse {
  success: false;
  reason: "url_parse_failed" | "rate_limited" | "sdk_error";
  userFacingMessage: string;
  suggestedAction: "try_image_import";
  internalError?: string;
}

type TextImportResult = ImportUrlSuccessResponse | ImportTextFailureResponse;

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
      reason: ImportUrlFailureResponse["reason"];
    };

export async function importRecipeFromUrl(
  opts: ImportRecipeFromUrlOptions,
): Promise<ImportRecipeFromUrlResult> {
  const token = await readToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const res = await fetch(`${apiBase}/recipes/import-url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ url: opts.url }),
  });

  if (res.status === 429) {
    return {
      success: false,
      reason: "rate_limited",
      userFacingMessage:
        "Kiwi is catching up on imports — give it a moment and try again.",
    };
  }

  let body: URLImportResult;
  try {
    body = (await res.json()) as URLImportResult;
  } catch {
    return {
      success: false,
      reason: "sdk_error",
      userFacingMessage:
        "Kiwi couldn't read this recipe. Try again in a moment.",
    };
  }

  if (!body.success) {
    return {
      success: false,
      reason: body.reason,
      userFacingMessage: body.userFacingMessage,
    };
  }

  // Wire `source` union includes 'image' (Block C shared type) but the URL
  // endpoint only ever returns 'structured_data' | 'ai_fallback' at runtime.
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
      reason: ImportImageFailureResponse["reason"];
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
  const token = await readToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

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

  const res = await fetch(`${apiBase}/recipes/import-image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ images }),
  });

  if (res.status === 429) {
    return {
      success: false,
      reason: "rate_limited",
      userFacingMessage:
        "Kiwi is catching up on imports — give it a moment and try again.",
    };
  }

  let body: ImageImportResult;
  try {
    body = (await res.json()) as ImageImportResult;
  } catch {
    return {
      success: false,
      reason: "sdk_error",
      userFacingMessage:
        "Kiwi couldn't read this recipe. Try again in a moment.",
    };
  }

  if (!body.success) {
    return {
      success: false,
      reason: body.reason,
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
      reason: ImportTextFailureResponse["reason"];
    };

export async function importRecipeFromText(
  opts: ImportRecipeFromTextOptions,
): Promise<ImportRecipeFromTextResult> {
  const token = await readToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const res = await fetch(`${apiBase}/recipes/import-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ rawText: opts.rawText }),
  });

  if (res.status === 429) {
    return {
      success: false,
      reason: "rate_limited",
      userFacingMessage:
        "Kiwi is catching up on imports — give it a moment and try again.",
    };
  }

  let body: TextImportResult;
  try {
    body = (await res.json()) as TextImportResult;
  } catch {
    return {
      success: false,
      reason: "sdk_error",
      userFacingMessage:
        "Kiwi couldn't read this recipe. Try again in a moment.",
    };
  }

  if (!body.success) {
    return {
      success: false,
      reason: body.reason,
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
