-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastMealsFilters" TEXT[] DEFAULT ARRAY[]::TEXT[];
