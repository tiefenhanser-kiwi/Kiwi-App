-- Row 13 "Test Kitchen" · Block 1b — two additive, nullable columns on users.
--
--   signupSource                (D-WS9-264) the entry point: "test_kitchen",
--                               "web", "ios", "android", or NULL.
--   personalizeNudgeDismissedAt (D-WS9-263) the Home personalize card's
--                               per-user, one-way gate. NULL = not dismissed.
--
-- HAND-WRITTEN, and NOT APPLIED on this box: it is under a store-review
-- freeze. No backfill by design — both columns record something that happens
-- at or after signup, so an existing row's NULL is the correct value, and the
-- ADDITIVE shape means the live client that knows neither column is unaffected
-- (D-WS9-254).
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "signupSource" TEXT;
ALTER TABLE "users" ADD COLUMN     "personalizeNudgeDismissedAt" TIMESTAMP(3);
