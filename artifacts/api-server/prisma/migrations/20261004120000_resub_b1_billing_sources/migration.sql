-- Resubmission B1 — a second entitlement source (Apple / Google through
-- RevenueCat) in the ONE billing mirror, and the pay-early bonus removed.
--
-- 🔴 HAND-EDITED. `prisma migrate diff` writes the two renames below as
-- DROP + ADD (`stripeUpdatedAt` → `sourceUpdatedAt`, `stripe_events` →
-- `billing_events`), which would throw away the out-of-order stamps and the
-- idempotency ledger on any database that has them — production, once Stripe
-- is live. Both are RENAMEs here, so every existing row survives, and the
-- ledger's existing rows are all Stripe's by construction (`provider` is
-- backfilled 'stripe' through a temporary default that is then dropped, so
-- the column ends exactly as the schema declares it: NOT NULL, no default).
--
-- `earlyPayBonusApplied` IS dropped, deliberately: the pay-early bonus is gone
-- on every platform (Hans, 2026-10-04 — "we can run pricing promos to trigger
-- early conversions"), and the column only ever measured it.
--
-- `source` is backfilled 'stripe' wherever a Stripe subscription id is already
-- mirrored. Every other row stays NULL, which means "no paid source yet" — a
-- trial, or an account that has never paid.
--
-- Checked against `prisma migrate diff --from-url <dev> --to-schema-datamodel`
-- after apply: no remaining difference. No `--shadow-database-url` anywhere —
-- that flag RESETS the database it is given (the Neon dev branch, 2026-09-18).

-- CreateEnum
CREATE TYPE "BillingSource" AS ENUM ('stripe', 'apple', 'google');

-- AlterTable: the rename keeps the stamps (Prisma's diff would drop them)
ALTER TABLE "subscriptions" RENAME COLUMN "stripeUpdatedAt" TO "sourceUpdatedAt";

-- AlterTable: the new columns, and the bonus measurement removed
ALTER TABLE "subscriptions" DROP COLUMN "earlyPayBonusApplied",
ADD COLUMN     "source" "BillingSource",
ADD COLUMN     "storeManagementUrl" TEXT,
ADD COLUMN     "storeOriginalTransactionId" TEXT,
ADD COLUMN     "storeProductId" TEXT;

-- Backfill: a mirrored Stripe subscription is a Stripe-sourced row
UPDATE "subscriptions" SET "source" = 'stripe' WHERE "stripeSubscriptionId" IS NOT NULL;

-- RenameTable: the ledger keeps its rows (Prisma's diff would drop the table)
ALTER TABLE "stripe_events" RENAME TO "billing_events";
ALTER TABLE "billing_events" RENAME CONSTRAINT "stripe_events_pkey" TO "billing_events_pkey";

-- The provider half of the key: every existing row is Stripe's
ALTER TABLE "billing_events" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE "billing_events" ALTER COLUMN "provider" DROP DEFAULT;

-- The key becomes (provider, id)
ALTER TABLE "billing_events" DROP CONSTRAINT "billing_events_pkey";
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_pkey" PRIMARY KEY ("provider", "id");
