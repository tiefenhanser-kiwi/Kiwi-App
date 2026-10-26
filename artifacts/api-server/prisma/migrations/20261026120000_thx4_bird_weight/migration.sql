-- THX-4 (D-WS9-324) — the turkey's weight, set by the cook.
--
-- One nullable column, so every existing row reads exactly as before:
--   · meal_plan_items.birdWeightLb — the bird's weight in pounds (½-lb steps;
--     whole bird 8–20, spatchcock 8–16, enforced by the PATCH route). null =
--     the default bird: the recipe's weight, following the servings.
--
-- Generated with `prisma migrate diff --from-url <dev> --to-schema-datamodel`
-- (read-only). No `--shadow-database-url` anywhere — that flag RESETS the
-- database it is given (the Neon dev branch, 2026-09-18).

-- AlterTable
ALTER TABLE "meal_plan_items" ADD COLUMN     "birdWeightLb" DECIMAL(4,1);
