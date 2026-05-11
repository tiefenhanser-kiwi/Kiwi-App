// Mobile client for POST /api/recipes/import-url (WS6 6c-1).
// Calls the server endpoint and adapts the canonical recipe response into
// the DraftMeal shape the existing meal-review/edit screen consumes.
//
// The canonical → DraftMeal adapter is a deliberate throwaway: it lives at
// the client boundary so the rest of the app stays on the legacy DraftMeal
// shape until WS7 lands a first-class import flow. The server preserves
// the full canonical recipe in LLMCallLog, so nothing is lost in the
// adapter.

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

interface ImportUrlSuccessResponse {
  success: true;
  recipe: CanonicalRecipeContentWire;
  source: "structured_data" | "ai_fallback";
  sourceUrl: string;
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

// ─────────────────────────────────────────────────────────────────
// Adapter — canonical recipe → DraftMeal (legacy flat shape)
// ─────────────────────────────────────────────────────────────────

function mapDifficulty(d: "easy" | "medium" | "fancy"): DraftMeal["difficulty"] {
  return d === "fancy" ? "hard" : d;
}

function canonicalToDraftMeal(
  canonical: CanonicalRecipeContentWire,
  sourceUrl: string,
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
    sourceUrl,
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

  return {
    success: true,
    draft: canonicalToDraftMeal(body.recipe, body.sourceUrl),
    source: body.source,
    caveats: body.caveats ?? [],
  };
}
