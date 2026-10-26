-- LIFE-2 — the eight event-driven lifecycle emails.
--
--   · ActivityEventType.cook_finished — POST /me/activity/cook-finished writes it
--     when Cook Mode is left after its last step. Its first row anchors the
--     "How did it go?" email.
--   · lifecycle_email_sends.refId — what a per-occurrence kind is about: the
--     plan's id for next_week (one email per plan), '' for every other kind.
--     The unique key becomes (userId, kind, refId).
--
-- ADDITIVE FOR THE LIVE REVISION (D-WS9-254). LIFE-1's code never writes refId,
-- so its claims land as '' and (userId, kind, '') is exactly its old key: once
-- per kind still holds. Every existing row reads refId = ''. NOT NULL with a
-- default rather than nullable on purpose: NULLs are distinct in a Postgres
-- unique index, and a NULL refId would let one kind be claimed twice.
--
-- ORDER: the new unique index is built BEFORE the old one is dropped, so the
-- table is never without a once-only key while a tick is running.
--
-- Generated with `prisma migrate diff --from-url <dev> --to-schema-datamodel`
-- (read-only), then reordered by hand as above. No `--shadow-database-url`
-- anywhere — that flag RESETS the database it is given (the Neon dev branch,
-- 2026-09-18).

-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE 'cook_finished';

-- AlterTable
ALTER TABLE "lifecycle_email_sends" ADD COLUMN     "refId" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "lifecycle_email_sends_userId_kind_refId_key" ON "lifecycle_email_sends"("userId", "kind", "refId");

-- DropIndex
DROP INDEX "lifecycle_email_sends_userId_kind_key";
