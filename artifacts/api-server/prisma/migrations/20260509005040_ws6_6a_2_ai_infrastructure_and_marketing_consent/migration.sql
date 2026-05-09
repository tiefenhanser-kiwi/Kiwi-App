/*
  Warnings:

  - You are about to drop the column `emailMarketingConsent` on the `user_preferences` table. All the data in the column will be lost.
  - You are about to drop the column `smsMarketingConsent` on the `user_preferences` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "AIPromptMode" AS ENUM ('tool', 'text');

-- D-WS6-002: move marketing-consent fields from user_preferences to users.
-- Order: add new columns (with safe default) → copy data from old columns → drop old columns.

-- AlterTable: add new columns to users (default false matches old default).
ALTER TABLE "users" ADD COLUMN     "marketingConsentEmail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketingConsentSms" BOOLEAN NOT NULL DEFAULT false;

-- Data migration: copy existing consent values from user_preferences into users.
UPDATE "users"
SET "marketingConsentEmail" = up."emailMarketingConsent",
    "marketingConsentSms"   = up."smsMarketingConsent"
FROM "user_preferences" up
WHERE up."userId" = "users"."id";

-- AlterTable: drop old columns from user_preferences (data already copied above).
ALTER TABLE "user_preferences" DROP COLUMN "emailMarketingConsent",
DROP COLUMN "smsMarketingConsent";

-- CreateTable
CREATE TABLE "ai_prompts" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultModel" TEXT NOT NULL,
    "defaultMode" "AIPromptMode" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_prompt_versions" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT NOT NULL,
    "defaultValue" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "llm_call_logs" (
    "id" TEXT NOT NULL,
    "promptKey" TEXT NOT NULL,
    "promptVersion" INTEGER,
    "model" TEXT NOT NULL,
    "mode" "AIPromptMode" NOT NULL,
    "userId" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costEstimateUsd" DECIMAL(10,6) NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_prompts_key_key" ON "ai_prompts"("key");

-- CreateIndex
CREATE INDEX "ai_prompt_versions_promptId_isActive_idx" ON "ai_prompt_versions"("promptId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ai_prompt_versions_promptId_version_key" ON "ai_prompt_versions"("promptId", "version");

-- CreateIndex
CREATE INDEX "llm_call_logs_createdAt_idx" ON "llm_call_logs"("createdAt");

-- CreateIndex
CREATE INDEX "llm_call_logs_promptKey_createdAt_idx" ON "llm_call_logs"("promptKey", "createdAt");

-- CreateIndex
CREATE INDEX "llm_call_logs_userId_createdAt_idx" ON "llm_call_logs"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ai_prompt_versions" ADD CONSTRAINT "ai_prompt_versions_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "ai_prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_prompt_versions" ADD CONSTRAINT "ai_prompt_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
