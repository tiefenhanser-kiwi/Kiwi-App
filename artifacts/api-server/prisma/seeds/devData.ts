// WS6 6b-1.5 — dev-only seed for Expo Go testing.
//
// Attaches a realistic dataset (1 UserPreferences, 6 Meals + Dishes +
// ingredients + steps, 2 plans with items) to Hans's existing test account
// hans.tiefenthaler+8@gmail.com so the rest of WS6 (6b-2 → 6d-2) has real
// DB-resident plan/meal IDs to exercise.
//
// NOTE: Plan Review on the mobile client still reads from AsyncStorage stubs
// (AppContext.tsx). This seed makes the data EXIST for server-side endpoint
// testing (Find Similar AI, future plan endpoints). It does NOT cause the
// stub-driven Plan Review list to populate. WS7 swaps stubs to API.
//
// Run:   pnpm --filter @workspace/api-server prisma:seed:dev
// Idempotent — safe to re-run. Re-running refreshes seeded child rows
// (DishIngredients, RecipeInstructionSteps, MealPlanItems) by delete-then-
// insert scoped to the seed's deterministic IDs. The dev User record itself
// is never modified once it exists (we only attach UserPreferences + a
// Subscription if missing).

import { PrismaClient } from "@prisma/client";

import { INGREDIENT_PURCHASE_DEFAULTS } from "../../src/lib/ingredientPurchaseDefaults";

if (process.env.NODE_ENV === "production") {
  throw new Error(
    "[devData] refusing to run with NODE_ENV=production. This seed is dev-only.",
  );
}

const prisma = new PrismaClient();

// ── constants ────────────────────────────────────────────────────────────────

const DEV_USER_EMAIL = "hans.tiefenthaler+8@gmail.com";

const DEV_MEAL_IDS = {
  beefTacos: "dev-meal-beef-tacos",
  carbonara: "dev-meal-spaghetti-carbonara",
  tikkaMasala: "dev-meal-chicken-tikka-masala",
  grainBowl: "dev-meal-mediterranean-grain-bowl",
  padThai: "dev-meal-pad-thai",
  fajitas: "dev-meal-sheet-pan-fajitas",
  salmonRicePilaf: "dev-meal-salmon-rice-pilaf",
} as const;

const DEV_DISH_IDS = {
  beefTacos: "dev-dish-beef-tacos",
  carbonara: "dev-dish-spaghetti-carbonara",
  tikkaMasala: "dev-dish-chicken-tikka-masala",
  grainBowl: "dev-dish-mediterranean-grain-bowl",
  padThai: "dev-dish-pad-thai",
  fajitas: "dev-dish-sheet-pan-fajitas",
  searedSalmon: "dev-dish-seared-salmon",
  ricePilaf: "dev-dish-rice-pilaf",
} as const;

const DEV_PLAN_IDS = {
  weeknightTemplate: "dev-plan-template-weeknight",
  weeknightInstance: "dev-plan-instance-weeknight",
  spiceTemplate: "dev-plan-template-spice-it-up",
  spiceInstance: "dev-plan-instance-spice-it-up",
  // WS7-3 C4 c7 — instance id is the literal "demo" so the "Inject dev test
  // plan" affordance's /plan/demo deep-link resolves against a real row.
  demoTemplate: "dev-plan-template-demo",
  demoInstance: "demo",
} as const;

// WS7-3 A2 — public discovery templates. The two plan templates seeded via
// seedPlan() are private (isPublic defaults false) and tied to the dev user's
// instances; A2's /plans?filter=featured|top_rated|hosting_events + /home
// discovery cards read PUBLIC MealPlanTemplate rows, of which the seed had
// none. These standalone public templates carry non-zero saveCount/useCount
// and featuring flags so the A2 read endpoints have non-degenerate data to
// return. See WS7-3 A2 Phase 3 report §8 (F-A2-1).
const DEV_DISCOVERY_TEMPLATE_IDS = {
  familyFavorites: "dev-plan-template-family-favorites",
  quickWeeknights: "dev-plan-template-quick-weeknights",
  holidayHosting: "dev-plan-template-holiday-hosting",
  budgetBowls: "dev-plan-template-budget-bowls",
} as const;

const DEV_TAG = "dev";

// ── meal data ────────────────────────────────────────────────────────────────

type IngredientCategory =
  | "Produce"
  | "Protein"
  | "Dairy"
  | "Pantry"
  | "Bakery"
  | "Canned"
  | "Frozen";

interface DevIngredient {
  name: string;
  category: IngredientCategory;
  quantity: number;
  unit: string;
  isOptional?: boolean;
}

// WS7-5d Block 2: the table of canonical-name → purchase-pack defaults
// lives in src/lib/ingredientPurchaseDefaults.ts so wizardActivation's
// runtime upsert path can read the same data. Re-exported here so existing
// callers (smoke scripts, the Block-1 test) keep working.
export const SEED_INGREDIENT_PURCHASE_DEFAULTS = INGREDIENT_PURCHASE_DEFAULTS;

/**
 * A RecipeInstructionStep seed row. `estimatedMinutes` and `isTimingSensitive`
 * are reasonable estimates from the step text (WS7-3 Path 1 ruling) — dev seed
 * inputs for downstream scheduling, not user-facing accuracy targets. Written
 * explicitly so rows no longer fall back to the schema @default(1)/false.
 */
interface DevStep {
  text: string;
  estimatedMinutes: number;
  isTimingSensitive: boolean;
}

interface DevMeal {
  mealId: string;
  dishId: string;
  title: string;
  description: string;
  cuisine: string;
  minutes: number;
  difficulty: "easy" | "medium" | "fancy";
  servings: number;
  cal: number;
  pro: number;
  carb: number;
  fat: number;
  tags: string[];
  ingredients: DevIngredient[];
  steps: DevStep[];
  /** non-zero → seed timesCooked + lastUsedAt to give "Most Used" sort signal */
  cookHistoryDaysAgo: number | null;
  cookCount: number;
}

const MEALS: DevMeal[] = [
  {
    mealId: DEV_MEAL_IDS.beefTacos,
    dishId: DEV_DISH_IDS.beefTacos,
    title: "Beef Tacos",
    description: "Weeknight ground-beef tacos with the full topping bar.",
    cuisine: "Mexican",
    minutes: 30,
    difficulty: "easy",
    servings: 4,
    cal: 520,
    pro: 28,
    carb: 38,
    fat: 26,
    tags: ["quick", "kid-friendly", "comfort", DEV_TAG],
    ingredients: [
      { name: "Ground beef", category: "Protein", quantity: 1, unit: "lb" },
      { name: "Taco shells", category: "Bakery", quantity: 12, unit: "each" },
      { name: "Cheddar", category: "Dairy", quantity: 1, unit: "cup" },
      { name: "Lettuce", category: "Produce", quantity: 1, unit: "head" },
      { name: "Tomato", category: "Produce", quantity: 2, unit: "each" },
      { name: "Salsa", category: "Pantry", quantity: 1, unit: "jar" },
      { name: "Sour cream", category: "Dairy", quantity: 1, unit: "cup" },
      { name: "Taco seasoning", category: "Pantry", quantity: 2, unit: "tbsp" },
    ],
    steps: [
      { text: "Brown ground beef in a skillet over medium-high heat for 8 minutes.", estimatedMinutes: 8, isTimingSensitive: true },
      { text: "Stir in taco seasoning with a splash of water; simmer 2 minutes.", estimatedMinutes: 2, isTimingSensitive: true },
      { text: "Warm taco shells in a 350°F oven for 5 minutes.", estimatedMinutes: 5, isTimingSensitive: true },
      { text: "Shred lettuce, dice tomato, grate cheddar.", estimatedMinutes: 3, isTimingSensitive: false },
      { text: "Assemble: shell, beef, lettuce, tomato, cheese, salsa, sour cream.", estimatedMinutes: 3, isTimingSensitive: false },
    ],
    cookHistoryDaysAgo: 7,
    cookCount: 5,
  },
  {
    mealId: DEV_MEAL_IDS.carbonara,
    dishId: DEV_DISH_IDS.carbonara,
    title: "Spaghetti Carbonara",
    description: "Roman classic — eggs, parmesan, bacon, pasta water emulsion.",
    cuisine: "Italian",
    minutes: 25,
    difficulty: "medium",
    servings: 4,
    cal: 640,
    pro: 26,
    carb: 65,
    fat: 28,
    tags: ["comfort", "pasta", "classic", DEV_TAG],
    ingredients: [
      { name: "Spaghetti", category: "Pantry", quantity: 1, unit: "lb" },
      { name: "Bacon", category: "Protein", quantity: 6, unit: "oz" },
      { name: "Eggs", category: "Dairy", quantity: 4, unit: "each" },
      { name: "Parmesan", category: "Dairy", quantity: 1, unit: "cup" },
      { name: "Black pepper", category: "Pantry", quantity: 1, unit: "tsp" },
      { name: "Garlic", category: "Produce", quantity: 2, unit: "cloves" },
      { name: "Salt", category: "Pantry", quantity: 1, unit: "tsp" },
      { name: "Parsley", category: "Produce", quantity: 1, unit: "bunch", isOptional: true },
    ],
    steps: [
      { text: "Bring salted water to boil; cook spaghetti just shy of al dente; reserve 1 cup pasta water.", estimatedMinutes: 10, isTimingSensitive: true },
      { text: "Render diced bacon in a wide pan over medium heat until crisp; add minced garlic for 30 seconds.", estimatedMinutes: 7, isTimingSensitive: true },
      { text: "Whisk eggs and grated parmesan in a bowl with cracked black pepper.", estimatedMinutes: 2, isTimingSensitive: false },
      { text: "Off heat, toss hot pasta with bacon, then with egg mixture, adding pasta water until creamy.", estimatedMinutes: 2, isTimingSensitive: false },
      { text: "Top with extra parmesan, pepper, and parsley.", estimatedMinutes: 1, isTimingSensitive: false },
    ],
    cookHistoryDaysAgo: 14,
    cookCount: 3,
  },
  {
    mealId: DEV_MEAL_IDS.tikkaMasala,
    dishId: DEV_DISH_IDS.tikkaMasala,
    title: "Chicken Tikka Masala",
    description: "Marinated chicken thighs simmered in a spiced tomato-cream sauce.",
    cuisine: "Indian",
    minutes: 45,
    difficulty: "medium",
    servings: 4,
    cal: 580,
    pro: 35,
    carb: 48,
    fat: 24,
    tags: ["high-protein", "spicy", "crowd-pleaser", DEV_TAG],
    ingredients: [
      { name: "Chicken thighs", category: "Protein", quantity: 1.5, unit: "lb" },
      { name: "Tikka masala paste", category: "Pantry", quantity: 4, unit: "oz" },
      { name: "Coconut milk", category: "Canned", quantity: 1, unit: "can" },
      { name: "Diced tomatoes", category: "Canned", quantity: 1, unit: "can" },
      { name: "Basmati rice", category: "Pantry", quantity: 1.5, unit: "cups" },
      { name: "Yellow onion", category: "Produce", quantity: 1, unit: "each" },
      { name: "Garlic", category: "Produce", quantity: 4, unit: "cloves" },
      { name: "Ginger", category: "Produce", quantity: 1, unit: "inch" },
    ],
    steps: [
      { text: "Cube chicken thighs; toss with half the tikka paste; marinate 10 minutes.", estimatedMinutes: 10, isTimingSensitive: true },
      { text: "Cook basmati rice per package directions.", estimatedMinutes: 15, isTimingSensitive: true },
      { text: "Sauté diced onion with garlic and grated ginger in oil until soft, 5 minutes.", estimatedMinutes: 5, isTimingSensitive: true },
      { text: "Add chicken; sear 4 minutes per side.", estimatedMinutes: 8, isTimingSensitive: true },
      { text: "Stir in remaining paste, diced tomatoes, and coconut milk; simmer 15 minutes.", estimatedMinutes: 15, isTimingSensitive: true },
      { text: "Serve over basmati rice.", estimatedMinutes: 1, isTimingSensitive: false },
    ],
    cookHistoryDaysAgo: null,
    cookCount: 0,
  },
  {
    mealId: DEV_MEAL_IDS.grainBowl,
    dishId: DEV_DISH_IDS.grainBowl,
    title: "Mediterranean Grain Bowl",
    description: "Farro base with chickpeas, cucumber, tomato, feta, and lemon-tahini.",
    cuisine: "Mediterranean",
    minutes: 20,
    difficulty: "easy",
    servings: 4,
    cal: 480,
    pro: 18,
    carb: 62,
    fat: 18,
    tags: ["vegetarian", "high-fiber", "meal-prep", DEV_TAG],
    ingredients: [
      { name: "Farro", category: "Pantry", quantity: 1, unit: "cup" },
      { name: "Chickpeas", category: "Canned", quantity: 1, unit: "can" },
      { name: "Cucumber", category: "Produce", quantity: 1, unit: "each" },
      { name: "Cherry tomatoes", category: "Produce", quantity: 1, unit: "pint" },
      { name: "Feta", category: "Dairy", quantity: 4, unit: "oz" },
      { name: "Lemon", category: "Produce", quantity: 1, unit: "each" },
      { name: "Tahini", category: "Pantry", quantity: 0.25, unit: "cup" },
      { name: "Olive oil", category: "Pantry", quantity: 3, unit: "tbsp" },
    ],
    steps: [
      { text: "Simmer farro in 2 cups water for 15 minutes; drain.", estimatedMinutes: 15, isTimingSensitive: true },
      { text: "Drain and rinse chickpeas; halve cherry tomatoes; dice cucumber.", estimatedMinutes: 3, isTimingSensitive: false },
      { text: "Whisk lemon juice, tahini, olive oil, and a splash of water into a creamy dressing.", estimatedMinutes: 2, isTimingSensitive: false },
      { text: "Build bowls: farro base, chickpeas, vegetables, crumbled feta.", estimatedMinutes: 3, isTimingSensitive: false },
      { text: "Drizzle with dressing.", estimatedMinutes: 1, isTimingSensitive: false },
    ],
    cookHistoryDaysAgo: 21,
    cookCount: 2,
  },
  {
    mealId: DEV_MEAL_IDS.padThai,
    dishId: DEV_DISH_IDS.padThai,
    title: "Pad Thai",
    description: "Quick wok-style rice noodles with shrimp, egg, and tamarind sauce.",
    cuisine: "Thai",
    minutes: 30,
    difficulty: "medium",
    servings: 4,
    cal: 560,
    pro: 26,
    carb: 70,
    fat: 18,
    tags: ["quick", "pescatarian", "one-pan", DEV_TAG],
    ingredients: [
      { name: "Rice noodles", category: "Pantry", quantity: 8, unit: "oz" },
      { name: "Shrimp", category: "Protein", quantity: 1, unit: "lb" },
      { name: "Bean sprouts", category: "Produce", quantity: 1, unit: "cup" },
      { name: "Peanuts", category: "Pantry", quantity: 0.25, unit: "cup" },
      { name: "Tamarind paste", category: "Pantry", quantity: 2, unit: "tbsp" },
      { name: "Fish sauce", category: "Pantry", quantity: 2, unit: "tbsp" },
      { name: "Lime", category: "Produce", quantity: 2, unit: "each" },
      { name: "Eggs", category: "Dairy", quantity: 2, unit: "each" },
    ],
    steps: [
      { text: "Soak rice noodles in hot water for 8 minutes; drain.", estimatedMinutes: 8, isTimingSensitive: true },
      { text: "Whisk tamarind paste, fish sauce, and a splash of water for the sauce.", estimatedMinutes: 2, isTimingSensitive: false },
      { text: "Heat oil in a wok; scramble eggs and push to the side.", estimatedMinutes: 3, isTimingSensitive: false },
      { text: "Add shrimp; stir-fry 2 minutes until pink.", estimatedMinutes: 2, isTimingSensitive: true },
      { text: "Toss in noodles and sauce; cook 2 minutes.", estimatedMinutes: 2, isTimingSensitive: true },
      { text: "Off heat, fold in bean sprouts; top with crushed peanuts and lime wedges.", estimatedMinutes: 2, isTimingSensitive: false },
    ],
    cookHistoryDaysAgo: null,
    cookCount: 0,
  },
  {
    mealId: DEV_MEAL_IDS.fajitas,
    dishId: DEV_DISH_IDS.fajitas,
    title: "Sheet-Pan Chicken Fajitas",
    description: "Hands-off sheet-pan chicken and peppers — assemble at the table.",
    cuisine: "Tex-Mex",
    minutes: 35,
    difficulty: "easy",
    servings: 4,
    cal: 510,
    pro: 36,
    carb: 42,
    fat: 18,
    tags: ["high-protein", "sheet-pan", "kid-friendly", DEV_TAG],
    ingredients: [
      { name: "Chicken breast", category: "Protein", quantity: 1, unit: "lb" },
      { name: "Bell peppers", category: "Produce", quantity: 3, unit: "each" },
      { name: "Yellow onion", category: "Produce", quantity: 1, unit: "each" },
      { name: "Fajita seasoning", category: "Pantry", quantity: 2, unit: "tbsp" },
      { name: "Flour tortillas", category: "Bakery", quantity: 8, unit: "each" },
      { name: "Lime", category: "Produce", quantity: 1, unit: "each" },
      { name: "Cilantro", category: "Produce", quantity: 1, unit: "bunch", isOptional: true },
      { name: "Sour cream", category: "Dairy", quantity: 0.5, unit: "cup", isOptional: true },
    ],
    steps: [
      { text: "Preheat oven to 425°F.", estimatedMinutes: 1, isTimingSensitive: false },
      { text: "Slice chicken breast, bell peppers, and onion into strips.", estimatedMinutes: 4, isTimingSensitive: false },
      { text: "Toss everything on a sheet pan with fajita seasoning, oil, and lime juice.", estimatedMinutes: 3, isTimingSensitive: false },
      { text: "Roast 20 minutes until chicken is cooked through and edges char.", estimatedMinutes: 20, isTimingSensitive: true },
      { text: "Warm tortillas wrapped in foil during the last 5 minutes.", estimatedMinutes: 5, isTimingSensitive: true },
      { text: "Assemble fajitas; top with cilantro and sour cream.", estimatedMinutes: 2, isTimingSensitive: false },
    ],
    cookHistoryDaysAgo: null,
    cookCount: 0,
  },
];

// ── multi-dish meal (WS7-3 A1) ───────────────────────────────────────────────
// One multi-dish meal that exercises the WS7-3 read-shape fix: two dishes wired
// via MealDishLink with explicit positionIndex, each carrying its own
// dish-owned ingredients AND RecipeInstructionStep rows (ownerType: "dish").
// The single-dish MEALS above keep meal-owned steps; this is the only seeded
// meal that exercises the dish-owned-step path. isPublic so it surfaces in
// GET /meals.

interface DevDish {
  dishId: string;
  title: string;
  roleLabel: "main" | "side";
  positionIndex: number;
  minutes: number;
  difficulty: "easy" | "medium" | "fancy";
  servings: number;
  cal: number;
  pro: number;
  carb: number;
  fat: number;
  ingredients: DevIngredient[];
  steps: DevStep[];
}

interface DevMultiDishMeal {
  mealId: string;
  title: string;
  description: string;
  cuisine: string;
  minutes: number;
  difficulty: "easy" | "medium" | "fancy";
  servings: number;
  cal: number;
  pro: number;
  carb: number;
  fat: number;
  tags: string[];
  dishes: DevDish[];
}

const MULTI_DISH_MEAL: DevMultiDishMeal = {
  mealId: DEV_MEAL_IDS.salmonRicePilaf,
  title: "Salmon with Rice Pilaf",
  description:
    "Seared salmon over a buttery rice pilaf — two dishes plated as one meal.",
  cuisine: "American",
  minutes: 35,
  difficulty: "medium",
  servings: 4,
  cal: 640,
  pro: 38,
  carb: 48,
  fat: 26,
  tags: ["high-protein", "pescatarian", "multi-dish", DEV_TAG],
  dishes: [
    {
      dishId: DEV_DISH_IDS.searedSalmon,
      title: "Seared Salmon",
      roleLabel: "main",
      positionIndex: 0,
      minutes: 15,
      difficulty: "medium",
      servings: 4,
      cal: 420,
      pro: 34,
      carb: 6,
      fat: 28,
      ingredients: [
        { name: "Salmon fillets", category: "Protein", quantity: 4, unit: "6 oz" },
        { name: "Lemon", category: "Produce", quantity: 1, unit: "each" },
        { name: "Olive oil", category: "Pantry", quantity: 2, unit: "tbsp" },
        { name: "Fresh dill", category: "Produce", quantity: 1, unit: "bunch", isOptional: true },
      ],
      steps: [
        { text: "Pat salmon fillets dry; season with salt, pepper, and a squeeze of lemon.", estimatedMinutes: 2, isTimingSensitive: false },
        { text: "Heat olive oil in a skillet over medium-high; sear salmon skin-side down for 4 minutes.", estimatedMinutes: 4, isTimingSensitive: true },
        { text: "Flip and cook 3 more minutes until just opaque; finish with fresh dill.", estimatedMinutes: 3, isTimingSensitive: true },
      ],
    },
    {
      dishId: DEV_DISH_IDS.ricePilaf,
      title: "Rice Pilaf",
      roleLabel: "side",
      positionIndex: 1,
      minutes: 25,
      difficulty: "easy",
      servings: 4,
      cal: 220,
      pro: 4,
      carb: 42,
      fat: 6,
      ingredients: [
        { name: "Basmati rice", category: "Pantry", quantity: 1, unit: "cup" },
        { name: "Yellow onion", category: "Produce", quantity: 1, unit: "each" },
        { name: "Vegetable broth", category: "Pantry", quantity: 2, unit: "cups" },
        { name: "Butter", category: "Dairy", quantity: 2, unit: "tbsp" },
      ],
      steps: [
        { text: "Melt butter in a saucepan; sauté diced onion until translucent, 4 minutes.", estimatedMinutes: 5, isTimingSensitive: true },
        { text: "Add basmati rice; toast 1 minute, stirring to coat.", estimatedMinutes: 1, isTimingSensitive: true },
        { text: "Pour in vegetable broth; bring to a boil, cover, and simmer 15 minutes.", estimatedMinutes: 15, isTimingSensitive: true },
        { text: "Rest off heat 5 minutes; fluff with a fork.", estimatedMinutes: 5, isTimingSensitive: true },
      ],
    },
  ],
};

// ── public discovery templates (WS7-3 A2) ───────────────────────────────────

interface DevDiscoveryTemplateItem {
  mealId: string;
  positionIndex: number;
  /** "Monday" .. "Sunday" or null for unscheduled */
  assignedDayOfWeek: string | null;
  slot: "breakfast" | "lunch" | "dinner";
}

interface DevDiscoveryTemplate {
  id: string;
  title: string;
  description: string;
  tags: string[];
  defaultDaysCount: number;
  /** Top Rated counter inputs — distributed so top_rated ranking has a clear order. */
  saveCount: number;
  useCount: number;
  isFeatured: boolean;
  isHostingFeatured: boolean;
  occasionType: string | null;
  /** WS7-4-B c2: placeholder Unsplash thumbnail per Q-P1-2 (Hans can swap any of these). */
  imageUrl: string;
  /** WS7-4-B c2: per Q-P1-1 ruling — meal slots for the Use Plan flow. */
  items: DevDiscoveryTemplateItem[];
}

// Featuring flags carry NO scheduled dates → always-visible windows. Counters
// distributed so useCount-DESC ordering (the top_rated tie-break while
// topRatedScore stays null) yields: quick-weeknights > family-favorites >
// budget-bowls > holiday-hosting.
const DISCOVERY_TEMPLATES: DevDiscoveryTemplate[] = [
  {
    id: DEV_DISCOVERY_TEMPLATE_IDS.familyFavorites,
    title: "Family Favorites Week",
    description: "A week of crowd-pleasing dinners the whole household will eat.",
    tags: ["family", "kid-friendly", DEV_TAG],
    defaultDaysCount: 5,
    saveCount: 12,
    useCount: 8,
    isFeatured: true,
    isHostingFeatured: false,
    occasionType: null,
    imageUrl:
      "https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=800&q=80",
    items: [
      { mealId: DEV_MEAL_IDS.beefTacos, positionIndex: 0, assignedDayOfWeek: "Monday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.fajitas, positionIndex: 1, assignedDayOfWeek: "Tuesday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.carbonara, positionIndex: 2, assignedDayOfWeek: "Wednesday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.tikkaMasala, positionIndex: 3, assignedDayOfWeek: "Thursday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.grainBowl, positionIndex: 4, assignedDayOfWeek: "Friday", slot: "dinner" },
    ],
  },
  {
    id: DEV_DISCOVERY_TEMPLATE_IDS.quickWeeknights,
    title: "Quick Weeknights",
    description: "Five 30-minute dinners for busy weeknights.",
    tags: ["quick", "weeknight", DEV_TAG],
    defaultDaysCount: 5,
    saveCount: 5,
    useCount: 12,
    isFeatured: true,
    isHostingFeatured: false,
    occasionType: null,
    imageUrl:
      "https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=800&q=80",
    items: [
      { mealId: DEV_MEAL_IDS.fajitas, positionIndex: 0, assignedDayOfWeek: "Monday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.beefTacos, positionIndex: 1, assignedDayOfWeek: "Tuesday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.padThai, positionIndex: 2, assignedDayOfWeek: "Wednesday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.carbonara, positionIndex: 3, assignedDayOfWeek: "Thursday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.grainBowl, positionIndex: 4, assignedDayOfWeek: "Friday", slot: "dinner" },
    ],
  },
  {
    id: DEV_DISCOVERY_TEMPLATE_IDS.holidayHosting,
    title: "Holiday Hosting Menu",
    description: "An elevated multi-course menu for hosting a holiday gathering.",
    tags: ["hosting", "holiday", "entertaining", DEV_TAG],
    defaultDaysCount: 3,
    saveCount: 8,
    useCount: 3,
    isFeatured: false,
    isHostingFeatured: true,
    occasionType: "holiday",
    imageUrl:
      "https://images.unsplash.com/photo-1606787366850-de6330128bfc?auto=format&fit=crop&w=800&q=80",
    items: [
      { mealId: DEV_MEAL_IDS.salmonRicePilaf, positionIndex: 0, assignedDayOfWeek: null, slot: "dinner" },
      { mealId: DEV_MEAL_IDS.tikkaMasala, positionIndex: 1, assignedDayOfWeek: null, slot: "dinner" },
      { mealId: DEV_MEAL_IDS.carbonara, positionIndex: 2, assignedDayOfWeek: null, slot: "dinner" },
    ],
  },
  {
    id: DEV_DISCOVERY_TEMPLATE_IDS.budgetBowls,
    title: "Budget Bowls",
    description: "Hearty grain bowls that keep the weekly grocery bill down.",
    tags: ["budget", "meal-prep", DEV_TAG],
    defaultDaysCount: 5,
    saveCount: 3,
    useCount: 5,
    isFeatured: false,
    isHostingFeatured: false,
    occasionType: null,
    imageUrl:
      "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800&q=80",
    items: [
      { mealId: DEV_MEAL_IDS.grainBowl, positionIndex: 0, assignedDayOfWeek: "Monday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.padThai, positionIndex: 1, assignedDayOfWeek: "Tuesday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.beefTacos, positionIndex: 2, assignedDayOfWeek: "Wednesday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.grainBowl, positionIndex: 3, assignedDayOfWeek: "Thursday", slot: "dinner" },
      { mealId: DEV_MEAL_IDS.carbonara, positionIndex: 4, assignedDayOfWeek: "Friday", slot: "dinner" },
    ],
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────

function canonicalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Sunday of the calendar week containing `date` (UTC), matching the runtime
 * currentWeekRange() helper in src/lib/planDates.ts. Sun = day 0 → offset = -day;
 * gives Sun-Sat alignment so seeded plan dates and the runtime resolver agree
 * about which week a row covers. WS7-6 (E) Block 1 REWORK D-WS7-100 fold-in.
 */
function startOfWeekSunday(date: Date): Date {
  const day = date.getUTCDay();
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day),
  );
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function ensureIngredient(
  ing: DevIngredient,
): Promise<string> {
  const canonical = canonicalize(ing.name);
  const purchase = INGREDIENT_PURCHASE_DEFAULTS[canonical] ?? null;
  const payload = {
    displayName: ing.name,
    category: ing.category,
    defaultUnit: ing.unit || "each",
    purchaseUnit: purchase?.purchaseUnit ?? null,
    purchaseQuantity: purchase?.purchaseQuantity ?? null,
    purchaseDisplay: purchase?.purchaseDisplay ?? null,
  };
  // Update on re-seed so purchase defaults + category renames propagate to
  // rows already created by earlier seed runs.
  const rec = await prisma.ingredient.upsert({
    where: { canonicalName: canonical },
    update: payload,
    create: { canonicalName: canonical, ...payload },
    select: { id: true },
  });
  return rec.id;
}

// ── seed steps ───────────────────────────────────────────────────────────────

interface DevUser {
  id: string;
}

async function ensureDevUser(): Promise<DevUser> {
  const existing = await prisma.user.findUnique({
    where: { email: DEV_USER_EMAIL },
    select: { id: true },
  });
  if (existing) return existing;

  // Defensive — Hans's account already exists, but we don't crash if it doesn't.
  // No password is set; sign-in flows would need to reset it.
  const created = await prisma.user.create({
    data: {
      email: DEV_USER_EMAIL,
      firstName: "Hans",
      lastName: "Tiefenthaler",
    },
    select: { id: true },
  });
  console.log(`[devData] created dev user (${DEV_USER_EMAIL}) — ${created.id}`);
  return created;
}

async function ensureUserPreferences(userId: string): Promise<void> {
  await prisma.userPreferences.upsert({
    where: { userId },
    update: {
      householdSize: 2,
      weeklyPacingDefault: "one_fancy_night",
      cuisines: [
        "mexican",
        "italian",
        "mediterranean",
        "thai",
        "indian",
        "tex_mex",
      ],
      cookingEquipment: ["oven", "stovetop", "sheet_pan", "instant_pot"],
      spiceTolerance: "medium",
      difficultyDefault: "medium",
      budgetLevel: "mid_range",
      recurringGroceryItems: ["eggs", "milk", "bread", "coffee"],
    },
    create: {
      userId,
      householdSize: 2,
      weeklyPacingDefault: "one_fancy_night",
      cuisines: [
        "mexican",
        "italian",
        "mediterranean",
        "thai",
        "indian",
        "tex_mex",
      ],
      cookingEquipment: ["oven", "stovetop", "sheet_pan", "instant_pot"],
      spiceTolerance: "medium",
      difficultyDefault: "medium",
      budgetLevel: "mid_range",
      recurringGroceryItems: ["eggs", "milk", "bread", "coffee"],
    },
  });
}

async function ensureSubscription(userId: string): Promise<void> {
  const existing = await prisma.subscription.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (existing) return;

  const now = new Date();
  await prisma.subscription.create({
    data: {
      userId,
      planCode: "free",
      status: "trialing",
      trialEndsAt: addDays(now, 30),
      currentPeriodStart: now,
      currentPeriodEnd: addDays(now, 30),
    },
  });
  console.log(`[devData] created trialing Subscription for dev user`);
}

async function seedMeal(userId: string, m: DevMeal): Promise<void> {
  const ingredientIds = await Promise.all(m.ingredients.map(ensureIngredient));

  const lastUsedAt =
    m.cookHistoryDaysAgo !== null
      ? addDays(new Date(), -m.cookHistoryDaysAgo)
      : null;

  await prisma.$transaction(
    async (tx) => {
      await tx.meal.upsert({
        where: { id: m.mealId },
        update: {
          userId,
          title: m.title,
          description: m.description,
          cuisineType: m.cuisine,
          mealType: "dinner",
          difficulty: m.difficulty,
          sourceType: "manual",
          estimatedTimeMinutes: m.minutes,
          servingsDefault: m.servings,
          caloriesPerServing: m.cal,
          proteinGPerServing: m.pro,
          carbsGPerServing: m.carb,
          fatGPerServing: m.fat,
          tags: m.tags,
          timesCooked: m.cookCount,
          lastUsedAt,
        },
        create: {
          id: m.mealId,
          userId,
          title: m.title,
          description: m.description,
          cuisineType: m.cuisine,
          mealType: "dinner",
          difficulty: m.difficulty,
          sourceType: "manual",
          estimatedTimeMinutes: m.minutes,
          servingsDefault: m.servings,
          caloriesPerServing: m.cal,
          proteinGPerServing: m.pro,
          carbsGPerServing: m.carb,
          fatGPerServing: m.fat,
          tags: m.tags,
          timesCooked: m.cookCount,
          lastUsedAt,
        },
      });

      await tx.dish.upsert({
        where: { id: m.dishId },
        update: {
          userId,
          title: m.title,
          difficulty: m.difficulty,
          sourceType: "manual",
          estimatedTimeMinutes: m.minutes,
          servingsDefault: m.servings,
          caloriesPerServing: m.cal,
          proteinGPerServing: m.pro,
          carbsGPerServing: m.carb,
          fatGPerServing: m.fat,
          tags: m.tags,
        },
        create: {
          id: m.dishId,
          userId,
          title: m.title,
          difficulty: m.difficulty,
          sourceType: "manual",
          estimatedTimeMinutes: m.minutes,
          servingsDefault: m.servings,
          caloriesPerServing: m.cal,
          proteinGPerServing: m.pro,
          carbsGPerServing: m.carb,
          fatGPerServing: m.fat,
          tags: m.tags,
        },
      });

      await tx.mealDishLink.upsert({
        where: { mealId_dishId: { mealId: m.mealId, dishId: m.dishId } },
        update: { roleLabel: "main", positionIndex: 0 },
        create: {
          mealId: m.mealId,
          dishId: m.dishId,
          roleLabel: "main",
          positionIndex: 0,
        },
      });

      await tx.dishIngredient.deleteMany({ where: { dishId: m.dishId } });
      await tx.dishIngredient.createMany({
        data: m.ingredients.map((ing, i) => ({
          dishId: m.dishId,
          ingredientId: ingredientIds[i],
          quantity: ing.quantity,
          unit: ing.unit,
          isOptional: ing.isOptional ?? false,
          positionIndex: i,
        })),
      });

      // Steps own to the Meal (verified per preflight: routes/recipes.ts
      // reads with ownerType: "meal").
      await tx.recipeInstructionStep.deleteMany({
        where: { ownerType: "meal", ownerId: m.mealId },
      });
      await tx.recipeInstructionStep.createMany({
        data: m.steps.map((step, i) => ({
          ownerType: "meal",
          ownerId: m.mealId,
          stepIndex: i,
          stepTextRaw: step.text,
          stepTextTranslated: step.text,
          phaseType: "cook",
          estimatedMinutes: step.estimatedMinutes,
          isTimingSensitive: step.isTimingSensitive,
        })),
      });
    },
    { timeout: 30_000 },
  );

  console.log(
    `[devData] seeded meal ${m.mealId}: ${m.ingredients.length} ingredients, ${m.steps.length} steps`,
  );
}

// Multi-dish variant: one public Meal linked to N Dishes via MealDishLink with
// explicit positionIndex. Each Dish carries its own ingredients and dish-owned
// RecipeInstructionStep rows (ownerType: "dish"). Idempotent — child rows are
// delete-then-insert scoped to the seed's deterministic IDs.
async function seedMultiDishMeal(
  userId: string,
  m: DevMultiDishMeal,
): Promise<void> {
  // Resolve ingredient IDs per dish up front (outside the transaction).
  const dishIngredientIds = await Promise.all(
    m.dishes.map((d) => Promise.all(d.ingredients.map(ensureIngredient))),
  );

  await prisma.$transaction(
    async (tx) => {
      await tx.meal.upsert({
        where: { id: m.mealId },
        update: {
          userId,
          title: m.title,
          description: m.description,
          cuisineType: m.cuisine,
          mealType: "dinner",
          difficulty: m.difficulty,
          sourceType: "manual",
          estimatedTimeMinutes: m.minutes,
          servingsDefault: m.servings,
          caloriesPerServing: m.cal,
          proteinGPerServing: m.pro,
          carbsGPerServing: m.carb,
          fatGPerServing: m.fat,
          tags: m.tags,
          isPublic: true,
          isArchived: false,
        },
        create: {
          id: m.mealId,
          userId,
          title: m.title,
          description: m.description,
          cuisineType: m.cuisine,
          mealType: "dinner",
          difficulty: m.difficulty,
          sourceType: "manual",
          estimatedTimeMinutes: m.minutes,
          servingsDefault: m.servings,
          caloriesPerServing: m.cal,
          proteinGPerServing: m.pro,
          carbsGPerServing: m.carb,
          fatGPerServing: m.fat,
          tags: m.tags,
          isPublic: true,
          isArchived: false,
        },
      });

      for (let di = 0; di < m.dishes.length; di++) {
        const d = m.dishes[di];

        await tx.dish.upsert({
          where: { id: d.dishId },
          update: {
            userId,
            title: d.title,
            difficulty: d.difficulty,
            sourceType: "manual",
            estimatedTimeMinutes: d.minutes,
            servingsDefault: d.servings,
            caloriesPerServing: d.cal,
            proteinGPerServing: d.pro,
            carbsGPerServing: d.carb,
            fatGPerServing: d.fat,
            tags: m.tags,
          },
          create: {
            id: d.dishId,
            userId,
            title: d.title,
            difficulty: d.difficulty,
            sourceType: "manual",
            estimatedTimeMinutes: d.minutes,
            servingsDefault: d.servings,
            caloriesPerServing: d.cal,
            proteinGPerServing: d.pro,
            carbsGPerServing: d.carb,
            fatGPerServing: d.fat,
            tags: m.tags,
          },
        });

        await tx.mealDishLink.upsert({
          where: { mealId_dishId: { mealId: m.mealId, dishId: d.dishId } },
          update: { roleLabel: d.roleLabel, positionIndex: d.positionIndex },
          create: {
            mealId: m.mealId,
            dishId: d.dishId,
            roleLabel: d.roleLabel,
            positionIndex: d.positionIndex,
          },
        });

        await tx.dishIngredient.deleteMany({ where: { dishId: d.dishId } });
        await tx.dishIngredient.createMany({
          data: d.ingredients.map((ing, i) => ({
            dishId: d.dishId,
            ingredientId: dishIngredientIds[di][i],
            quantity: ing.quantity,
            unit: ing.unit,
            isOptional: ing.isOptional ?? false,
            positionIndex: i,
          })),
        });

        // Steps own to the Dish (ownerType: "dish") — this is the path the
        // WS7-3 multi-dish read fix resolves per-dish.
        await tx.recipeInstructionStep.deleteMany({
          where: { ownerType: "dish", ownerId: d.dishId },
        });
        await tx.recipeInstructionStep.createMany({
          data: d.steps.map((step, i) => ({
            ownerType: "dish",
            ownerId: d.dishId,
            stepIndex: i,
            stepTextRaw: step.text,
            stepTextTranslated: step.text,
            phaseType: "cook",
            estimatedMinutes: step.estimatedMinutes,
            isTimingSensitive: step.isTimingSensitive,
          })),
        });
      }
    },
    { timeout: 30_000 },
  );

  console.log(
    `[devData] seeded multi-dish meal ${m.mealId}: ${m.dishes.length} dishes ` +
      `(${m.dishes.map((d) => `${d.dishId}:${d.ingredients.length}ing/${d.steps.length}steps`).join(", ")})`,
  );
}

// WS7-3 A2 — upsert a standalone public MealPlanTemplate (no instances) with
// non-zero Top Rated counters + featuring flags. Idempotent on the
// deterministic id. topRatedScore is left null — A2 ships the scoring helper
// but does not invoke recomputeAndPersistTopRated() at any trigger site, so
// the seed mirrors that (the /plans top_rated query orders by topRatedScore
// DESC NULLS LAST, then useCount DESC — non-degenerate with score null).
async function seedDiscoveryTemplate(
  userId: string,
  t: DevDiscoveryTemplate,
): Promise<void> {
  const fields = {
    userId,
    title: t.title,
    description: t.description,
    sourceType: "wizard" as const,
    defaultDaysCount: t.defaultDaysCount,
    tags: t.tags,
    imageUrl: t.imageUrl,
    isPublic: true,
    isArchived: false,
    saveCount: t.saveCount,
    useCount: t.useCount,
    isFeatured: t.isFeatured,
    isHostingFeatured: t.isHostingFeatured,
    occasionType: t.occasionType,
  };
  await prisma.$transaction(async (tx) => {
    await tx.mealPlanTemplate.upsert({
      where: { id: t.id },
      update: fields,
      create: { id: t.id, ...fields },
    });
    // WS7-4-B c2: replace items wholesale on re-seed (idempotent).
    await tx.mealPlanTemplateItem.deleteMany({
      where: { mealPlanTemplateId: t.id },
    });
    if (t.items.length > 0) {
      await tx.mealPlanTemplateItem.createMany({
        data: t.items.map((it) => ({
          mealPlanTemplateId: t.id,
          mealId: it.mealId,
          positionIndex: it.positionIndex,
          assignedDayOfWeek: it.assignedDayOfWeek,
          isBreakfast: it.slot === "breakfast",
          isLunch: it.slot === "lunch",
          isDinner: it.slot === "dinner",
        })),
      });
    }
  });
  console.log(
    `[devData] seeded discovery template ${t.id}: ` +
      `save=${t.saveCount} use=${t.useCount} featured=${t.isFeatured} hosting=${t.isHostingFeatured} items=${t.items.length}`,
  );
}

interface PlanSeedItem {
  id: string;
  mealId: string;
  positionIndex: number;
  /** "Monday" .. "Sunday" or null for unscheduled */
  day: string | null;
}

interface PlanSeed {
  templateId: string;
  instanceId: string;
  title: string;
  status: "this_week" | "upcoming" | "draft";
  // WS7-6 (E) Block 1 REWORK: Model 2. Plans MAY share date ranges; the
  // resolver picks the winner by newest activatedAt among covering rows.
  // activatedAt is non-null on the intended winner (deterministic) and
  // null on other rows.
  startDate: Date | null;
  endDate: Date | null;
  activatedAt: Date | null;
  items: PlanSeedItem[];
}

async function seedPlan(userId: string, plan: PlanSeed): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.mealPlanTemplate.upsert({
        where: { id: plan.templateId },
        update: {
          userId,
          title: plan.title,
          sourceType: "manual",
          defaultDaysCount: plan.items.length,
        },
        create: {
          id: plan.templateId,
          userId,
          title: plan.title,
          sourceType: "manual",
          defaultDaysCount: plan.items.length,
        },
      });

      await tx.mealPlanInstance.upsert({
        where: { id: plan.instanceId },
        update: {
          userId,
          mealPlanTemplateId: plan.templateId,
          titleOverride: plan.title,
          status: plan.status,
          startDate: plan.startDate,
          endDate: plan.endDate,
          activatedAt: plan.activatedAt,
        },
        create: {
          id: plan.instanceId,
          userId,
          mealPlanTemplateId: plan.templateId,
          titleOverride: plan.title,
          status: plan.status,
          startDate: plan.startDate,
          endDate: plan.endDate,
          activatedAt: plan.activatedAt,
        },
      });

      await tx.mealPlanItem.deleteMany({
        where: { mealPlanInstanceId: plan.instanceId },
      });

      // WS7-6 (E) Block 1 REWORK D-WS7-100: align to Sunday-based weeks so
      // assignedDate offsets agree with runtime currentWeekRange() (Sun-Sat
      // UTC). Plan.startDate IS the Sunday of the seeded week — same
      // anchor as the Monday→0 offset table below shifted by one (Sun→0).
      const weekStart = plan.startDate ? startOfWeekSunday(plan.startDate) : null;
      const dayOffset: Record<string, number> = {
        Sunday: 0,
        Monday: 1,
        Tuesday: 2,
        Wednesday: 3,
        Thursday: 4,
        Friday: 5,
        Saturday: 6,
      };

      await tx.mealPlanItem.createMany({
        data: plan.items.map((it) => ({
          id: it.id,
          mealPlanInstanceId: plan.instanceId,
          mealId: it.mealId,
          positionIndex: it.positionIndex,
          assignedDayOfWeek: it.day,
          assignedDate:
            it.day && weekStart ? addDays(weekStart, dayOffset[it.day]) : null,
          isDinner: true,
        })),
      });
    },
    { timeout: 30_000 },
  );

  console.log(
    `[devData] seeded plan ${plan.instanceId} (${plan.title}): ${plan.items.length} items, status=${plan.status}, dates=[${plan.startDate?.toISOString() ?? "null"}..${plan.endDate?.toISOString() ?? "null"}]`,
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const user = await ensureDevUser();
  console.log(`[devData] using dev user ${user.id} (${DEV_USER_EMAIL})`);

  await ensureUserPreferences(user.id);
  await ensureSubscription(user.id);

  for (const m of MEALS) {
    await seedMeal(user.id, m);
  }

  await seedMultiDishMeal(user.id, MULTI_DISH_MEAL);

  for (const t of DISCOVERY_TEMPLATES) {
    await seedDiscoveryTemplate(user.id, t);
  }

  // WS7-6 (E) Block 1 REWORK — D-WS7-100. Sunday-based week alignment so
  // seeded covering dates agree with runtime currentWeekRange() (Sun-Sat
  // UTC). Plans MAY share date ranges under Model 2 — no EXCLUDE
  // constraint — so demoPlan returns to current week alongside weeknightPlan
  // and the resolver picks the winner by newest activatedAt. weeknightPlan
  // is stamped (the intended This Week's plan); demoPlan stays null-activatedAt
  // so weeknightPlan wins deterministically.
  const weekStart = startOfWeekSunday(new Date());
  const weekEnd = addDays(weekStart, 6);
  const seedActivatedAt = new Date();

  const weeknightPlan: PlanSeed = {
    templateId: DEV_PLAN_IDS.weeknightTemplate,
    instanceId: DEV_PLAN_IDS.weeknightInstance,
    title: "Weeknight Dinners",
    status: "this_week",
    startDate: weekStart,
    endDate: weekEnd,
    activatedAt: seedActivatedAt,
    items: [
      {
        id: "dev-plan-item-weeknight-tacos",
        mealId: DEV_MEAL_IDS.beefTacos,
        positionIndex: 0,
        day: "Monday",
      },
      {
        id: "dev-plan-item-weeknight-carbonara",
        mealId: DEV_MEAL_IDS.carbonara,
        positionIndex: 1,
        day: "Tuesday",
      },
      {
        id: "dev-plan-item-weeknight-fajitas",
        mealId: DEV_MEAL_IDS.fajitas,
        positionIndex: 2,
        day: "Wednesday",
      },
      {
        id: "dev-plan-item-weeknight-grain-bowl",
        mealId: DEV_MEAL_IDS.grainBowl,
        positionIndex: 3,
        day: "Thursday",
      },
    ],
  };

  const spicePlan: PlanSeed = {
    templateId: DEV_PLAN_IDS.spiceTemplate,
    instanceId: DEV_PLAN_IDS.spiceInstance,
    title: "Spice It Up",
    status: "upcoming",
    startDate: null,
    endDate: null,
    activatedAt: null,
    items: [
      {
        id: "dev-plan-item-spice-tikka",
        mealId: DEV_MEAL_IDS.tikkaMasala,
        positionIndex: 0,
        day: null,
      },
      {
        id: "dev-plan-item-spice-padthai",
        mealId: DEV_MEAL_IDS.padThai,
        positionIndex: 1,
        day: null,
      },
    ],
  };

  // WS7-3 C4 c7 — demo plan. Instance id is the literal "demo" so the dev
  // "Inject dev test plan" affordance's /plan/demo deep-link resolves to a
  // real MealPlanInstance. Mirrors the weeknightPlan shape (Mon–Fri dinners,
  // current-week span) with a different meal selection that exercises the
  // multi-dish meal (salmon + rice pilaf) on the demo row.
  const demoPlan: PlanSeed = {
    templateId: DEV_PLAN_IDS.demoTemplate,
    instanceId: DEV_PLAN_IDS.demoInstance,
    title: "Demo Plan",
    status: "draft",
    // WS7-6 (E) Block 1 REWORK: returns to current week (no EXCLUDE
    // constraint under Model 2). activatedAt stays null so it LOSES the
    // tiebreak to weeknightPlan (which is stamped). Demo still covers
    // now → wire boolean ships false (covering-but-not-winner) → mobile's
    // /plan/demo deep-link resolves as a saved plan, not the This Week plan.
    startDate: weekStart,
    endDate: weekEnd,
    activatedAt: null,
    items: [
      {
        id: "demo-item-1",
        mealId: DEV_MEAL_IDS.beefTacos,
        positionIndex: 0,
        day: "Monday",
      },
      {
        id: "demo-item-2",
        mealId: DEV_MEAL_IDS.carbonara,
        positionIndex: 1,
        day: "Tuesday",
      },
      {
        id: "demo-item-3",
        mealId: DEV_MEAL_IDS.tikkaMasala,
        positionIndex: 2,
        day: "Wednesday",
      },
      {
        id: "demo-item-4",
        mealId: DEV_MEAL_IDS.padThai,
        positionIndex: 3,
        day: "Thursday",
      },
      {
        id: "demo-item-5",
        mealId: DEV_MEAL_IDS.salmonRicePilaf,
        positionIndex: 4,
        day: "Friday",
      },
    ],
  };

  await seedPlan(user.id, weeknightPlan);
  await seedPlan(user.id, spicePlan);
  await seedPlan(user.id, demoPlan);

  console.log(
    `[devData] done. dev user has ${MEALS.length + 1} meals ` +
      `(${MEALS.length} single-dish + 1 multi-dish) + 3 plans (1 active, 1 saved, 1 demo) ` +
      `+ ${DISCOVERY_TEMPLATES.length} public discovery templates.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
