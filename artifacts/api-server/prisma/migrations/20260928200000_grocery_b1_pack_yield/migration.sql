-- [grocery] B1 — the per-ingredient PACK YIELD (D-WS9-280 / D-WS9-225).
--
-- FOUR ADDITIVE COLUMNS ON `ingredients`. Nothing is altered, nothing is
-- backfilled by this file, no existing column changes type or nullability, and
-- no enum changes. The data lands afterwards through the A1 reviewed round trip
-- (scripts/grocery-b1/apply.ts), which is what carries the provenance.
--
--   · packYieldUnit / packYieldPerPack — how much of a MEASURED need ONE PACK
--     yields. The PACK NOUN is not repeated: it is the existing
--     `ingredients.purchaseUnit`. NULL on every existing row and NULL is the
--     honest value — the absence means "fall back to one whole pack per need",
--     which over-orders and never under-orders (D-WS9-182).
--   · packYieldSource — 'Hans Sept 7' | 'Hans Sept 28' | 'D-WS9-182' |
--     'D-WS9-220' | 'CSV(usable)' | 'relation-edge' | 'web' | 'derived'.
--     Enforced at the application layer, exactly as `ownerType` and `pathKey`
--     are: a text column keeps a later source name from needing a migration.
--   · packYieldReviewedByHuman — NOT NULL DEFAULT false, so every existing row
--     gets a correct value with no backfill statement. False is honest: nobody
--     has reviewed a yield that does not exist.
--
-- ⚠️ NOT ADDED TO `ingredients.conversionRef`. That JSON has three live
-- rewriters (two backfills plus the runtime gap-fill), so a yield stored there
-- would inherit all three as a corruption vector (D-WS9-189).
--
-- ⚠️ NO INDEX. The only reader loads the ingredient row it already has by id or
-- canonicalName, both already indexed; the only scan is the review script's one
-- findMany over 1,780 rows.

ALTER TABLE "ingredients" ADD COLUMN "packYieldUnit" TEXT;
ALTER TABLE "ingredients" ADD COLUMN "packYieldPerPack" DOUBLE PRECISION;
ALTER TABLE "ingredients" ADD COLUMN "packYieldSource" TEXT;
ALTER TABLE "ingredients" ADD COLUMN "packYieldReviewedByHuman" BOOLEAN NOT NULL DEFAULT false;
