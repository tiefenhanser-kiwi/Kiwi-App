-- WS9 D-WS9-189 Block A1 — the ingredient-relationship substrate.
-- Creates the table ONLY. No rows are authored by this migration; the authoring
-- pipeline (scripts/ws9-d189-a1-relations.ts) writes them under --apply, which
-- is a separate, explicitly-gated step.

-- CreateEnum
CREATE TYPE "IngredientRelationLabel" AS ENUM ('synonym', 'component', 'distinct');

-- CreateEnum
CREATE TYPE "IngredientRelationConfidence" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "IngredientRelationSource" AS ENUM ('ai_judge', 'human', 'seed');

-- CreateTable
CREATE TABLE "ingredient_relations" (
    "id" TEXT NOT NULL,
    "fromIngredientId" TEXT NOT NULL,
    "toIngredientId" TEXT NOT NULL,
    "label" "IngredientRelationLabel" NOT NULL,
    "yieldQuantity" DOUBLE PRECISION,
    "yieldUnit" TEXT,
    "coHarvestable" BOOLEAN,
    "source" "IngredientRelationSource" NOT NULL,
    "confidence" "IngredientRelationConfidence" NOT NULL,
    "judgeModel" TEXT,
    "promptVersion" TEXT,
    "rationale" TEXT,
    "familyKey" TEXT,
    "contradictionFlag" BOOLEAN NOT NULL DEFAULT false,
    "reviewedByHuman" BOOLEAN NOT NULL DEFAULT false,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingredient_relations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingredient_relations_fromIngredientId_idx" ON "ingredient_relations"("fromIngredientId");

-- CreateIndex
CREATE INDEX "ingredient_relations_toIngredientId_idx" ON "ingredient_relations"("toIngredientId");

-- CreateIndex
CREATE INDEX "ingredient_relations_label_idx" ON "ingredient_relations"("label");

-- CreateIndex
CREATE UNIQUE INDEX "ingredient_relations_fromIngredientId_toIngredientId_key" ON "ingredient_relations"("fromIngredientId", "toIngredientId");

-- AddForeignKey
ALTER TABLE "ingredient_relations" ADD CONSTRAINT "ingredient_relations_fromIngredientId_fkey" FOREIGN KEY ("fromIngredientId") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_relations" ADD CONSTRAINT "ingredient_relations_toIngredientId_fkey" FOREIGN KEY ("toIngredientId") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
