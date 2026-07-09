-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "discoveryMealsPerWeek" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "maxCookTimeCoverage" TEXT NOT NULL DEFAULT 'most',
ADD COLUMN     "maxCookTimeMinutes" INTEGER,
ADD COLUMN     "saucePreference" TEXT NOT NULL DEFAULT 'balanced';
