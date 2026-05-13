-- WS6 6c-4 Block A — Schema for AI grocery list generation.
-- Adds source-tracked staple flags, AI-ambiguity tracking, plan-revision-id
-- (drift detection vs. GroceryList), and purchase-pack metadata for
-- consolidation. No AI calls in Block A; Block B fills purchase-pack fields.

-- 1. StoreSection: rename `other` -> `extras` (PRD §12.4 wording).
-- ALTER TYPE ... RENAME VALUE renames in place: existing rows automatically
-- reference the new name and column DEFAULTs follow the rename. The safety
-- UPDATE in the original spec is therefore a no-op (and would fail post-rename
-- since 'other' would no longer exist on the enum).
ALTER TYPE "StoreSection" RENAME VALUE 'other' TO 'extras';

-- 2. GroceryListItem: source-tracked staple flags + AI-surfaced ambiguity.
ALTER TABLE "grocery_list_items" ADD COLUMN "isUniversalStaple" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "grocery_list_items" ADD COLUMN "isUserPantryStaple" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "grocery_list_items" ADD COLUMN "ambiguityOptions" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "grocery_list_items" ADD COLUMN "userResolvedTo" TEXT;

-- 3. GroceryList: drift-detection fields against MealPlanInstance.revisionId.
ALTER TABLE "grocery_lists" ADD COLUMN "lastGeneratedFromPlanRevisionId" INTEGER;
ALTER TABLE "grocery_lists" ADD COLUMN "lastGeneratedAt" TIMESTAMP(3);

-- 4. MealPlanInstance: monotonically-increasing revision id.
-- DEFAULT 1 backfills existing rows.
ALTER TABLE "meal_plan_instances" ADD COLUMN "revisionId" INTEGER NOT NULL DEFAULT 1;

-- 5. Ingredient: purchase-pack metadata. Filled by Block B AI reconciliation;
-- nullable until then so existing rows remain valid.
ALTER TABLE "ingredients" ADD COLUMN "purchaseUnit" TEXT;
ALTER TABLE "ingredients" ADD COLUMN "purchaseQuantity" DOUBLE PRECISION;
ALTER TABLE "ingredients" ADD COLUMN "purchaseDisplay" TEXT;
