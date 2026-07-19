-- Plan-Gen Arc · Block 3 (D-WS9-042) — structured allergen data on Meal.
-- Stamp-only for the store-fill harness; a hard retrieval filter is deferred.

-- AlterTable
ALTER TABLE "meals" ADD COLUMN     "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Plan-Gen Arc · Block 3 (D-WS9-042) — prompt-cache telemetry on LLMCallLog.
-- Nullable so existing rows stay valid and non-cached calls record nothing.

-- AlterTable
ALTER TABLE "llm_call_logs" ADD COLUMN     "cacheCreationInputTokens" INTEGER,
ADD COLUMN     "cacheReadInputTokens" INTEGER;
