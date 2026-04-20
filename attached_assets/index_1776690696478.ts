// kiwi/packages/shared/src/types/index.ts
// All TypeScript interfaces matching the D2 data model.
// Used by both mobile and backend — never duplicate these.

// ── PRIMITIVES ──

export type UUID = string;
export type ISODate = string; // ISO 8601
export type DayOfWeek = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

// ── ENUMS ──

export type AccountStatus = 'active' | 'paused' | 'deleted' | 'blocked';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'none';
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'mixed';
export type SourceType = 'wizard' | 'directed' | 'imported_url' | 'uploaded_image' | 'manual' | 'curated';
export type DifficultyLevel = 'easy' | 'medium' | 'fancy';
export type WeeklyPacing = 'mostly_easy' | 'mixed' | 'one_fancy_night' | 'minimal_effort';
export type PlanStatus = 'this_week' | 'next_week' | 'upcoming' | 'past' | 'draft';
export type GroceryListStatus = 'draft' | 'active' | 'ordered' | 'archived';
export type IntegrationType = 'api' | 'rpa' | 'hybrid' | 'affiliate';
export type StepPhase = 'prep' | 'cook' | 'rest' | 'preheat' | 'assemble' | 'hold';
export type DishRole = 'main' | 'side' | 'sauce' | 'topping' | 'base' | 'optional';

// ── USER & AUTH ──

export interface User {
  id: UUID;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  zipCode?: string;
  timezone: string;
  accountStatus: AccountStatus;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt?: ISODate;
  defaultHouseholdSize: number;
  customerStartDate: ISODate;
  lastLoginAt?: ISODate;
  lastActiveAt?: ISODate;
  loginCountTotal: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface UserPreferences {
  id: UUID;
  userId: UUID;
  householdSize: number;
  wantsLeftovers: boolean;
  difficultyDefault: DifficultyLevel;
  weeklyPacingDefault: WeeklyPacing;
  dietaryRestrictions: string[];
  cuisinePreferences: string[];
  breakfastDefaults?: string;
  lunchDefaults?: string;
  macroPref?: ('high_protein' | 'low_carb' | 'heart_healthy')[];
  notificationsEnabled: boolean;
  emailMarketingConsent: boolean;
  smsMarketingConsent: boolean;
  lastUsedRetailerId?: UUID;
  updatedAt: ISODate;
}

export interface PantryStaple {
  id: UUID;
  userId: UUID;
  ingredientName: string;
  restockCadence: 'always_stocked' | 'weekly' | 'monthly' | 'remind_when_low';
  isActive: boolean;
  createdAt: ISODate;
}

// ── MACROS ──

export interface Macros {
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
}

// ── MEALS & DISHES ──

export interface Dish extends Macros {
  id: UUID;
  userId?: UUID; // null if curated/system
  title: string;
  description?: string;
  sourceType: SourceType;
  estimatedTimeMinutes: number;
  difficulty: DifficultyLevel;
  imageUrl?: string;
  servingsDefault: number;
  tags: string[];
  timesCooked: number;
  lastUsedAt?: ISODate;
  isArchived: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Meal extends Macros {
  id: UUID;
  userId?: UUID;
  title: string;
  description?: string;
  mealType: MealType;
  sourceType: SourceType;
  cuisineType?: string;
  difficulty: DifficultyLevel;
  estimatedTimeMinutes: number;
  imageUrl?: string;
  servingsDefault: number;
  tags: string[];
  timesCooked: number;
  lastUsedAt?: ISODate;
  isArchived: boolean;
  isPublic: boolean;
  likeCount: number;
  saveCount: number;
  useCount: number;
  createdAt: ISODate;
  updatedAt: ISODate;
  // Populated relations (optional)
  dishes?: MealDishLink[];
}

export interface MealDishLink {
  id: UUID;
  mealId: UUID;
  dishId: UUID;
  positionIndex: number;
  roleLabel: DishRole;
  dish?: Dish;
}

export interface Ingredient {
  id: UUID;
  canonicalName: string;
  displayName: string;
  category: string;
  subcategory?: string;
  defaultUnit: string;
  isOptionalDefault: boolean;
}

export interface DishIngredient {
  id: UUID;
  dishId: UUID;
  ingredientId: UUID;
  quantity: number;
  unit: string;
  preparationNote?: string;
  isOptional: boolean;
  positionIndex: number;
  ingredient?: Ingredient;
}

export interface RecipeInstructionStep {
  id: UUID;
  ownerType: 'meal' | 'dish';
  ownerId: UUID;
  stepIndex: number;
  stepTextRaw: string;
  stepTextTranslated: string;
  estimatedMinutes: number;
  phaseType: StepPhase;
  parallelGroup?: string;
  requiresPreheat: boolean;
  requiresRest: boolean;
  requiresMarination: boolean;
  isTimingSensitive: boolean; // renders in terracotta in cook mode
}

// ── MEAL PLANS ──

export interface MealPlanTemplate {
  id: UUID;
  userId: UUID;
  title: string;
  description?: string;
  sourceType: SourceType;
  isFeaturedSnapshot: boolean;
  defaultDaysCount: number;
  tags: string[];
  imageUrl?: string;
  isArchived: boolean;
  isPublic: boolean;
  likeCount: number;
  saveCount: number;
  useCount: number;
  lastUsedAt?: ISODate;
  deletedPlanCount: number; // for free tier conversion tracking
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface MealPlanInstance {
  id: UUID;
  userId: UUID;
  mealPlanTemplateId: UUID;
  titleOverride?: string;
  startDate?: ISODate;
  endDate?: ISODate;
  status: PlanStatus;
  isActiveThisWeek: boolean;
  lastCooked?: ISODate;
  timesCooked: number;
  notes?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  // Populated relations
  items?: MealPlanItem[];
  template?: MealPlanTemplate;
}

export interface MealPlanItem {
  id: UUID;
  mealPlanInstanceId: UUID;
  mealId: UUID;
  positionIndex: number;
  assignedDayOfWeek?: DayOfWeek;
  assignedDate?: ISODate;
  servingsOverride?: number;
  ingredientOverrides?: IngredientOverride[];
  isBreakfast: boolean;
  isLunch: boolean;
  isDinner: boolean;
  lastCooked?: ISODate;
  timesCooked: number;
  notes?: string;
  meal?: Meal;
}

export interface IngredientOverride {
  ingredientId: UUID;
  quantity: number;
  unit: string;
}

// ── GROCERY ──

export interface GroceryList {
  id: UUID;
  userId: UUID;
  title: string;
  mealPlanInstanceId?: UUID;
  sourceType: 'plan' | 'manual' | 'hybrid';
  status: GroceryListStatus;
  lastUsedAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
  items?: GroceryListItem[];
}

export interface GroceryListItem {
  id: UUID;
  groceryListId: UUID;
  ingredientId?: UUID;
  displayName: string;
  quantity: number;
  unit: string;
  storeSection: StoreSection;
  isChecked: boolean;
  isOptional: boolean;
  wasAiInferred: boolean;
  isAmbiguous: boolean; // flagged for user review
  sourceMealId?: UUID;
  sourceDishId?: UUID;
  notes?: string;
}

export type StoreSection =
  | 'produce'
  | 'meat_seafood'
  | 'dairy_eggs'
  | 'bakery_bread'
  | 'pantry'
  | 'canned'
  | 'frozen'
  | 'snacks'
  | 'household'
  | 'other';

// ── RETAILERS ──

export interface Retailer {
  id: UUID;
  name: string;
  slug: string;
  integrationType: IntegrationType;
  isEnabled: boolean;
  logoUrl?: string;
  supportsAuth: boolean;
  supportsCartAdd: boolean;
  supportsAvailabilityLookup: boolean;
}

export interface RetailerConnection {
  id: UUID;
  userId: UUID;
  retailerId: UUID;
  status: 'connected' | 'expired' | 'error';
  lastUsedAt?: ISODate;
  createdAt: ISODate;
}

export interface OrderSession {
  id: UUID;
  userId: UUID;
  retailerId: UUID;
  groceryListId: UUID;
  status: 'pending' | 'processing' | 'success' | 'partial' | 'failed';
  resultMessage?: string;
  cartUrl?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ── SUBSCRIPTION ──

export interface Subscription {
  id: UUID;
  userId: UUID;
  planCode: 'free' | 'premium_monthly' | 'premium_annual';
  status: SubscriptionStatus;
  trialEndsAt?: ISODate;
  currentPeriodStart?: ISODate;
  currentPeriodEnd?: ISODate;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  promoCodeId?: UUID;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ── AI SCHEMAS ──
// These match the D2 AI output schemas exactly.
// The AI orchestration layer validates all output against these.

export interface WizardPlanCandidate {
  candidateId: string;
  title: string;
  description: string;
  tags: string[];
  meals: WizardMealPreview[];
  optimizationNotes: string[];
  whyThisWorks: string[];
  macrosDailyAverage?: Macros;
}

export interface WizardMealPreview {
  title: string;
  mealType: MealType;
  estimatedTimeMinutes: number;
  difficulty: DifficultyLevel;
  servings: number;
  dishes: string[];
}

export interface DirectedMealInterpretation {
  interpretedMealTitle: string;
  coreIngredients: string[];
  optionalIngredients: string[];
  confidence: number;
  requiresRecipeSearch: boolean;
}

export interface RecipeTranslationOutput {
  translatedSteps: TranslatedStep[];
}

export interface TranslatedStep {
  stepIndex: number;
  stepText: string;
  phaseType: StepPhase;
  estimatedMinutes: number;
  isTimingSensitive: boolean;
  parallelGroup?: string;
}

export interface OptimizationOutput {
  optimizationNotes: string[];
  ingredientReuseMap: IngredientReuse[];
}

export interface IngredientReuse {
  ingredient: string;
  usedInMeals: string[];
}

// ── VIEW MODELS (frontend-ready payloads) ──

export interface HomeScreenPayload {
  userSummary: {
    firstName: string;
    trialDaysRemaining?: number;
    subscriptionStatus: SubscriptionStatus;
  };
  activePlanSummary?: {
    planInstanceId: UUID;
    title: string;
    mealCount: number;
    startDate?: ISODate;
  };
  planDiscoveryCards: PlanDiscoveryCard[];
}

export interface PlanDiscoveryCard {
  planId: UUID;
  title: string;
  imageUrl?: string;
  tags: string[];
  badge?: string;
  mealPreviewTitles: string[];
  canExpand: boolean;
}

export interface ReviewPlanPayload {
  planInstanceId: UUID;
  title: string;
  dateRange?: { start: ISODate; end: ISODate };
  statusBadge: string;
  smartOptimizationSummary: string[];
  meals: ReviewPlanMealRow[];
  breakfastSummary?: string;
  lunchSummary?: string;
  macroDailyAverage: Macros;
}

export interface ReviewPlanMealRow {
  mealPlanItemId: UUID;
  mealId: UUID;
  title: string;
  thumbnailUrl?: string;
  servingsEffective: number;
  macroSummary: Macros;
  dayAssignmentState: DayAssignment[];
}

export interface DayAssignment {
  dayLabelShort: string;
  dayLabelLong: DayOfWeek;
  isSelected: boolean;
  date?: ISODate;
}

// ── ANALYTICS ──

export interface UserActivity {
  id: UUID;
  userId: UUID;
  eventType: ActivityEventType;
  entityId?: UUID;
  entityType?: string;
  platform?: 'ios' | 'android' | 'web';
  createdAt: ISODate;
}

export type ActivityEventType =
  | 'login'
  | 'view_plan'
  | 'cook_meal'
  | 'generate_grocery'
  | 'order_groceries'
  | 'wizard_start'
  | 'wizard_complete'
  | 'plan_created'
  | 'plan_deleted'
  | 'upgrade_started'
  | 'upgrade_completed'
  | 'trial_started'
  | 'trial_expired';
