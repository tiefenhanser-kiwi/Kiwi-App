-- AlterTable
ALTER TABLE "meal_plan_instances" ADD COLUMN     "committedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "dietaryUpdatedAt" TIMESTAMP(3);
