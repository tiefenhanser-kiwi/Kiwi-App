-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'paused', 'deleted', 'blocked');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'none');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('free', 'premium_monthly', 'premium_annual');

-- CreateEnum
CREATE TYPE "MealType" AS ENUM ('breakfast', 'lunch', 'dinner', 'snack', 'mixed');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('wizard', 'directed', 'imported_url', 'uploaded_image', 'manual', 'curated');

-- CreateEnum
CREATE TYPE "DifficultyLevel" AS ENUM ('easy', 'medium', 'fancy');

-- CreateEnum
CREATE TYPE "WeeklyPacing" AS ENUM ('mostly_easy', 'mixed', 'one_fancy_night', 'minimal_effort');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('this_week', 'next_week', 'upcoming', 'past', 'draft');

-- CreateEnum
CREATE TYPE "GroceryListStatus" AS ENUM ('draft', 'active', 'ordered', 'archived');

-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('api', 'rpa', 'hybrid', 'affiliate');

-- CreateEnum
CREATE TYPE "StepPhase" AS ENUM ('prep', 'cook', 'rest', 'preheat', 'assemble', 'hold');

-- CreateEnum
CREATE TYPE "DishRole" AS ENUM ('main', 'side', 'sauce', 'topping', 'base', 'optional');

-- CreateEnum
CREATE TYPE "StoreSection" AS ENUM ('produce', 'meat_seafood', 'dairy_eggs', 'bakery_bread', 'pantry', 'canned', 'frozen', 'snacks', 'household', 'other');

-- CreateEnum
CREATE TYPE "RestockCadence" AS ENUM ('always_stocked', 'weekly', 'monthly', 'remind_when_low');

-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM ('login', 'view_plan', 'cook_meal', 'generate_grocery', 'order_groceries', 'wizard_start', 'wizard_complete', 'plan_created', 'plan_deleted', 'upgrade_started', 'upgrade_completed', 'trial_started', 'trial_expired');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "zipCode" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "accountStatus" "AccountStatus" NOT NULL DEFAULT 'active',
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "defaultHouseholdSize" INTEGER NOT NULL DEFAULT 2,
    "customerStartDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerEndDate" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "loginCountTotal" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "householdSize" INTEGER NOT NULL DEFAULT 2,
    "wantsLeftovers" BOOLEAN NOT NULL DEFAULT true,
    "difficultyDefault" "DifficultyLevel" NOT NULL DEFAULT 'easy',
    "weeklyPacingDefault" "WeeklyPacing" NOT NULL DEFAULT 'mostly_easy',
    "dietaryRestrictions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cuisinePreferences" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "breakfastDefaults" TEXT,
    "lunchDefaults" TEXT,
    "macroPref" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailMarketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "smsMarketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedRetailerId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pantry_staples" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ingredientName" TEXT NOT NULL,
    "restockCadence" "RestockCadence" NOT NULL DEFAULT 'always_stocked',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pantry_staples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredients" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "defaultUnit" TEXT NOT NULL,
    "nutritionRefPerUnit" JSONB,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isOptionalDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dishes" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceType" "SourceType" NOT NULL DEFAULT 'manual',
    "estimatedTimeMinutes" INTEGER NOT NULL DEFAULT 30,
    "difficulty" "DifficultyLevel" NOT NULL DEFAULT 'easy',
    "imageUrl" TEXT,
    "servingsDefault" INTEGER NOT NULL DEFAULT 4,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "caloriesPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "proteinGPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carbsGPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fatGPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "timesCooked" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dishes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dish_ingredients" (
    "id" TEXT NOT NULL,
    "dishId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "preparationNote" TEXT,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "positionIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "dish_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meals" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "mealType" "MealType" NOT NULL DEFAULT 'dinner',
    "sourceType" "SourceType" NOT NULL DEFAULT 'manual',
    "cuisineType" TEXT,
    "difficulty" "DifficultyLevel" NOT NULL DEFAULT 'easy',
    "estimatedTimeMinutes" INTEGER NOT NULL DEFAULT 30,
    "imageUrl" TEXT,
    "servingsDefault" INTEGER NOT NULL DEFAULT 4,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "caloriesPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "proteinGPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carbsGPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fatGPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "timesCooked" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "saveCount" INTEGER NOT NULL DEFAULT 0,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_dish_links" (
    "id" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "dishId" TEXT NOT NULL,
    "positionIndex" INTEGER NOT NULL DEFAULT 0,
    "roleLabel" "DishRole" NOT NULL DEFAULT 'main',

    CONSTRAINT "meal_dish_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_instruction_steps" (
    "id" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "stepTextRaw" TEXT NOT NULL,
    "stepTextTranslated" TEXT NOT NULL,
    "estimatedMinutes" INTEGER NOT NULL DEFAULT 1,
    "phaseType" "StepPhase" NOT NULL DEFAULT 'cook',
    "parallelGroup" TEXT,
    "requiresPreheat" BOOLEAN NOT NULL DEFAULT false,
    "requiresRest" BOOLEAN NOT NULL DEFAULT false,
    "requiresMarination" BOOLEAN NOT NULL DEFAULT false,
    "isTimingSensitive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "recipe_instruction_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_plan_templates" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceType" "SourceType" NOT NULL DEFAULT 'wizard',
    "isFeaturedSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "defaultDaysCount" INTEGER NOT NULL DEFAULT 5,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imageUrl" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "saveCount" INTEGER NOT NULL DEFAULT 0,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "deletedPlanCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meal_plan_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_plan_instances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mealPlanTemplateId" TEXT NOT NULL,
    "titleOverride" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "status" "PlanStatus" NOT NULL DEFAULT 'draft',
    "isActiveThisWeek" BOOLEAN NOT NULL DEFAULT false,
    "lastCooked" TIMESTAMP(3),
    "timesCooked" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "breakfastDefaults" TEXT,
    "lunchDefaults" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meal_plan_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_plan_items" (
    "id" TEXT NOT NULL,
    "mealPlanInstanceId" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "positionIndex" INTEGER NOT NULL DEFAULT 0,
    "assignedDayOfWeek" TEXT,
    "assignedDate" TIMESTAMP(3),
    "servingsOverride" INTEGER,
    "ingredientOverrides" JSONB,
    "isBreakfast" BOOLEAN NOT NULL DEFAULT false,
    "isLunch" BOOLEAN NOT NULL DEFAULT false,
    "isDinner" BOOLEAN NOT NULL DEFAULT true,
    "lastCooked" TIMESTAMP(3),
    "timesCooked" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "meal_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grocery_lists" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mealPlanInstanceId" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'plan',
    "status" "GroceryListStatus" NOT NULL DEFAULT 'draft',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grocery_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grocery_list_items" (
    "id" TEXT NOT NULL,
    "groceryListId" TEXT NOT NULL,
    "ingredientId" TEXT,
    "displayName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT '',
    "storeSection" "StoreSection" NOT NULL DEFAULT 'other',
    "isChecked" BOOLEAN NOT NULL DEFAULT false,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "wasAiInferred" BOOLEAN NOT NULL DEFAULT false,
    "isAmbiguous" BOOLEAN NOT NULL DEFAULT false,
    "sourceMealId" TEXT,
    "sourceDishId" TEXT,
    "notes" TEXT,

    CONSTRAINT "grocery_list_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retailers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "integrationType" "IntegrationType" NOT NULL DEFAULT 'api',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "logoUrl" TEXT,
    "supportsAuth" BOOLEAN NOT NULL DEFAULT true,
    "supportsCartAdd" BOOLEAN NOT NULL DEFAULT true,
    "supportsAvailabilityLookup" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "retailers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retailer_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "retailerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "authReference" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retailer_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "retailerId" TEXT NOT NULL,
    "groceryListId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultMessage" TEXT,
    "cartUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planCode" "SubscriptionPlan" NOT NULL DEFAULT 'free',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "stripeSubscriptionId" TEXT,
    "stripeCustomerId" TEXT,
    "promoCodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "discountType" TEXT NOT NULL,
    "discountValue" DOUBLE PRECISION NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "maxRedemptions" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prepRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cookRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "groceryRemindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "weeklyPlanningRemindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "preferredGroceryReminderDay" TEXT DEFAULT 'saturday',
    "preferredPrepReminderDay" TEXT DEFAULT 'sunday',
    "preferredTimeOfDay" TEXT DEFAULT '09:00',

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_activities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" "ActivityEventType" NOT NULL,
    "entityId" TEXT,
    "entityType" TEXT,
    "platform" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "pantry_staples_userId_ingredientName_key" ON "pantry_staples"("userId", "ingredientName");

-- CreateIndex
CREATE UNIQUE INDEX "ingredients_canonicalName_key" ON "ingredients"("canonicalName");

-- CreateIndex
CREATE UNIQUE INDEX "meal_dish_links_mealId_dishId_key" ON "meal_dish_links"("mealId", "dishId");

-- CreateIndex
CREATE INDEX "recipe_instruction_steps_ownerType_ownerId_idx" ON "recipe_instruction_steps"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "retailers_slug_key" ON "retailers"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "retailer_connections_userId_retailerId_key" ON "retailer_connections"("userId", "retailerId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripeSubscriptionId_key" ON "subscriptions"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_code_key" ON "promo_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_key" ON "notification_preferences"("userId");

-- CreateIndex
CREATE INDEX "user_activities_userId_createdAt_idx" ON "user_activities"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "user_activities_eventType_createdAt_idx" ON "user_activities"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_staples" ADD CONSTRAINT "pantry_staples_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dishes" ADD CONSTRAINT "dishes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dish_ingredients" ADD CONSTRAINT "dish_ingredients_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dish_ingredients" ADD CONSTRAINT "dish_ingredients_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meals" ADD CONSTRAINT "meals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_dish_links" ADD CONSTRAINT "meal_dish_links_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "meals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_dish_links" ADD CONSTRAINT "meal_dish_links_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_plan_templates" ADD CONSTRAINT "meal_plan_templates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_plan_instances" ADD CONSTRAINT "meal_plan_instances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_plan_instances" ADD CONSTRAINT "meal_plan_instances_mealPlanTemplateId_fkey" FOREIGN KEY ("mealPlanTemplateId") REFERENCES "meal_plan_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_plan_items" ADD CONSTRAINT "meal_plan_items_mealPlanInstanceId_fkey" FOREIGN KEY ("mealPlanInstanceId") REFERENCES "meal_plan_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_plan_items" ADD CONSTRAINT "meal_plan_items_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "meals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grocery_lists" ADD CONSTRAINT "grocery_lists_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grocery_lists" ADD CONSTRAINT "grocery_lists_mealPlanInstanceId_fkey" FOREIGN KEY ("mealPlanInstanceId") REFERENCES "meal_plan_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grocery_list_items" ADD CONSTRAINT "grocery_list_items_groceryListId_fkey" FOREIGN KEY ("groceryListId") REFERENCES "grocery_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grocery_list_items" ADD CONSTRAINT "grocery_list_items_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retailer_connections" ADD CONSTRAINT "retailer_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retailer_connections" ADD CONSTRAINT "retailer_connections_retailerId_fkey" FOREIGN KEY ("retailerId") REFERENCES "retailers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_retailerId_fkey" FOREIGN KEY ("retailerId") REFERENCES "retailers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_activities" ADD CONSTRAINT "user_activities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
