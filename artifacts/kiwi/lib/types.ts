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
  /** WS7-2 Block C — marketing consent (D-WS7-025). Editable from preferences.tsx. */
  marketingConsentEmail: boolean;
  marketingConsentSms: boolean;
  /** WS7-2 Block A routing flag — gates onboarding vs (tabs) after login. */
  onboardingComplete: boolean;
  /** WS7-2 Block A routing flag — gates the first-run-destination screen. */
  firstRunChoiceMade: boolean;
  subscription: Subscription | null;
  createdAt: string;
}

/**
 * PRD §14.9.1 — User's account info displayed/editable in
 * Profile. Real persistence WS7.
 */
export interface UserAccountInfo {
  name: string;
  email: string;
  phone?: string;
}

/**
 * PRD §14.7 — User's subscription state. Real data via Stripe
 * webhook + API in WS6.
 */
export interface SubscriptionInfo {
  tier: "trial" | "active" | "canceled" | "past_due" | "none";
  /** Days remaining in trial; null if not trial. */
  trialDaysRemaining?: number;
  /** ISO date for renewal; null if not active. */
  nextRenewalDate?: string;
}

/**
 * Transient draft state for onboarding step 2 (PRD §3.4).
 * Held in AppContext so step 2 can remount with the user's
 * in-progress values after navigating away and back. Replaced
 * in WS7 by getCurrentUserPreferences() reading saved API state.
 */
export interface Step2Draft {
  // WS7-2-F (D-WS7-029) — household fields collected in the step-2 UI.
  householdSize: number;
  // wantsLeftovers removed from the step-2 UI in Cookbook Phase B Block 3
  // (D-WS7-190) — no longer user-set; the schema default drives it.
  planLengthDefault: number;
  cuisines: string[];
  eatingStyles: string[];
  allergiesAndAvoidances: string[];
  cookingSkill: "beginner" | "intermediate" | "advanced";
  recurringGroceryItems: string[];
  dietaryNotes: string;
  // Cookbook Phase B Block 3 — cook-time cap collected in step 2.
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: "all" | "most";
  // Cookbook Phase B Block 5 — the remaining two generation-shaping prefs, so
  // step 2 carries ALL FOUR Phase-B fields (a user may set prefs once at
  // onboarding and never revisit).
  discoveryMealsPerWeek: number;
  saucePreference: "store_bought" | "balanced" | "homemade";
}

/**
 * Transient draft state for onboarding step 3 (PRD §3.5).
 * Held in AppContext so step 3 can remount with the user's
 * in-progress values after refine/back navigation. Replaced
 * in WS7 by real API persistence.
 */
export interface Step3Draft {
  cookingEquipment: string[];
  stovetopType?: "gas" | "induction" | "electric";
  kidsCount: number;
  pickyEaterCount: number;
  pickyAvoidances: string[];
  spiceTolerance: "mild" | "medium" | "hot" | "very_hot";
  healthGoals: string[];
  budgetLevel: "economy" | "mid_range" | "premium";
  /** Open collapsible section ids — Set serialized as array for JSON. */
  expandedSections: string[];
}

/**
 * PRD §14.9.2 — full user preferences from §3.4 + §3.5.
 * Real persistence WS7.
 */
export interface UserPreferencesData {
  // §3.4 — onboarding step 2
  cuisines: string[];
  eatingStyles: string[];
  allergiesAndAvoidances: string[];
  cookingSkill?: "beginner" | "intermediate" | "advanced";
  recurringGroceryItems: string[];

  // §3.5 — onboarding step 3
  cookingEquipment: string[];
  stovetopType?: "gas" | "induction" | "electric";
  kidsCount: number;
  // Kid ages removed in WS5-5P-bis-fix per Hans (privacy concern,
  // marginal AI value). PRD §3.5 redline pending.
  pickyEaterCount: number;
  pickyAvoidances: string[];
  spiceTolerance: "mild" | "medium" | "hot" | "very_hot";
  healthGoals: string[];
  budgetLevel: "economy" | "mid_range" | "premium";

  // §14.9.2 additions
  planLengthDefault: number;       // 1-7
  householdSize: number;           // 1-30
  wantsLeftovers: boolean;
  defaultRetailer?: string;
  /** Free-text dietary notes (carries over from wizard's "Anything else?") */
  dietaryNotes?: string;

  // Cookbook Phase B Block 1 — new stored prefs (storage + wire only; the
  // preferences UI that edits them lands in Block 3). Non-null with server
  // defaults except maxCookTimeMinutes, which is null when uncapped.
  discoveryMealsPerWeek: number;   // 0 | 1 | 2
  saucePreference: "store_bought" | "balanced" | "homemade";
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: "all" | "most";
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

/** Daily macro averages displayed on Plan Review per PRD §8.3.5.
 *  WS7-6 Fix-Block 2 (D, closes D-WS7-060): null on each field means
 *  "no meals assigned" (empty state) — UI renders "—". */
export interface MacroDailyAverage {
  caloriesPerDay: number | null;
  proteinGPerDay: number | null;
  carbsGPerDay: number | null;
  fatGPerDay: number | null;
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
  /** Server `cuisine` widened to the row (WS7-3 C4 c1 / Ruling 4) so
   *  SwapMealSheet's Similar-mode source-cuisine subtitle and any cuisine-
   *  driven badging can read row.cuisine instead of an extra meal-detail fetch.
   *  Undefined when the meal carries no cuisine. */
  cuisine?: string;
  /** "Easy · 30 min · serves 4" */
  metaLine: string;
  /** Per-serving display values for the row's macros line. */
  caloriesPerServing?: number;
  proteinGPerServing?: number;
  carbsGPerServing?: number;
  fatGPerServing?: number;
  /** Day strip — 7 entries Sun-Sat with assignment state. */
  dayStrip: DayAssignment[];
  /** WS7-7-A B5 — per-instance servings (MealPlanItem.servingsOverride); null
   *  = inherit the meal's default. Plumbed to Meal Detail so the servings
   *  stepper initializes from the plan's value and persists back to it. */
  servingsOverride?: number | null;
}

/** Optimization panel bullet per PRD §8.3.4. */
export interface OptimizationNote {
  type: "prep" | "cost";
  text: string;
}

/** Prep status indicator state per PRD §8.3.3. */
export type PrepStatus = "not_prepped" | "partial" | "prepped";

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
  /** Per-plan breakfast override; null/"" = inherit user default per PRD §8.3.7. */
  breakfastOverrides: string;
  /** Per-plan lunch override; null/"" = inherit user default per PRD §8.3.7. */
  lunchOverrides: string;
  /** ISO date string ("YYYY-MM-DD") for the plan's start date.
   *  Drives the date-range editor (PRD §8 / §11). Optional so legacy
   *  demo branches without dates don't break. */
  weekStartDate?: string;
  /** ISO date string ("YYYY-MM-DD") for the plan's end date. */
  weekEndDate?: string;
  /** WS7-6 (E) Block 2 §4 — Model 2 resolver-derived flag. True when this
   *  plan IS the current This-Week winner; the Plan Review screen swaps the
   *  "Cook This Week" chip for a passive "This Week's Plan" badge in that
   *  state. Surfaced from PlanDetail.isActiveThisWeek by the adapter. */
  isActiveThisWeek: boolean;
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
  /** Side dish vs full main course. Drives Recipes tab side/main
   *  filter chip row (WS5-5O) and informs AI plan composition. */
  type: "side" | "main";
  /** Per-serving values; default servings is 4. */
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  /** Number of saved meals containing this dish. Renamed from
   *  the prior `useCount` per WS5-5O — drives the always-on
   *  "Used in N meals" line on dish rows. */
  mealUseCount: number;
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
  // WS9 3f-4d Part 1c (D-WS9-123) — short display name; resolveDisplayTitle reads
  // it for render + A–Z sort (BUG-067). Optional: picker DTOs populate it in Part 2.
  displayTitle?: string | null;
  // WS9 3f-4d Part 1e (D-WS9-126) — SIDE dish titles (main excluded) for the
  // multi-dish sub-line. Optional: picker DTOs populate it in Part 2.
  dishTitles?: string[];
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

  // Per-run pref values — hydrated from stored UserPreferences, editable for
  // THIS generation only (Cookbook Phase B Block 4 / D-WS7-035). NEVER written
  // back to UserPreferences.
  householdSize: number;          // 1-30

  // Cookbook Phase B Block 5 — plan length is now a first-class Tell Kiwi
  // control (always-visible chip row), matching the Set-Prefs wizard. Optional
  // on the wire: the server reads req.body.planDurationDays when present and
  // defaults to 5 otherwise, so an omitting caller (or a legacy payload) is
  // still valid. Hydrated from planLengthDefault.
  planDurationDays?: number;      // 1-7

  // Block 4 — the "Adjust saved prefs for this plan" disclosure now carries
  // cuisines + weeklyPacing on Tell Kiwi too (Ruling 3).
  cuisines: string[];             // From CUISINES_TIER_1/2
  weeklyPacing?:
    | "mostly_easy"
    | "mixed"
    | "one_fancy_night"
    | "minimal_effort";

  // Dietary expansion (collapsed by default)
  eatingStyles: string[];         // From EATING_STYLES catalog
  allergiesAndAvoidances: string[]; // From ALLERGIES_AND_AVOIDANCES
  dietaryNotes?: string;          // "no shellfish, low sodium"

  // Block 4 — the four generation-shaping per-run overrides. Sent only when
  // the user edits them; the server resolves override-else-stored.
  discoveryMealsPerWeek?: number;   // 0 | 1 | 2
  saucePreference?: "store_bought" | "balanced" | "homemade";
  maxCookTimeMinutes?: number | null;
  maxCookTimeCoverage?: "all" | "most";
}

/**
 * PRD §5.3 — input shape for the Set Preferences wizard.
 * Server's POST /api/wizard/build-plans payload (WS6 / WS7).
 */
export interface WizardPreferencesInput {
  // Required
  planDurationDays: number;
  householdSize: number;

  // Multi-select preferences (all optional, may be empty arrays)
  cuisines: string[];
  eatingStyles: string[];
  allergiesAndAvoidances: string[];

  // Single-select
  difficulty: "easy" | "medium" | "fancy";
  weeklyPacing:
    | "mostly_easy"
    | "mixed"
    | "one_fancy_night"
    | "minimal_effort";

  // Optional free text
  dietaryNotes?: string;
  additionalNotes?: string;

  // Cookbook Phase B Block 4 (D-WS7-035) — per-run overrides of the four
  // generation-shaping prefs. Hydrated from stored UserPreferences on wizard
  // open, editable for THIS plan only, NEVER written back. Sent only when the
  // user edits them; the server resolves override-else-stored.
  discoveryMealsPerWeek?: number;   // 0 | 1 | 2
  saucePreference?: "store_bought" | "balanced" | "homemade";
  maxCookTimeMinutes?: number | null;
  maxCookTimeCoverage?: "all" | "most";
}

/**
 * Builder-local draft state for an in-progress dish edit.
 * Mirrors SavedDish but with optional fields that aren't yet
 * filled in. On save, transforms to SavedDish.
 *
 * The `kiwiAssist*` flags (WS5-5O) signal that AI should generate
 * the corresponding field server-side at save time. When a flag
 * is true, the manual values (ingredients/steps) are ignored.
 * WS6 wires the AI calls; WS5 just round-trips the flags.
 *
 * Macros are NOT user-editable in WS5 (per WS5-5O-fix-2): the AI
 * computes them from ingredients automatically on save. The four
 * macro fields are preserved on edit (so the user's existing
 * macros aren't zeroed) and default to 0 on create.
 */
export interface DishDraft {
  id?: string;                  // Empty for fresh-create
  name: string;
  cuisineType?: string;
  estimatedTimeMinutes?: number;
  servingsDefault: number;      // Default 4
  /** Side dish vs full main course. */
  type: "side" | "main";
  /** Kiwi-assist flags — when true, AI generates the field on save. */
  kiwiAssistIngredients: boolean;
  kiwiAssistSteps: boolean;
  /** Manual values; ignored if the corresponding kiwiAssist flag is true. */
  ingredients: Array<{ quantity: number; unit: string; name: string }>;
  steps: Array<{
    stepNumber: number;
    text: string;
    estimatedMinutes?: number;
    isTimingSensitive?: boolean;
  }>;
  /** Macros — preserved across edit, AI-computed on save. Not user-editable. */
  caloriesPerServing: number;   // Default 0
  proteinGPerServing: number;   // Default 0
  carbsGPerServing: number;     // Default 0
  fatGPerServing: number;       // Default 0
  notes?: string;
}

// ─────────────────────────────────────────────────────────────────
// PRD §12 — Grocery list system
// ─────────────────────────────────────────────────────────────────

/**
 * PRD §12.4 — grocery list item with section assignment +
 * staple/recurring badges + ambiguous flagging.
 */
export interface GroceryListItem {
  id: string;
  name: string;
  /** Display fallback used when structured fields are absent (e.g.,
   *  pantry staples shown as "—"). For items with structured quantity,
   *  prefer reading {@link quantityAmount} + {@link quantityUnit}. */
  quantity: string;
  /** Structured amount mirroring meal-builder's ingredient shape:
   *  string-typed so fractions ("1/2", "1 1/2") survive a round-trip
   *  through edit. Validate via parseQuantity at edit time. */
  quantityAmount?: string;
  quantityUnit?: string;
  /** PRD §12.4 — one of 10 sections */
  sectionKey:
    | "produce"
    | "meat_seafood"
    | "dairy_eggs"
    | "bakery_bread"
    | "pantry"
    | "canned"
    | "frozen"
    | "snacks"
    | "household"
    | "extras";
  /** PRD §12.7 — pantry staple (default unselected, badge shown) */
  isUniversalStaple: boolean;
  /** PRD §12.7 — per-list staple opt-in ("buying this week"). WS7-7-A
   *  Block 3: now a real server field (`stapleOptedIn`) driving the
   *  active/dimmed staple render. Optional so demo-stub fixtures and
   *  optimistic local rows (which default to not-opted-in) stay terse;
   *  read as `?? false`. */
  stapleOptedIn?: boolean;
  /** PRD §12.8 — user's recurring item (default selected, badge shown) */
  isRecurringItem: boolean;
  /** PRD §12.5 — flagged for ambiguity at order time */
  isAmbiguous: boolean;
  ambiguityOptions?: string[];
  userResolvedTo?: string;
  /** Optional flag for items the recipe marks as nice-to-have */
  isOptional: boolean;
  /** Checked-off state during shopping */
  isCompleted: boolean;
  /** WS7-8b B2 — the buyable pack, as DATA. Composed with {@link name} and the
   *  need (quantityAmount/quantityUnit) into the two-part line at render:
   *  "{purchaseDisplay} {name} ({need})". The pack is derived (regenerated on
   *  reconcile); the need is authored. Absent for user-added / unknown items. */
  purchaseUnit?: string;
  purchaseQuantity?: number;
  purchaseDisplay?: string;
  /** WS9 3e Part 2.2 — distinct meal titles this item was sourced from
   *  (1-to-many). Empty for merged/renamed AI-tail rows and user-added items
   *  (~10.5% of plan-derived items) — render no provenance label in that case. */
  mealNames?: string[];
}

// GroceryListSummary retired in WS7-3 C3 c5 — the Groceries tab consumes
// GroceryListListItem (lib/api/groceries.ts) directly via useGroceryLists().

/**
 * PRD §12.6 — full grocery list with all items.
 */
export interface GroceryList {
  id: string;
  planName: string;
  planId?: string;
  items: GroceryListItem[];
  status: "draft" | "active" | "ordered" | "completed";
  createdAt: string;
  isThisWeek: boolean;
  /** Number of ambiguous items needing resolution at order time */
  ambiguousItemCount: number;
}
