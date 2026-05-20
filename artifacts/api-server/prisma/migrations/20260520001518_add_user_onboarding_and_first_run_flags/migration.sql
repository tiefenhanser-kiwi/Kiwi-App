-- WS7-2 Block A — add User routing flags consumed by mobile post-login nav.
-- Backfill: existing rows are dev-test accounts already in use; mark both flags
-- TRUE so they bypass onboarding + first-run-destination on next login.
-- New signups land via the DEFAULT false (post-migration insert path).

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "firstRunChoiceMade" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onboardingComplete" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing rows.
UPDATE "users" SET "onboardingComplete" = TRUE, "firstRunChoiceMade" = TRUE;
