-- WS7-6 (E) Block 1 — "This Week" computed from date range.
--
-- Drops the stored MealPlanInstance.isActiveThisWeek flag in favor of a
-- date-range predicate: a plan is "this week" iff
--   now ∈ [startDate, endDate]
-- evaluated against the row's nullable DateTime columns. This is the only
-- change that lets a future-dated plan auto-roll into the current-week
-- surface purely as time passes (D-WS7-062): a stored boolean would
-- require a scheduler to flip — there isn't one.
--
-- Companion structural changes:
--   1) Postgres btree_gist extension so the EXCLUDE constraint can mix
--      `userId =` with `tsrange &&` in one GIST index.
--   2) Per-user no-overlap EXCLUDE constraint on the date range
--      (Hans-locked decision #3). Null-dated plans (use-template /
--      wizard-draft / undated save) are EXEMPT via the WHERE clause —
--      they cannot overlap anything and don't auto-roll. Inclusive
--      `[]` bounds line up with the YYYY-MM-DD UTC-midnight storage
--      shape (toYmd in lib/planQueries.ts): a Sun-Sat range ending at
--      Sat 00:00 UTC and the next Sun-Sat starting at next-Sun 00:00 UTC
--      are 24h apart, so adjacent weeks do not conflict.
--   3) Supporting btree index on (userId, startDate, endDate) so the
--      converted reader filters in R1 (GET /plans active summary) and
--      R6 (GET /home active plan) stay covered.
--
-- Hand-written (Prisma does not model EXCLUDE constraints). Index name
-- mirrors the Prisma `_idx` naming convention so a later `prisma format`
-- doesn't churn.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DROP INDEX IF EXISTS "meal_plan_instances_userId_isActiveThisWeek_idx";

ALTER TABLE "meal_plan_instances"
  DROP COLUMN "isActiveThisWeek";

CREATE INDEX "meal_plan_instances_userId_startDate_endDate_idx"
  ON "meal_plan_instances" ("userId", "startDate", "endDate");

ALTER TABLE "meal_plan_instances"
  ADD CONSTRAINT "meal_plan_instances_no_overlap_per_user"
  EXCLUDE USING gist (
    "userId" WITH =,
    tsrange("startDate", "endDate", '[]') WITH &&
  )
  WHERE ("startDate" IS NOT NULL AND "endDate" IS NOT NULL);
