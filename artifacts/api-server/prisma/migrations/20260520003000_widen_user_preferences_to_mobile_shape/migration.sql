-- WS7-2 Block A — UserPreferences widening to mobile UserPreferencesData shape.
-- Per the Phase 1 locked decision (Option A): DB widens to match mobile,
-- mobile sends canonical lowercase values on wire (mobile-side display-string
-- refactor lands in Block B).
--
-- Changes:
--   1. SpiceTolerance: add 'very_hot' value.
--   2. BudgetLevel: rename 'budget' -> 'economy' (Postgres requires the
--      create-new-type + cast pattern; ADD/DROP VALUE is not supported).
--   3. Four column renames (data preserved).
--   4. Nine new columns aligned with mobile UserPreferencesData.
--
-- marketingConsentEmail / marketingConsentSms STAY on the User table per
-- D-WS6-002 (locked May 8, 2026). They are NOT migrated to UserPreferences.

-- 1. SpiceTolerance: append 'very_hot'.
ALTER TYPE "SpiceTolerance" ADD VALUE 'very_hot';

-- 2. BudgetLevel: rename 'budget' -> 'economy'. Existing rows with the old
--    value are remapped during the type cast; new rows accept 'economy' only.
ALTER TYPE "BudgetLevel" RENAME TO "BudgetLevel_old";
CREATE TYPE "BudgetLevel" AS ENUM ('economy', 'mid_range', 'premium');
ALTER TABLE "user_preferences"
  ALTER COLUMN "budgetLevel" DROP DEFAULT,
  ALTER COLUMN "budgetLevel" TYPE "BudgetLevel"
    USING (
      CASE "budgetLevel"::text
        WHEN 'budget' THEN 'economy'::"BudgetLevel"
        ELSE "budgetLevel"::text::"BudgetLevel"
      END
    ),
  ALTER COLUMN "budgetLevel" SET DEFAULT 'mid_range';
DROP TYPE "BudgetLevel_old";

-- 3. Column renames. RENAME preserves data, indexes, and NOT NULL constraints.
ALTER TABLE "user_preferences" RENAME COLUMN "dietaryRestrictions" TO "allergiesAndAvoidances";
ALTER TABLE "user_preferences" RENAME COLUMN "cuisinePreferences" TO "cuisines";
ALTER TABLE "user_preferences" RENAME COLUMN "equipment" TO "cookingEquipment";
ALTER TABLE "user_preferences" RENAME COLUMN "recurringItems" TO "recurringGroceryItems";

-- 4. New columns. NOT NULL DEFAULT for array/int fields; nullable for opt-in
--    text/enum-string fields (mobile Block B widens its types to allow null).
ALTER TABLE "user_preferences"
  ADD COLUMN "eatingStyles"      TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "cookingSkill"      TEXT,
  ADD COLUMN "stovetopType"      TEXT,
  ADD COLUMN "kidsCount"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pickyEaterCount"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "healthGoals"       TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "planLengthDefault" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN "defaultRetailer"   TEXT,
  ADD COLUMN "dietaryNotes"      TEXT;
