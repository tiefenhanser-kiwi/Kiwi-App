-- AlterTable
ALTER TABLE "llm_call_logs" ADD COLUMN     "guestSessionId" TEXT;

-- CreateTable
CREATE TABLE "guest_sessions" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipHash" TEXT,
    "preferences" JSONB NOT NULL,
    "candidates" JSONB,
    "draft" JSONB,
    "generationCount" INTEGER NOT NULL DEFAULT 0,
    "lastEvent" TEXT,
    "claimedByUserId" TEXT,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "guest_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_events" (
    "id" TEXT NOT NULL,
    "guestSessionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "step" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB,

    CONSTRAINT "guest_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_sessions_expiresAt_idx" ON "guest_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "guest_sessions_claimedByUserId_idx" ON "guest_sessions"("claimedByUserId");

-- CreateIndex
CREATE INDEX "guest_events_guestSessionId_at_idx" ON "guest_events"("guestSessionId", "at");

-- CreateIndex
CREATE INDEX "llm_call_logs_guestSessionId_createdAt_idx" ON "llm_call_logs"("guestSessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_claimedByUserId_fkey" FOREIGN KEY ("claimedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_events" ADD CONSTRAINT "guest_events_guestSessionId_fkey" FOREIGN KEY ("guestSessionId") REFERENCES "guest_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
