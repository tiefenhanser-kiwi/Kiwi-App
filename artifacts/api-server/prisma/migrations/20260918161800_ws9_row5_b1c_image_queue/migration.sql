-- Row 5 · Block 1c (D-WS9-248 / D-WS9-246) — the on-save image queue's state
-- on the meal row, the strike counter, the stock/publisher residue dropped,
-- and a backfill of the rows that exist at the time this runs.

-- CreateEnum
CREATE TYPE "MealImageStatus" AS ENUM ('pending', 'generating', 'ready', 'failed');

-- AlterEnum — D-WS9-246: the stock + publisher steps are deleted with their
-- code, so their enum values go too. Every row held 'ai_generated' or NULL
-- when this was written; the USING cast would fail loudly on any other value.
BEGIN;
CREATE TYPE "MealImageSource_new" AS ENUM ('ai_generated', 'none');
ALTER TABLE "meals" ALTER COLUMN "imageSource" TYPE "MealImageSource_new" USING ("imageSource"::text::"MealImageSource_new");
ALTER TYPE "MealImageSource" RENAME TO "MealImageSource_old";
ALTER TYPE "MealImageSource_new" RENAME TO "MealImageSource";
DROP TYPE "public"."MealImageSource_old";
COMMIT;

-- AlterTable — imageAttribution / imageSourceUrl: 0 rows carried a value
-- (measured 2026-09-18 before the drop); nothing populated them.
ALTER TABLE "meals" DROP COLUMN "imageAttribution",
DROP COLUMN "imageSourceUrl",
ADD COLUMN     "imageAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "imageStatus" "MealImageStatus" NOT NULL DEFAULT 'pending';

-- Backfill. Three statements so the RULE is in the migration, not today's
-- counts (1,561 / 282 / 0 when it ran on the dev database):
--   1. a row that has an image is `ready` — every catalog meal and every
--      fork as of Block 1b;
--   2. a USER-AUTHORED row without one is `failed`, NOT `pending` —
--      D-WS9-230: Hans's own test residue is never backfilled, and the queue
--      must not spend its 5/min cap (56 minutes, ~$2.45) on scratch data the
--      moment the drain starts. `failed` renders the gradient permanently,
--      which is exactly what those rows show today;
--   3. a SHARED-POOL row without one (userId NULL) stays `pending` — the
--      catalog is shared data and is owed an image (0 rows today; explicit so
--      the rule reads complete).
UPDATE "meals" SET "imageStatus" = 'ready'   WHERE "imageUrl" IS NOT NULL;
UPDATE "meals" SET "imageStatus" = 'failed'  WHERE "imageUrl" IS NULL AND "userId" IS NOT NULL;
UPDATE "meals" SET "imageStatus" = 'pending' WHERE "imageUrl" IS NULL AND "userId" IS NULL;

-- CreateIndex — the drain's claim: `pending` rows FIFO by createdAt.
CREATE INDEX "meals_imageStatus_createdAt_idx" ON "meals"("imageStatus", "createdAt");
