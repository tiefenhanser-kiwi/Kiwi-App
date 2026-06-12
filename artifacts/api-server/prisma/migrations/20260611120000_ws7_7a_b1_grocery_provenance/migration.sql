-- WS7-7-A Block 1 — grocery-list provenance foundation.
-- Adds the isUserAdded ownership discriminator and a per-row plan-provenance
-- join table (GroceryListItemSource). Drops the dormant singular
-- sourceMealId/sourceDishId columns (never read or written; superseded by the
-- multi-source join table). isUserAdded @default(false) backfills existing
-- grocery_list_items as plan-derived.

-- AlterTable
ALTER TABLE "grocery_list_items" DROP COLUMN "sourceDishId",
DROP COLUMN "sourceMealId",
ADD COLUMN     "isUserAdded" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "grocery_list_item_sources" (
    "id" TEXT NOT NULL,
    "groceryListItemId" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "dishId" TEXT NOT NULL,

    CONSTRAINT "grocery_list_item_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grocery_list_item_sources_groceryListItemId_idx" ON "grocery_list_item_sources"("groceryListItemId");

-- CreateIndex
CREATE INDEX "grocery_list_item_sources_mealId_idx" ON "grocery_list_item_sources"("mealId");

-- AddForeignKey
ALTER TABLE "grocery_list_item_sources" ADD CONSTRAINT "grocery_list_item_sources_groceryListItemId_fkey" FOREIGN KEY ("groceryListItemId") REFERENCES "grocery_list_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
