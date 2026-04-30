/*
  Warnings:

  - You are about to drop the column `isFeaturedSnapshot` on the `meal_plan_templates` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "meal_plan_templates" DROP COLUMN "isFeaturedSnapshot",
ADD COLUMN     "featuredEndDate" TIMESTAMP(3),
ADD COLUMN     "featuredRank" INTEGER,
ADD COLUMN     "featuredStartDate" TIMESTAMP(3),
ADD COLUMN     "hostingFeaturedRank" INTEGER,
ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isHostingFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "occasionType" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastPlanDiscoveryFilters" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lastPlansFilters" TEXT[] DEFAULT ARRAY[]::TEXT[];
