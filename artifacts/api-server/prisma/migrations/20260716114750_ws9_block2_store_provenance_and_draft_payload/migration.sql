-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SourceType" ADD VALUE 'batch_generated';
ALTER TYPE "SourceType" ADD VALUE 'live_writeback';
ALTER TYPE "SourceType" ADD VALUE 'community';

-- AlterTable
ALTER TABLE "meal_plan_instances" ADD COLUMN     "wizardDraftPayload" JSONB;
