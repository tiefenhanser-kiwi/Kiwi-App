-- AlterTable
ALTER TABLE "meal_plan_instances" ADD COLUMN     "prepStatusIsManual" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "prep_step_completions" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prep_step_completions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prep_step_completions_planId_idx" ON "prep_step_completions"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "prep_step_completions_planId_stepKey_key" ON "prep_step_completions"("planId", "stepKey");

-- AddForeignKey
ALTER TABLE "prep_step_completions" ADD CONSTRAINT "prep_step_completions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "meal_plan_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
