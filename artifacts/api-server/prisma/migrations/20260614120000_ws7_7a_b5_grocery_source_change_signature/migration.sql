-- WS7-7-A Block 5 (D-WS7-137) — grocery source change-signature.
-- Adds a per-source change-signature to grocery_list_item_sources so reconcile
-- can detect an INTRA-meal edit (servings or ingredient add/remove/qty/unit/
-- name) on a meal that stays in the plan. Both columns are nullable: existing
-- rows backfill to NULL and re-resolve once on the first post-deploy reconcile
-- (NULL signature != freshly computed signature), then self-heal.

-- AlterTable
ALTER TABLE "grocery_list_item_sources" ADD COLUMN     "ingredientSignature" TEXT,
ADD COLUMN     "servings" INTEGER;
