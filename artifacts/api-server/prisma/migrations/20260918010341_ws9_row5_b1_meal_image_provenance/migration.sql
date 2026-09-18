-- CreateEnum
CREATE TYPE "MealImageSource" AS ENUM ('page_extracted', 'stock_pexels', 'stock_pixabay', 'ai_generated', 'none');

-- AlterEnum
ALTER TYPE "AIPromptMode" ADD VALUE 'image';

-- AlterTable
ALTER TABLE "meals" ADD COLUMN     "imageAttribution" TEXT,
ADD COLUMN     "imageGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "imageSource" "MealImageSource",
ADD COLUMN     "imageSourceUrl" TEXT;
