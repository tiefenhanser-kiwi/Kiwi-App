-- FIX-8 (D-WS9-317) — proof of California auto-renewal consent at web checkout.
--
-- ADDITIVE ONLY. One new table; nothing existing is altered. A live revision
-- that does not know it is unaffected (D-WS9-254). No backfill: earlier
-- checkouts showed no consent checkbox (forward-only, D-WS9-230).
--
-- Generated with `prisma migrate diff --from-schema-datamodel <HEAD schema>
-- --to-schema-datamodel prisma/schema.prisma --script` — schema to schema, no
-- database and no `--shadow-database-url` (that flag RESETS the database it is
-- given; the Neon dev branch, 2026-09-18).

-- CreateTable
CREATE TABLE "billing_consents" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "stripeCustomerId" TEXT,
    "stripeSessionId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT,
    "priceId" TEXT NOT NULL,
    "unitAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "intervalCount" INTEGER NOT NULL,
    "consentText" TEXT NOT NULL,
    "consentTextVersion" TEXT NOT NULL,
    "termsOfService" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_consents_stripeSessionId_key" ON "billing_consents"("stripeSessionId");

-- CreateIndex
CREATE INDEX "billing_consents_userId_idx" ON "billing_consents"("userId");

-- AddForeignKey
ALTER TABLE "billing_consents" ADD CONSTRAINT "billing_consents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
