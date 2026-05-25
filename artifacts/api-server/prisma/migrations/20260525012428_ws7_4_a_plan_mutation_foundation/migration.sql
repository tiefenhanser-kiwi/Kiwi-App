-- CreateEnum
CREATE TYPE "PrepStatus" AS ENUM ('not_prepped', 'partial', 'prepped');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityEventType" ADD VALUE 'plan_review_opened';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_meal_assigned';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_meal_unassigned';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_meal_changed';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_recipe_changed';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_meal_edited';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_meal_composted';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_meal_added';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_breakfast_customized';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_lunch_customized';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_grocery_generated';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_prep_started';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_name_edited';

-- AlterTable: rename breakfastDefaults/lunchDefaults to breakfastOverrides/lunchOverrides
-- Hand-edited from Prisma's default DROP + ADD to preserve column shape per WS7-4-A plan.
ALTER TABLE "meal_plan_instances" RENAME COLUMN "breakfastDefaults" TO "breakfastOverrides";
ALTER TABLE "meal_plan_instances" RENAME COLUMN "lunchDefaults" TO "lunchOverrides";

-- AlterTable: new MealPlanInstance fields
ALTER TABLE "meal_plan_instances"
ADD COLUMN     "compostedAt" TIMESTAMP(3),
ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "optimizationNotes" JSONB,
ADD COLUMN     "prepStatus" "PrepStatus" NOT NULL DEFAULT 'not_prepped';

-- AlterTable
ALTER TABLE "meal_plan_templates" ADD COLUMN     "optimizationNotes" JSONB;
