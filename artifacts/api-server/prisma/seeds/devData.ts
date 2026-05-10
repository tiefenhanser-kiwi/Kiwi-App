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
} as const;

const DEV_DISH_IDS = {
  beefTacos: "dev-dish-beef-tacos",
  carbonara: "dev-dish-spaghetti-carbonara",
  tikkaMasala: "dev-dish-chicken-tikka-masala",
  grainBowl: "dev-dish-mediterranean-grain-bowl",
  padThai: "dev-dish-pad-thai",
  fajitas: "dev-dish-sheet-pan-fajitas",
} as const;

const DEV_PLAN_IDS = {
  weeknightTemplate: "dev-plan-template-weeknight",
  weeknightInstance: "dev-plan-instance-weeknight",
  spiceTemplate: "dev-plan-template-spice-it-up",
  spiceInstance: "dev-plan-instance-spice-it-up",
} as const;

const DEV_TAG = "dev";

// ── meal data ────────────────────────────────────────────────────────────────

type IngredientCategory =
  | "Produce"
  | "Protein"
  | "Dairy"
  | "Pantry"
  | "Bakery"
  | "Frozen";

interface DevIngredient {
  name: string;
  category: IngredientCategory;
  quantity: number;
  unit: string;
  isOptional?: boolean;
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
  steps: string[];
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
      "Brown ground beef in a skillet over medium-high heat for 8 minutes.",
      "Stir in taco seasoning with a splash of water; simmer 2 minutes.",
      "Warm taco shells in a 350°F oven for 5 minutes.",
      "Shred lettuce, dice tomato, grate cheddar.",
      "Assemble: shell, beef, lettuce, tomato, cheese, salsa, sour cream.",
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
      "Bring salted water to boil; cook spaghetti just shy of al dente; reserve 1 cup pasta water.",
      "Render diced bacon in a wide pan over medium heat until crisp; add minced garlic for 30 seconds.",
      "Whisk eggs and grated parmesan in a bowl with cracked black pepper.",
      "Off heat, toss hot pasta with bacon, then with egg mixture, adding pasta water until creamy.",
      "Top with extra parmesan, pepper, and parsley.",
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
      { name: "Coconut milk", category: "Pantry", quantity: 1, unit: "can" },
      { name: "Diced tomatoes", category: "Pantry", quantity: 1, unit: "can" },
      { name: "Basmati rice", category: "Pantry", quantity: 1.5, unit: "cups" },
      { name: "Yellow onion", category: "Produce", quantity: 1, unit: "each" },
      { name: "Garlic", category: "Produce", quantity: 4, unit: "cloves" },
      { name: "Ginger", category: "Produce", quantity: 1, unit: "inch" },
    ],
    steps: [
      "Cube chicken thighs; toss with half the tikka paste; marinate 10 minutes.",
      "Cook basmati rice per package directions.",
      "Sauté diced onion with garlic and grated ginger in oil until soft, 5 minutes.",
      "Add chicken; sear 4 minutes per side.",
      "Stir in remaining paste, diced tomatoes, and coconut milk; simmer 15 minutes.",
      "Serve over basmati rice.",
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
      { name: "Chickpeas", category: "Pantry", quantity: 1, unit: "can" },
      { name: "Cucumber", category: "Produce", quantity: 1, unit: "each" },
      { name: "Cherry tomatoes", category: "Produce", quantity: 1, unit: "pint" },
      { name: "Feta", category: "Dairy", quantity: 4, unit: "oz" },
      { name: "Lemon", category: "Produce", quantity: 1, unit: "each" },
      { name: "Tahini", category: "Pantry", quantity: 0.25, unit: "cup" },
      { name: "Olive oil", category: "Pantry", quantity: 3, unit: "tbsp" },
    ],
    steps: [
      "Simmer farro in 2 cups water for 15 minutes; drain.",
      "Drain and rinse chickpeas; halve cherry tomatoes; dice cucumber.",
      "Whisk lemon juice, tahini, olive oil, and a splash of water into a creamy dressing.",
      "Build bowls: farro base, chickpeas, vegetables, crumbled feta.",
      "Drizzle with dressing.",
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
      "Soak rice noodles in hot water for 8 minutes; drain.",
      "Whisk tamarind paste, fish sauce, and a splash of water for the sauce.",
      "Heat oil in a wok; scramble eggs and push to the side.",
      "Add shrimp; stir-fry 2 minutes until pink.",
      "Toss in noodles and sauce; cook 2 minutes.",
      "Off heat, fold in bean sprouts; top with crushed peanuts and lime wedges.",
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
      "Preheat oven to 425°F.",
      "Slice chicken breast, bell peppers, and onion into strips.",
      "Toss everything on a sheet pan with fajita seasoning, oil, and lime juice.",
      "Roast 20 minutes until chicken is cooked through and edges char.",
      "Warm tortillas wrapped in foil during the last 5 minutes.",
      "Assemble fajitas; top with cilantro and sour cream.",
    ],
    cookHistoryDaysAgo: null,
    cookCount: 0,
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────

function canonicalize(name: string): string {
  return name.trim().toLowerCase();
}

/** Monday of the calendar week containing `date` (in local time). */
function startOfWeekMonday(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offset);
  return d;
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
  const rec = await prisma.ingredient.upsert({
    where: { canonicalName: canonical },
    update: {},
    create: {
      canonicalName: canonical,
      displayName: ing.name,
      category: ing.category,
      defaultUnit: ing.unit || "each",
    },
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
      cuisinePreferences: [
        "mexican",
        "italian",
        "mediterranean",
        "thai",
        "indian",
        "tex_mex",
      ],
      equipment: ["oven", "stovetop", "sheet_pan", "instant_pot"],
      spiceTolerance: "medium",
      difficultyDefault: "medium",
      budgetLevel: "mid_range",
      recurringItems: ["eggs", "milk", "bread", "coffee"],
    },
    create: {
      userId,
      householdSize: 2,
      weeklyPacingDefault: "one_fancy_night",
      cuisinePreferences: [
        "mexican",
        "italian",
        "mediterranean",
        "thai",
        "indian",
        "tex_mex",
      ],
      equipment: ["oven", "stovetop", "sheet_pan", "instant_pot"],
      spiceTolerance: "medium",
      difficultyDefault: "medium",
      budgetLevel: "mid_range",
      recurringItems: ["eggs", "milk", "bread", "coffee"],
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
        data: m.steps.map((text, i) => ({
          ownerType: "meal",
          ownerId: m.mealId,
          stepIndex: i,
          stepTextRaw: text,
          stepTextTranslated: text,
          phaseType: "cook",
        })),
      });
    },
    { timeout: 30_000 },
  );

  console.log(
    `[devData] seeded meal ${m.mealId}: ${m.ingredients.length} ingredients, ${m.steps.length} steps`,
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
  status: "this_week" | "upcoming";
  isActiveThisWeek: boolean;
  startDate: Date | null;
  endDate: Date | null;
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
          isActiveThisWeek: plan.isActiveThisWeek,
          startDate: plan.startDate,
          endDate: plan.endDate,
        },
        create: {
          id: plan.instanceId,
          userId,
          mealPlanTemplateId: plan.templateId,
          titleOverride: plan.title,
          status: plan.status,
          isActiveThisWeek: plan.isActiveThisWeek,
          startDate: plan.startDate,
          endDate: plan.endDate,
        },
      });

      await tx.mealPlanItem.deleteMany({
        where: { mealPlanInstanceId: plan.instanceId },
      });

      const weekStart = plan.startDate ? startOfWeekMonday(plan.startDate) : null;
      const dayOffset: Record<string, number> = {
        Monday: 0,
        Tuesday: 1,
        Wednesday: 2,
        Thursday: 3,
        Friday: 4,
        Saturday: 5,
        Sunday: 6,
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
    `[devData] seeded plan ${plan.instanceId} (${plan.title}): ${plan.items.length} items, status=${plan.status}, active=${plan.isActiveThisWeek}`,
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

  const weekStart = startOfWeekMonday(new Date());
  const weekEnd = addDays(weekStart, 6);

  const weeknightPlan: PlanSeed = {
    templateId: DEV_PLAN_IDS.weeknightTemplate,
    instanceId: DEV_PLAN_IDS.weeknightInstance,
    title: "Weeknight Dinners",
    status: "this_week",
    isActiveThisWeek: true,
    startDate: weekStart,
    endDate: weekEnd,
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
    isActiveThisWeek: false,
    startDate: null,
    endDate: null,
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

  await seedPlan(user.id, weeknightPlan);
  await seedPlan(user.id, spicePlan);

  console.log(
    `[devData] done. dev user has ${MEALS.length} meals + 2 plans (1 active, 1 saved).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
