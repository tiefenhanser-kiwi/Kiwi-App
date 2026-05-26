-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_used_from_template';

-- CreateTable
CREATE TABLE "meal_plan_template_items" (
    "id" TEXT NOT NULL,
    "mealPlanTemplateId" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "positionIndex" INTEGER NOT NULL DEFAULT 0,
    "assignedDayOfWeek" TEXT,
    "isBreakfast" BOOLEAN NOT NULL DEFAULT false,
    "isLunch" BOOLEAN NOT NULL DEFAULT false,
    "isDinner" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "meal_plan_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meal_plan_template_items_mealPlanTemplateId_idx" ON "meal_plan_template_items"("mealPlanTemplateId");

-- AddForeignKey
ALTER TABLE "meal_plan_template_items" ADD CONSTRAINT "meal_plan_template_items_mealPlanTemplateId_fkey" FOREIGN KEY ("mealPlanTemplateId") REFERENCES "meal_plan_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_plan_template_items" ADD CONSTRAINT "meal_plan_template_items_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "meals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
