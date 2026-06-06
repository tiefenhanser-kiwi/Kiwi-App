-- WS7-6 (E) Block 1 REWORK — Model 2: "This Week" = covering subset,
-- newest activatedAt wins. Replaces the SUPERSEDED migration
-- 20260605120000_ws7_6e_this_week_computed (deleted folder), whose
-- non-atomic failed apply already dropped isActiveThisWeek and may have
-- created the date index and/or the btree_gist extension. This migration
-- is IDEMPOTENT so it reconciles cleanly regardless of which of those
-- partial steps stuck.
--
-- No EXCLUDE constraint: plans may freely share date ranges; single-
-- current is enforced at READ time by resolveThisWeekPlan in
-- lib/planDates.ts. btree_gist, if it was created by the partial run,
-- is harmless to leave installed -- we do not drop it (Phase 0 ruling).
--
-- Hand-written (Prisma does not emit IF EXISTS / IF NOT EXISTS clauses).
-- Index name matches Prisma's default for @@index([userId,startDate,endDate])
-- on @@map("meal_plan_instances"): <table>_<f1>_<f2>_..._idx.

ALTER TABLE "meal_plan_instances"
  DROP COLUMN IF EXISTS "isActiveThisWeek";

CREATE INDEX IF NOT EXISTS "meal_plan_instances_userId_startDate_endDate_idx"
  ON "meal_plan_instances" ("userId", "startDate", "endDate");

ALTER TABLE "meal_plan_instances"
  ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);
