-- WS6 6a-3.5 — Wizard hidden context + ActivityEventType.wizard_failure +
-- weeklyPacing-enum drift reconciliation. Resolves D-WS6-011/012/013.
--
-- Notes on weeklyPacing drift (D-WS6-013): the Prisma enum has always had
-- `one_fancy_night` (canonical, per PRD §5.3 and the original schema bundle).
-- Drift lived in the server Zod schema + mobile types (`one_fancy`); both
-- are now updated in code. No data movement is required because no Postgres
-- column ever stored `one_fancy`.

-- 1. Add `wizard_failure` to ActivityEventType (D-WS6-012).
ALTER TYPE "ActivityEventType" ADD VALUE 'wizard_failure';

-- 2. New enums backing UserPreferences hidden-context fields (D-WS6-011).
CREATE TYPE "SpiceTolerance" AS ENUM ('mild', 'medium', 'hot');
CREATE TYPE "BudgetLevel" AS ENUM ('budget', 'mid_range', 'premium');

-- 3. Add hidden-context columns to user_preferences. Defaults match the
--    Prisma model so existing rows backfill cleanly. NOT NULL on the
--    enum/array columns, NULLABLE on dailyCalorieTarget (PRD: user may
--    not have set one).
ALTER TABLE "user_preferences"
  ADD COLUMN "equipment"          TEXT[]           NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "spiceTolerance"     "SpiceTolerance" NOT NULL DEFAULT 'medium',
  ADD COLUMN "dailyCalorieTarget" INTEGER,
  ADD COLUMN "budgetLevel"        "BudgetLevel"    NOT NULL DEFAULT 'mid_range',
  ADD COLUMN "pickyAvoidances"    TEXT[]           NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "recurringItems"     TEXT[]           NOT NULL DEFAULT ARRAY[]::TEXT[];
