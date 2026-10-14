-- THX-2S (D-WS9-311) — what the Thanksgiving plans need from the server.
--
-- Three columns, all nullable or defaulted, so every existing row reads exactly
-- as before:
--   · meal_plan_template_items.servingsOverride — copied onto the adopted
--     MealPlanItem.servingsOverride (the feast at 10, or 4 for Small); null
--     follows the household size, as every template item does today;
--   · meal_plan_templates.anchorDate — the Thursday a dated template is built
--     around; null = an ordinary template;
--   · dish_ingredients.fromLeftovers — Friday's leftover turkey / cranberry /
--     stuffing lines, which grocery generation skips.
--
-- Generated with `prisma migrate diff --from-url <dev> --to-schema-datamodel`
-- (read-only). No `--shadow-database-url` anywhere — that flag RESETS the
-- database it is given (the Neon dev branch, 2026-09-18).

-- AlterTable
ALTER TABLE "dish_ingredients" ADD COLUMN     "fromLeftovers" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "meal_plan_template_items" ADD COLUMN     "servingsOverride" INTEGER;

-- AlterTable
ALTER TABLE "meal_plan_templates" ADD COLUMN     "anchorDate" DATE;
