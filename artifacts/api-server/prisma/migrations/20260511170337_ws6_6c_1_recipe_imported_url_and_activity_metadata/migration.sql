-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE 'recipe_imported_url';

-- AlterTable
ALTER TABLE "user_activities" ADD COLUMN     "metadata" JSONB;
