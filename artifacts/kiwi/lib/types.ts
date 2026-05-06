// Shared domain types for the Kiwi client.
// Previously colocated with mock recipe data in mockData.ts; extracted
// during WS1 so types can outlive the mock data layer.

export type DayKey = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export interface Ingredient {
  name: string;
  amount: string;
  category: "Produce" | "Protein" | "Dairy" | "Pantry" | "Bakery" | "Frozen";
}

export interface Recipe {
  id: string;
  title: string;
  cuisine: string;
  minutes: number;
  servings: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  image: any; // ImageSourcePropType from react-native — typed loosely to avoid pulling RN types into lib
  ingredients: Ingredient[];
  steps: string[];
  tags: string[];
}

export interface MealSlot {
  day: DayKey;
  slot: "Breakfast" | "Lunch" | "Dinner";
  recipeId: string;
  reason?: string;
}

export interface MealPlan {
  id: string;
  name: string;
  notes?: string;
  createdAt: number;
  weekStart: string;
  meals: MealSlot[];
}

export interface GroceryItem {
  id: string;
  name: string;
  amount: string;
  category: Ingredient["category"];
  checked: boolean;
}

export type Subscription = {
  status: "trialing" | "active" | "past_due" | "canceled" | "none";
  planCode: "free" | "premium_monthly" | "premium_annual";
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
};

export type MealsFilter = "my_meals" | "all_meals";

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  zipCode: string | null;
  timezone: string;
  accountStatus: string;
  subscriptionStatus: string;
  defaultHouseholdSize: number;
  lastPlanDiscoveryFilters: string[];
  lastPlansFilters: string[];
  lastMealsFilters: string[];
  subscription: Subscription | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────
// PRD-aligned plan review types (WS5+)
// Parallel to legacy MealPlan/MealSlot above; collapses in WS7.
// ─────────────────────────────────────────────────────────────────

/** PRD §2.4 — server schema mirror. Day strip uses these labels. */
export type DayOfWeek =
  | "Sunday" | "Monday" | "Tuesday" | "Wednesday"
  | "Thursday" | "Friday" | "Saturday";

/** Short-form for the day strip pills in PlanReviewMealRow. */
export const DAY_SHORT: Record<DayOfWeek, string> = {
  Sunday: "S", Monday: "M", Tuesday: "T", Wednesday: "W",
  Thursday: "T", Friday: "F", Saturday: "S",
};

/** Daily macro averages displayed on Plan Review per PRD §8.3.5. */
export interface MacroDailyAverage {
  caloriesPerDay: number;
  proteinGPerDay: number;
  carbsGPerDay: number;
  fatGPerDay: number;
}

/**
 * Per-instance recipe override per PRD §8.4.3.
 * Serialized into MealPlanItem.recipeOverrideJson (WS5-5B schema).
 * When present, this overrides the linked Meal's recipe for THIS
 * plan instance only. Promote to Meal record via the §2.5
 * "save to my meal forever" path.
 */
export interface RecipeOverride {
  /** Display title; falls back to Meal.title if omitted. */
  titleOverride?: string;
  /** Override ingredients per dish, by dish position index. */
  dishes: RecipeOverrideDish[];
  /** Optional override for full step list. */
  steps?: string[];
  /** ISO timestamp when override was created. */
  createdAt: string;
}

export interface RecipeOverrideDish {
  name: string;
  ingredients: RecipeOverrideIngredient[];
}

export interface RecipeOverrideIngredient {
  name: string;
  quantity: number;
  unit: string;
}

/** Day strip pill state for PlanReviewMealRow. */
export interface DayAssignment {
  day: DayOfWeek;
  /** Date number to display (e.g., 14 for "Tuesday the 14th"). */
  dateNumber?: number;
  isAssigned: boolean;
}

/** Single meal row on the Plan Review screen per PRD §8.3.6. */
export interface ReviewPlanMealRow {
  /** MealPlanItem.id — stable identifier for mutations. */
  planItemId: string;
  /** Meal.id — what mealId points to in the schema. */
  mealId: string;
  title: string;
  thumbnailUrl?: string;
  /** "Easy · 30 min · serves 4" */
  metaLine: string;
  /** Per-serving display values for the row's macros line. */
  caloriesPerServing?: number;
  proteinGPerServing?: number;
  carbsGPerServing?: number;
  fatGPerServing?: number;
  /** Day strip — 7 entries Sun-Sat with assignment state. */
  dayStrip: DayAssignment[];
  /** True when this row's MealPlanItem has a recipeOverrideJson set. */
  hasRecipeOverride: boolean;
}

/** Optimization panel bullet per PRD §8.3.4. */
export interface OptimizationNote {
  type: "prep" | "cost";
  text: string;
}

/** Prep status indicator state per PRD §8.3.3. */
export type PrepStatus = "not_prepped" | "prepped" | "partially_prepped";

/**
 * Full Plan Review payload — what getReviewPlan(planId) returns.
 * Mirrors the server-side composite endpoint that lands in WS7.
 */
export interface ReviewPlan {
  /** MealPlanInstance.id */
  id: string;
  name: string;
  prepStatus: PrepStatus;
  optimizationNotes: OptimizationNote[];
  macroDailyAverage: MacroDailyAverage;
  /** Dinners + any other scheduled meals, with day strip state. */
  scheduledMeals: ReviewPlanMealRow[];
  /** Meals with no day assignment per PRD §8.3.6. */
  unscheduledMeals: ReviewPlanMealRow[];
  /** User-level breakfast defaults per PRD §8.3.7 (text suggestions). */
  breakfastDefaults: string;
  /** User-level lunch defaults per PRD §8.3.7. */
  lunchDefaults: string;
  /** ISO date string ("YYYY-MM-DD") for the plan's start date.
   *  Drives the date-range editor (PRD §8 / §11). Optional so legacy
   *  demo branches without dates don't break. */
  weekStartDate?: string;
  /** ISO date string ("YYYY-MM-DD") for the plan's end date. */
  weekEndDate?: string;
}

/**
 * Compact plan summary for picker lists (Add to Plan flow).
 * Subset of MealPlan + ReviewPlan — what's needed to render
 * a row + identify the plan.
 */
export interface UserPlanSummary {
  id: string;
  name: string;
  /** ISO date string. */
  weekStartDate?: string;
  /** ISO date string. */
  weekEndDate?: string;
  /** "active" | "completed" | "draft" — matches MealPlan.status */
  status: "active" | "completed" | "draft";
  /** Number of meals currently in this plan. */
  mealCount: number;
  /** ISO timestamp when plan was created. */
  createdAt: string;
}

/**
 * Action keys for PlanReviewMealRow inline buttons per PRD §8.4.1
 * (amended to 5 actions per WS5 product decision).
 */
export type PlanReviewMealAction =
  | "view_details"
  | "change_meal"
  | "change_recipe"
  | "find_similar"
  | "compost";

/**
 * Full meal detail per PRD §10.6.
 * What getMealById returns; what app/meal/[id].tsx renders.
 */
export interface ReviewMeal {
  id: string;
  title: string;
  description?: string;
  cuisineType?: string;
  difficulty: "easy" | "medium" | "hard";
  estimatedTimeMinutes: number;
  servingsDefault: number;
  imageUrl?: string;
  tags: string[];
  /** Per-serving macros. */
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  /** Ingredients grouped by sub-dish (per PRD §10.6.1). */
  dishes: ReviewMealDish[];
  /** Recipe steps, ordered. */
  steps: ReviewMealStep[];
  /** User notes (free text). */
  notes?: string;
  /** True when accessed from a plan context AND that plan-item has
   *  a recipeOverrideJson active — drives the §2.5 banner. */
  hasActivePlanOverride?: boolean;
  /** When hasActivePlanOverride is true, the planId + planItemId
   *  context for the override (so promote/dismiss know what to act on). */
  overrideContext?: { planId: string; planItemId: string };
}

export interface ReviewMealDish {
  name: string;
  ingredients: ReviewMealIngredient[];
}

export interface ReviewMealIngredient {
  quantity: number;
  unit: string;
  name: string;
}

export interface ReviewMealStep {
  stepNumber: number;
  text: string;
  estimatedMinutes?: number;
  /** Optional: timing-sensitive steps render in terracotta per PRD §10.6.1 */
  isTimingSensitive?: boolean;
}

/**
 * Saved dish for Meal Builder Mode C (combine saved dishes).
 * Real data ships in WS7 from /me/dishes endpoint.
 */
export interface SavedDish {
  id: string;
  name: string;
  cuisineType?: string;
  imageUrl?: string;
  ingredients: SavedDishIngredient[];
  /** Per-serving values; default servings is 4. */
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  /** Number of meals this dish appears in. */
  useCount?: number;
  /** ISO timestamp when the dish was created. Drives "Date added" sort
   *  (PRD §10.5 / DishChooserSheet). Optional so legacy stub rows don't break. */
  createdAt?: string;
  /** ISO timestamp of the last time this dish was cooked. Drives
   *  "Last cooked" sort. Optional — undefined means never. */
  lastCookedAt?: string;
  /** Estimated cook time in minutes. Drives "Cook time" sort. Optional —
   *  undefined treated as 0 (e.g. simple/store-bought dishes). */
  estimatedTimeMinutes?: number;
  /** Catalog source for the Recipes tab Dishes view chip row
   *  (PRD §9.3). Optional so legacy stub rows don't break. */
  source?: "saved" | "featured" | "top_rated";
  /** Recipe steps (optional, PRD §10.5). Rendered on Dish Detail
   *  when present. Demo dishes lack steps; user-authored dishes
   *  via the Dish Builder may include them. */
  steps?: ReviewMealStep[];
  /** Free-form notes shown on Dish Detail when present. */
  notes?: string;
}

export interface SavedDishIngredient {
  quantity: number;
  unit: string;
  name: string;
}

/**
 * Compact meal summary for picker lists (Change Meal, Add Meals).
 * Subset of ReviewMeal — just what's needed to render a row +
 * round-trip through changeMealForPlanItem.
 */
export interface MealSummary {
  id: string;
  title: string;
  cuisineType?: string;
  difficulty: "easy" | "medium" | "hard";
  estimatedTimeMinutes: number;
  servingsDefault: number;
  imageUrl?: string;
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  /** Catalog source for the picker chip row (PRD §4.2.5). */
  source: "saved" | "featured" | "top_rated" | "hosting";
  /** Times the user has cooked this meal (saved meals only). */
  timesCooked?: number;
  /** ISO timestamp; saved meals only. */
  lastCookedAt?: string;
  createdAt?: string;
}

/**
 * Parsed-but-not-yet-saved meal data, passed from Import URL /
 * Import Image / future paste-text flows to Meal Builder for
 * review and edit before save.
 * Mirrors ReviewMeal but without an id (no save record yet).
 */
export interface DraftMeal {
  title: string;
  description?: string;
  cuisineType?: string;
  difficulty: "easy" | "medium" | "hard";
  estimatedTimeMinutes: number;
  servingsDefault: number;
  imageUrl?: string;
  tags: string[];
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  dishes: ReviewMealDish[];
  steps: ReviewMealStep[];
  notes?: string;
  /** Source URL (for Import URL) — populated only when source is URL parse. */
  sourceUrl?: string;
}

/**
 * PRD §5.5 — single plan candidate from wizard plan generation.
 * Real AI shape lands in WS6 per PRD §5.7.
 */
export interface WizardPlanCandidate {
  /** Stub identifier; WS7 generates real UUIDs. */
  id: string;
  title: string;
  /** Optional curated/AI-generated image URL. */
  imageUrl?: string;
  /** "Featured" / "Top Rated" / undefined for no badge. */
  badge?: "featured" | "top_rated";
  /** 3 short tags shown above the why-box. */
  tags: string[];
  /** 1-2 short "why this works" bullets. */
  whyBullets: string[];
  /** 5 meal titles for the preview list. */
  mealTitles: string[];
  /** Daily-average macros for the plan. */
  dailyMacros: {
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
  };
}

/**
 * PRD §6.3 — input shape for Just Say What You Want (Tell Kiwi).
 * Server's POST /api/wizard/build-from-text payload (WS6).
 */
export interface TellKiwiInput {
  /** Multi-line description; 5-500 chars. */
  description: string;

  // Optional pref overrides (default to user's saved preferences)
  householdSize: number;          // 1-30
  wantsLeftovers: boolean;

  // Dietary expansion (collapsed by default)
  eatingStyles: string[];         // From EATING_STYLES catalog
  allergiesAndAvoidances: string[]; // From ALLERGIES_AND_AVOIDANCES
  dietaryNotes?: string;          // "no shellfish, low sodium"
}

/**
 * PRD §5.3 — input shape for the Set Preferences wizard.
 * Server's POST /api/wizard/build-plans payload (WS6 / WS7).
 */
export interface WizardPreferencesInput {
  // Required
  planDurationDays: number;
  householdSize: number;
  wantsLeftovers: boolean;

  // Multi-select preferences (all optional, may be empty arrays)
  cuisines: string[];
  eatingStyles: string[];
  allergiesAndAvoidances: string[];

  // Single-select
  difficulty: "easy" | "medium" | "fancy";
  weeklyPacing:
    | "mostly_easy"
    | "mixed"
    | "one_fancy"
    | "minimal_effort";

  // Optional free text
  dietaryNotes?: string;
  additionalNotes?: string;
}

/**
 * Builder-local draft state for an in-progress dish edit.
 * Mirrors SavedDish but with optional fields that aren't yet
 * filled in. On save, transforms to SavedDish.
 */
export interface DishDraft {
  id?: string;                  // Empty for fresh-create
  name: string;
  cuisineType?: string;
  estimatedTimeMinutes?: number;
  servingsDefault: number;      // Default 4
  ingredients: Array<{ quantity: number; unit: string; name: string }>;
  steps: Array<{
    stepNumber: number;
    text: string;
    estimatedMinutes?: number;
    isTimingSensitive?: boolean;
  }>;
  caloriesPerServing: number;   // Default 0
  proteinGPerServing: number;   // Default 0
  carbsGPerServing: number;     // Default 0
  fatGPerServing: number;       // Default 0
  notes?: string;
}
