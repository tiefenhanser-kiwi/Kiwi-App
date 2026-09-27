-- Row 9 (1.1) "Stripe" · S1 — the columns the webhook mirror writes, and the
-- ledger that makes replaying an event free.
--
-- FOUR NULLABLE-OR-DEFAULTED COLUMNS AND ONE NEW TABLE. Nothing is altered,
-- nothing is backfilled, no existing column changes type or nullability, and
-- no enum changes:
--
--   · The two BOOLEANs are NOT NULL DEFAULT false, so every existing
--     `subscriptions` row gets a correct value without a backfill statement.
--     False is the honest value for both: no account has a Stripe subscription
--     yet, so none is cancelling at period end, and none took a pay-early bonus
--     that does not exist until this block ships.
--   · The two nullable columns have no correct value for an existing row and
--     NULL is exactly right — a trial account has no price id and has never
--     been mirrored from a Stripe event. The ABSENCE is the fact.
--   · `subscriptions.planCode` IS NOT TOUCHED. D-WS9-143 asked whether the
--     trial row should carry a plan; the answer this design gives is no — the
--     trial row stays `free`, `planCode` becomes premium_monthly /
--     premium_annual only once a Stripe subscription exists, and entitlement
--     never reads it. It reads `effectiveStatus`. Closing that decision needed
--     no migration, which is the evidence it was the right answer.
--   · ADDITIVE, so the live Cloud Run revision that has never heard of any of
--     this keeps working unchanged (D-WS9-254). That matters more here than
--     usual: this migration will be applied while the STORE FREEZE is on and
--     the running revision is the one the reviewers are looking at.
--
-- WHY `stripe_events` HAS STRIPE'S ID AS ITS PRIMARY KEY, and no userId, and no
-- foreign key:
--
--   Stripe guarantees AT-LEAST-ONCE delivery — it retries for up to three days
--   on any non-2xx and can redeliver an event it already got a 200 for. Making
--   its event id the PK puts the arbiter in the database instead of in
--   application logic: two concurrent deliveries of the same event cannot both
--   proceed, because the second INSERT raises a unique violation. The route
--   answers that 200 and ignores the event. Same shape as
--   `user_identities_provider_subject_key` guarding two simultaneous first
--   sign-ins.
--
--   No `userId` and no FK, deliberately: an event can arrive for a customer
--   whose Kiwi account has since been deleted, and the ledger must still record
--   that it was seen. A foreign key would either block that insert or lose the
--   row — the same reasoning that made `llm_call_logs.guestSessionId` a plain
--   string (Row 13 · Block 1), and the opposite of `user_identities`, which
--   cascades because it holds a credential with no meaning after the user.
--
--   There is no index besides the primary key. The only query is a PK lookup.
--
-- GENERATED READ-ONLY and hand-reviewed: `prisma migrate diff --from-url <the
-- dev url from .env> --to-schema-datamodel prisma/schema.prisma --script`. The
-- diff came back as exactly these two statements and nothing else, which also
-- confirms the dev branch carried no other drift from the schema at the time of
-- writing.
--
-- 🔴 NOT APPLIED on this box — Hans applies it. No `--shadow-database-url` was
-- passed to anything: that flag RESETS the database it is given, and it wiped
-- the Neon dev branch on September 18.

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "earlyPayBonusApplied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripePriceId" TEXT,
ADD COLUMN     "stripeUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);
