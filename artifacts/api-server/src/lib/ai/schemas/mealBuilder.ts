import { z } from "zod";

// WS6 6b-4 — Kiwi-assist schemas for the Dish Builder / Meal Builder Mode B
// "Help with ingredients" + "Help with steps" checkboxes. Per PRD §1.2 these
// flows are FREE: the user supplies the dish name + (optionally) some
// ingredients, and Kiwi fills in the rest. Server-only sub-phase; mobile
// wiring lives in WS7.

// ─── Assist ingredients ──────────────────────────────────────────────────

// One row of what the user already typed into the ingredients section.
// quantity + unit are optional — the user may have only entered a name.
export const AssistIngredientsExistingItemSchema = z.object({
  name: z.string().min(1).max(120),
  quantity: z.number().positive().optional(),
  unit: z.string().max(40).optional(),
});
export type AssistIngredientsExistingItem = z.infer<
  typeof AssistIngredientsExistingItemSchema
>;

export const AssistIngredientsInputSchema = z.object({
  dishTitle: z.string().min(1).max(200),
  cuisine: z.string().max(80).optional(),
  existingIngredients: z.array(AssistIngredientsExistingItemSchema).max(40),
  servings: z.number().int().positive().max(99),
  userHints: z
    .object({
      dietary: z.array(z.string().max(40)).max(10).optional(),
      allergens: z.array(z.string().max(40)).max(20).optional(),
    })
    .optional(),
});
export type AssistIngredientsInput = z.infer<
  typeof AssistIngredientsInputSchema
>;

export const AssistedIngredientSchema = z.object({
  name: z.string().min(1).max(120),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(40),
  isOptional: z.boolean().optional(),
  // Mutually exclusive with addedByKiwi — the prompt enforces. Schema admits
  // both as booleans and the route layer trusts that the prompt obeys (a bad
  // pair would be a quality issue, not a correctness one — both flags simply
  // help the form show a diff).
  isUserProvided: z.boolean(),
  addedByKiwi: z.boolean(),
});
export type AssistedIngredient = z.infer<typeof AssistedIngredientSchema>;

export const AssistIngredientsResultSchema = z.object({
  ingredients: z.array(AssistedIngredientSchema).min(1).max(40),
  caveats: z.array(z.string().max(80)).max(3).optional(),
});
export type AssistIngredientsResult = z.infer<
  typeof AssistIngredientsResultSchema
>;

// ─── Assist steps ────────────────────────────────────────────────────────

// One row of the (already-complete) ingredient list passed in to the steps
// helper. Quantities + units are required here — Mode B's "Help with steps"
// path only fires after the ingredient list is settled.
export const AssistStepsIngredientSchema = z.object({
  name: z.string().min(1).max(120),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(40),
});
export type AssistStepsIngredient = z.infer<typeof AssistStepsIngredientSchema>;

export const AssistStepsInputSchema = z.object({
  dishTitle: z.string().min(1).max(200),
  cuisine: z.string().max(80).optional(),
  ingredients: z.array(AssistStepsIngredientSchema).min(1).max(40),
  servings: z.number().int().positive().max(99),
  prepTimeMinutes: z.number().int().nonnegative().max(600).optional(),
  cookTimeMinutes: z.number().int().nonnegative().max(600).optional(),
});
export type AssistStepsInput = z.infer<typeof AssistStepsInputSchema>;

// Phase tag feeds 6c-1 reformat-for-Kiwi and the Cooking Sequencer (§13.5.4).
// Naming intentionally mirrors PRD §10.6.1 step-phase taxonomy.
export const StepPhaseTypeSchema = z.enum([
  "prep",
  "preheat",
  "cook",
  "rest",
  "assemble",
  "hold",
]);
export type StepPhaseType = z.infer<typeof StepPhaseTypeSchema>;

export const AssistedStepSchema = z.object({
  content: z.string().min(1).max(280),
  estimatedMinutes: z.number().int().positive().max(600),
  phaseType: StepPhaseTypeSchema,
  isTimingSensitive: z.boolean().optional(),
  parallelGroup: z.number().int().positive().max(20).optional(),
});
export type AssistedStep = z.infer<typeof AssistedStepSchema>;

export const AssistStepsResultSchema = z.object({
  steps: z.array(AssistedStepSchema).min(1).max(20),
  caveats: z.array(z.string().max(80)).max(3).optional(),
});
export type AssistStepsResult = z.infer<typeof AssistStepsResultSchema>;

// ─── Mode A: parse meal from free-text ───────────────────────────────────

// WS6 6b-5 — Meal Builder Mode A. The user types a free-text meal description
// ("Chicken piccata with arugula salad and lemon vinaigrette") and Mode A
// returns one Meal with one or more sub-dishes. Premium-gated per PRD §1.2
// (entitlement key: meal_builder_text_input).

// Sub-dish roles per PRD §10.4.2 — drives the Meal Detail rendering layout.
export const SubDishRoleSchema = z.enum([
  "main",
  "side",
  "sauce",
  "topping",
  "base",
]);
export type SubDishRole = z.infer<typeof SubDishRoleSchema>;

// Difficulty enum matches Mode B form values + PRD §10.4.1 plan-level
// difficulty taxonomy (easy / medium / fancy).
export const MealDifficultySchema = z.enum(["easy", "medium", "fancy"]);
export type MealDifficulty = z.infer<typeof MealDifficultySchema>;

export const ParseMealInputSchema = z.object({
  // PRD Tell Kiwi input bounds — single short paragraph at most.
  freeText: z.string().min(3).max(500),
  servings: z.number().int().positive().max(99).default(4),
  userHints: z
    .object({
      dietary: z.array(z.string().max(40)).max(10).optional(),
      allergens: z.array(z.string().max(40)).max(20).optional(),
      cuisinesLiked: z.array(z.string().max(40)).max(10).optional(),
    })
    .optional(),
});
export type ParseMealInput = z.infer<typeof ParseMealInputSchema>;

export const ParsedSubDishIngredientSchema = z.object({
  name: z.string().min(1).max(120),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(40),
  isOptional: z.boolean().optional(),
});
export type ParsedSubDishIngredient = z.infer<
  typeof ParsedSubDishIngredientSchema
>;

// Reuses the same StepPhaseType taxonomy as Mode B's assist-steps so the
// Cooking Sequencer (6d-1) doesn't have to bridge two enums.
export const ParsedSubDishStepSchema = z.object({
  content: z.string().min(1).max(280),
  estimatedMinutes: z.number().int().positive().max(600),
  phaseType: StepPhaseTypeSchema,
  isTimingSensitive: z.boolean().optional(),
  // parallelGroup is nullable here (Mode A may omit on truly-sequential
  // steps) — Mode B's assist-steps treats it as optional+undefined; Mode A
  // lets the model emit null explicitly when it considered the step and
  // decided it's not parallelizable.
  parallelGroup: z.number().int().positive().max(20).nullable().optional(),
});
export type ParsedSubDishStep = z.infer<typeof ParsedSubDishStepSchema>;

export const ParsedSubDishSchema = z.object({
  title: z.string().min(1).max(200),
  role: SubDishRoleSchema,
  positionIndex: z.number().int().nonnegative().max(10),
  ingredients: z.array(ParsedSubDishIngredientSchema).min(1).max(30),
  steps: z.array(ParsedSubDishStepSchema).min(1).max(20),
});
export type ParsedSubDish = z.infer<typeof ParsedSubDishSchema>;

export const ParsedMealSchema = z.object({
  title: z.string().min(1).max(200),
  // Canonical lowercase per PRD §3.4. Nullable when the description doesn't
  // imply a cuisine (e.g. "grain bowl").
  cuisine: z.string().min(1).max(80).nullable(),
  estimatedPrepMinutes: z.number().int().positive().max(600),
  estimatedCookMinutes: z.number().int().positive().max(600),
  servingsDefault: z.number().int().positive().max(99),
  difficulty: MealDifficultySchema,
  tags: z.array(z.string().min(1).max(40)).max(5),
  subDishes: z.array(ParsedSubDishSchema).min(1).max(5),
});
export type ParsedMeal = z.infer<typeof ParsedMealSchema>;

export const ParseMealResultSchema = z.object({
  meal: ParsedMealSchema,
  caveats: z.array(z.string().max(80)).max(3).optional(),
});
export type ParseMealResult = z.infer<typeof ParseMealResultSchema>;
