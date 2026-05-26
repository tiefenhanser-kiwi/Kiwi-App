-- AlterEnum (rename)
ALTER TYPE "ActivityEventType" RENAME VALUE 'plan_used_from_template' TO 'plan_used_from_browse';

-- AlterEnum (add new values; plan_created already exists at schema.prisma:141 — reuse)
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_preview_opened';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_composted';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_date_range_edited';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_status_changed';
ALTER TYPE "ActivityEventType" ADD VALUE 'plan_activated_this_week';

-- AlterTable (mealPlanTemplateId nullable, Q-P1-1 ruling)
ALTER TABLE "meal_plan_instances" ALTER COLUMN "mealPlanTemplateId" DROP NOT NULL;
