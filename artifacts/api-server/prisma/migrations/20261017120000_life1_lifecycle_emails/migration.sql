-- LIFE-1 — welcome and lifecycle emails: the per-user opt-out and the send log.
--
-- ADDITIVE ONLY. One nullable column on users (no default, no backfill: every
-- existing account starts opted in, which is what IS NULL means) and one new
-- table. A live revision that does not know either is unaffected (D-WS9-254).
--
-- Written by hand and checked against `prisma migrate diff --from-url <dev>
-- --to-schema-datamodel` after apply. No `--shadow-database-url` anywhere --
-- that flag RESETS the database it is given (the Neon dev branch, 2026-09-18).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "lifecycleEmailOptOutAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "lifecycle_email_sends" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,

    CONSTRAINT "lifecycle_email_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lifecycle_email_sends_userId_kind_key" ON "lifecycle_email_sends"("userId", "kind");

-- AddForeignKey
ALTER TABLE "lifecycle_email_sends" ADD CONSTRAINT "lifecycle_email_sends_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
