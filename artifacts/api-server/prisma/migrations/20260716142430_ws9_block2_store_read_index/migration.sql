-- CreateIndex
CREATE INDEX "meals_isPublic_isArchived_mealType_cuisineType_idx" ON "meals"("isPublic", "isArchived", "mealType", "cuisineType");
