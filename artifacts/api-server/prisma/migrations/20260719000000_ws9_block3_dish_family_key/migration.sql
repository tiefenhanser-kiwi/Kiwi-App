-- Plan-Gen Arc · Block 3 (D-WS9-045) — catalog dish-family key on Meal.
-- Dedup keys on the target dish (not the generated title) → fixes the 1C
-- near-duplicate defect and gives dishFamily its mutual-exclusion key.

-- AlterTable
ALTER TABLE "meals" ADD COLUMN     "dishFamilyKey" TEXT;

-- CreateIndex
CREATE INDEX "meals_sourceType_dishFamilyKey_idx" ON "meals"("sourceType", "dishFamilyKey");
