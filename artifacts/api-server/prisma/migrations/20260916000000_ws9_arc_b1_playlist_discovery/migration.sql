-- WS9 Redesign Arc Block 1 (D-WS9-245 / D-WS9-234) — discovery dial + playlist.
--
-- The discoveryMealsPerWeek Int 0..2 becomes the DiscoveryLevel enum. Ordered
-- ADD → UPDATE → DROP so no row's stored value is lost: the new column is added
-- with its default, the legacy integer is mapped onto it (0→none, 1→some,
-- 2→mostly, anything else → none), and only then is the old column dropped.

-- CreateEnum
CREATE TYPE "DiscoveryLevel" AS ENUM ('none', 'some', 'mostly', 'all');

-- AlterTable (1/3): add the new column with its default
ALTER TABLE "user_preferences"
ADD COLUMN     "discoveryLevel" "DiscoveryLevel" NOT NULL DEFAULT 'none';

-- AlterTable (2/3): map the legacy integer onto the level
UPDATE "user_preferences"
SET "discoveryLevel" = CASE "discoveryMealsPerWeek"
    WHEN 0 THEN 'none'::"DiscoveryLevel"
    WHEN 1 THEN 'some'::"DiscoveryLevel"
    WHEN 2 THEN 'mostly'::"DiscoveryLevel"
    ELSE 'none'::"DiscoveryLevel"
END;

-- AlterTable (3/3): drop the legacy column
ALTER TABLE "user_preferences" DROP COLUMN "discoveryMealsPerWeek";

-- CreateTable
CREATE TABLE "playlist_meals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_meals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "playlist_meals_userId_idx" ON "playlist_meals"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "playlist_meals_userId_mealId_key" ON "playlist_meals"("userId", "mealId");

-- AddForeignKey
ALTER TABLE "playlist_meals" ADD CONSTRAINT "playlist_meals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_meals" ADD CONSTRAINT "playlist_meals_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "meals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
