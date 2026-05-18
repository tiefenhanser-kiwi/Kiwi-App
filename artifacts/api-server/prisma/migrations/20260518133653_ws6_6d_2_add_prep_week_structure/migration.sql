-- CreateTable
CREATE TABLE "prep_week_structures" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "structureJson" JSONB NOT NULL,
    "lastGeneratedFromPlanRevisionId" INTEGER NOT NULL,
    "lastGeneratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promptVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prep_week_structures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prep_week_structures_planId_key" ON "prep_week_structures"("planId");

-- AddForeignKey
ALTER TABLE "prep_week_structures" ADD CONSTRAINT "prep_week_structures_planId_fkey" FOREIGN KEY ("planId") REFERENCES "meal_plan_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
