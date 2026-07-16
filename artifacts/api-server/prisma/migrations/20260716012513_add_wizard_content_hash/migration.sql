-- AlterTable
ALTER TABLE "meal_plan_instances" ADD COLUMN     "wizardContentHash" TEXT;

-- CreateIndex
CREATE INDEX "meal_plan_instances_userId_wizardContentHash_idx" ON "meal_plan_instances"("userId", "wizardContentHash");
