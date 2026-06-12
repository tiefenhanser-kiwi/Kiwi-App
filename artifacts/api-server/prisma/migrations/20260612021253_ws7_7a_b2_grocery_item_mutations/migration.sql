-- AlterEnum
ALTER TYPE "GroceryListStatus" ADD VALUE 'completed';

-- AlterTable
ALTER TABLE "grocery_list_items" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "stapleOptedIn" BOOLEAN NOT NULL DEFAULT false;
