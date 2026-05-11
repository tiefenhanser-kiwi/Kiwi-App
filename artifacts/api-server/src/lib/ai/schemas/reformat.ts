import { z } from "zod";

import { StepPhaseSchema } from "./cookNow";

// PRD §10.9 — Reformat-for-Kiwi pass. Runs after every recipe import
// (URL parse fallback, image parse, manual Mode A) per 6c-1.
// Output writes into Meal/Dish + RecipeInstructionStep tables.

// ─────────────────────────────────────────────────────────────────
// Closed enums — kept 1:1 with Prisma + kiwi/lib/domain.ts
// ─────────────────────────────────────────────────────────────────

// Source of truth: artifacts/kiwi/lib/domain.ts CUISINES_TIER_1 + CUISINES_TIER_2.
// Duplicated here because api-server tsconfig does not include the kiwi workspace.
// Keep exact title-case + slashes ("BBQ/Grill", "Cajun/Creole"). 24 catalog + Other.
export const CUISINE_TYPES = [
  "American",
  "Italian",
  "Mexican",
  "Asian",
  "Mediterranean",
  "Indian",
  "Comfort Food",
  "BBQ/Grill",
  "Chinese",
  "Japanese",
  "Thai",
  "Vietnamese",
  "Korean",
  "Middle Eastern",
  "French",
  "Spanish",
  "Greek",
  "Caribbean",
  "African",
  "Cajun/Creole",
  "Tex-Mex",
  "Latin American",
  "Soul Food",
  "Brazilian",
  "Other",
] as const;
export const CuisineTypeEnum = z.enum(CUISINE_TYPES);
export type CuisineType = z.infer<typeof CuisineTypeEnum>;

// Prisma MealType — 5 values. dessert/sauce/side collapse into snack/mixed at write time.
export const MealTypeEnum = z.enum([
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "mixed",
]);
export type MealType = z.infer<typeof MealTypeEnum>;

// Prisma StepPhase — re-exported from cookNow.ts so reformat + cookNow stay
// in sync on the 6-value enum (schema.prisma:88-95).
export const StepPhaseEnum = StepPhaseSchema;

export const DishRoleEnum = z.enum([
  "main",
  "side",
  "sauce",
  "topping",
  "base",
  "optional",
]);
export type DishRole = z.infer<typeof DishRoleEnum>;

export const DifficultyEnum = z.enum(["easy", "medium", "fancy"]);
export type Difficulty = z.infer<typeof DifficultyEnum>;

// ─────────────────────────────────────────────────────────────────
// Raw upstream input — what the route layer passes to the AI
// ─────────────────────────────────────────────────────────────────

const StructuredHintIngredientSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  preparationNote: z.string().optional(),
  isOptional: z.boolean().optional(),
});

export const RawRecipeInputSchema = z.object({
  url: z.string(),
  rawHtml: z.string().optional(),
  rawText: z.string().optional(),
  structuredHints: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      ingredients: z.array(StructuredHintIngredientSchema).optional(),
      steps: z.array(z.string()).optional(),
      servingsDefault: z.number().int().positive().optional(),
      sourceAttribution: z.string().optional(),
    })
    .optional(),
});
export type RawRecipeInput = z.infer<typeof RawRecipeInputSchema>;

// ─────────────────────────────────────────────────────────────────
// Canonical recipe content — what the AI returns on success
// ─────────────────────────────────────────────────────────────────

export const IngredientSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1),
  preparationNote: z.string().max(120).optional(),
  isOptional: z.boolean().optional(),
});
export type CanonicalIngredient = z.infer<typeof IngredientSchema>;

// parallelGroup matches Prisma RecipeInstructionStep.parallelGroup (String?).
// D-WS6-034: AssistedStep/ParsedSubDishStep use number — reconcile in WS7 / 6c-CLOSE.
export const StepSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  stepTextRaw: z.string(),
  stepTextTranslated: z.string(),
  estimatedMinutes: z.number().int().nonnegative(),
  phaseType: StepPhaseEnum,
  parallelGroup: z.string().nullable().optional(),
  requiresPreheat: z.boolean(),
  requiresRest: z.boolean(),
  requiresMarination: z.boolean(),
  isTimingSensitive: z.boolean(),
});
export type CanonicalStep = z.infer<typeof StepSchema>;

export const DishSchema = z.object({
  title: z.string().min(1),
  role: DishRoleEnum,
  positionIndex: z.number().int().nonnegative().optional(),
  ingredients: z.array(IngredientSchema).min(1),
  steps: z.array(StepSchema).default([]),
});
export type CanonicalDish = z.infer<typeof DishSchema>;

export const MealMetaSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  cuisineType: CuisineTypeEnum,
  mealType: MealTypeEnum,
  estimatedTimeMinutes: z.number().int().nonnegative(),
  difficulty: DifficultyEnum,
  servingsDefault: z.number().int().min(1).max(16),
  sourceUrl: z.string().optional(),
  tags: z.array(z.string()).max(8).default([]),
});
export type CanonicalMealMeta = z.infer<typeof MealMetaSchema>;

export const CanonicalRecipeContentSchema = z
  .object({
    meal: MealMetaSchema,
    dishes: z.array(DishSchema).min(1).max(8),
  })
  // 6c-1-fix guardrail: a success-shape recipe with no cooking steps across any
  // dish is almost certainly a paywall placeholder. Force the model to use
  // status: "no_recipe_content" instead. Anchored on the content schema (not
  // the discriminated union) so the no_recipe_content branch is unaffected.
  .superRefine((data, ctx) => {
    const allStepsEmpty = data.dishes.every((d) => !d.steps || d.steps.length === 0);
    if (allStepsEmpty) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Success-shape recipe must include at least one cooking step across all dishes. " +
          "If the source had no recipe content, return status: 'no_recipe_content' instead.",
        path: ["dishes"],
      });
    }
  });
export type CanonicalRecipeContent = z.infer<typeof CanonicalRecipeContentSchema>;

// Discriminated union on status — success path carries recipe; failure carries reason.
export const CanonicalRecipeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    recipe: CanonicalRecipeContentSchema,
    caveats: z.array(z.string().max(100)).max(3).optional(),
  }),
  z.object({
    status: z.literal("no_recipe_content"),
    reason: z.string(),
  }),
]);
export type CanonicalRecipe = z.infer<typeof CanonicalRecipeSchema>;

// ─────────────────────────────────────────────────────────────────
// URL-import failure envelope — what the route returns on parse failure
// ─────────────────────────────────────────────────────────────────

export const URL_IMPORT_FAILURE_MESSAGE =
  "Kiwi couldn't read this recipe. Common reasons are paywalls, JavaScript-rendered pages, or non-standard formats. Try taking a screenshot of the recipe and using Import from Image instead.";

export const URLImportFailureSchema = z.object({
  success: z.literal(false),
  reason: z.enum([
    "url_parse_failed",
    "fetch_error",
    "rate_limited",
    "sdk_error",
  ]),
  userFacingMessage: z.string(),
  suggestedAction: z.literal("try_image_import"),
  internalError: z.string().optional(),
});
export type URLImportFailure = z.infer<typeof URLImportFailureSchema>;
