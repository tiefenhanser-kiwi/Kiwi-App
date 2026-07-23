-- Block 3.7 (D-WS9-066 / D-WS7-215) — swappable components: dual-path step tags,
-- component registry, and non-destructive per-plan / per-user selections.
-- All columns NULLABLE and additive: every existing row is BASE / unselected, so
-- the 1,125-meal catalog stays valid untouched. Nothing reads these yet.

-- AlterTable
ALTER TABLE "recipe_instruction_steps" ADD COLUMN     "componentKey" TEXT,
ADD COLUMN     "pathKey" TEXT;

-- AlterTable
ALTER TABLE "dish_ingredients" ADD COLUMN     "componentKey" TEXT,
ADD COLUMN     "pathKey" TEXT;

-- AlterTable
ALTER TABLE "dishes" ADD COLUMN     "componentRegistry" JSONB,
ADD COLUMN     "componentSelections" JSONB;

-- AlterTable
ALTER TABLE "meal_plan_items" ADD COLUMN     "componentSelections" JSONB;
