-- DropForeignKey
ALTER TABLE "meal_plan_instances" DROP CONSTRAINT "meal_plan_instances_mealPlanTemplateId_fkey";

-- AddForeignKey
ALTER TABLE "meal_plan_instances" ADD CONSTRAINT "meal_plan_instances_mealPlanTemplateId_fkey" FOREIGN KEY ("mealPlanTemplateId") REFERENCES "meal_plan_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
