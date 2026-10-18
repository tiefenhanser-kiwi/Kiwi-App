-- Row 9 (1.1) "Stripe" · S1 — THE CUTOVER. Run ONCE, immediately before
-- BILLING_ENFORCED is set to true, and not before.
--
-- ⚠️ 🔴 THIS FILE IS NOT RUN BY ANY CODE AND MUST NOT BE. It is Hans's, executed
-- by hand in the Neon console against production, in the sequence below. No
-- script imports it and no migration includes it.
--
-- ── WHY IT EXISTS ────────────────────────────────────────────────────────
--
-- Every account that exists today was created under "everyone is premium"
-- (D-WS9-258). Each one got `trialEndsAt = createdAt + 14 days` from
-- lib/authAccount.ts, and for most of them that timestamp passed months ago,
-- silently, while the app kept working — because `can()` was a stub that always
-- allowed.
--
-- The moment enforcement is switched on, `effectiveStatus()` derives `none` for
-- every one of those rows, and the entire existing user base is paywalled out of
-- the Wizard in the same second. Not as a decision — as an accident of a
-- timestamp nobody was ever shown.
--
-- D-WS9-310 (Hans) — every account that exists on the cutover day is free
-- THROUGH NOVEMBER 2: its trial ends at 2026-11-02 23:59:59 in New York. One
-- date for everyone, not "cutover + 14 days" (FIX-6, BUG-404, replaced the old
-- statement 1, which did that and touched only rows already lapsed).
--
-- ── THE SEQUENCE (kiwi_stripe_scope.md §8) ───────────────────────────────
--
--   1. 1.0 approved by both stores
--   2. production migrations applied (Block 1b, OAuth, S1)
--   3. deploy
--   4. Stripe live-mode commissioning (S3)
--   5. >>> THIS FILE <<<
--   6. BILLING_ENFORCED=true  (a Cloud Run env change — a new revision, no build)
--
-- Step 5 before step 6, always. Between them, nobody is enforced against
-- anything, so the order is safe; reversed, there is a window in which every
-- existing user is locked out.
--
-- ── THE DATE, AND WHY IT IS WRITTEN THIS WAY ─────────────────────────────
--
-- `subscriptions."trialEndsAt"` is `timestamp(3) WITHOUT time zone` holding
-- UTC (Prisma's DateTime default), NOT timestamptz. So the New York instant is
-- converted in two steps, both resolved by Postgres itself:
--
--   TIMESTAMP '2026-11-02 23:59:59' AT TIME ZONE 'America/New_York'
--       → the timestamptz 2026-11-03 04:59:59+00 (EST, UTC−5: DST ended Nov 1)
--   … AT TIME ZONE 'UTC'
--       → the plain timestamp 2026-11-03 04:59:59, which is what the column holds
--
-- Writing only the first step would store the right value only while the
-- session TimeZone is UTC/GMT (the cast back to a plain timestamp uses the
-- session's zone). The second step makes it the same in any session.
--
-- ── RUNNING IT TWICE ─────────────────────────────────────────────────────
--
-- Harmless. The date is fixed, and statement 1 only matches rows BEFORE it;
-- after one run none are left, so a second run changes nothing.
--
-- ── HOW TO RUN IT ────────────────────────────────────────────────────────
--
-- Paste the whole file. Read the dry run first: it is the same predicate as the
-- UPDATE and tells you how many rows you are about to touch; if that number
-- surprises you, stop.

-- ── 0. DRY RUN. Read this before running anything below it. ──────────────

SELECT
  count(*)                                    AS rows_to_set,
  min("trialEndsAt")                          AS earliest_trial_end,
  max("trialEndsAt")                          AS latest_trial_end
FROM subscriptions
WHERE status = 'trialing'
  AND source IS NULL
  AND "trialEndsAt" < ((TIMESTAMP '2026-11-02 23:59:59' AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC');

-- ── 1. THE CUTOVER. Every trial ends at 2026-11-02 23:59:59 New York. ────
--
-- `status = 'trialing'`, no paid `source`, and a trial end BEFORE the ruled
-- instant — lapsed or not. Rows NOT touched:
--
--   · a trial already ending LATER — the first signup's January 1 comp, and the
--     staff and reviewer exemptions (statement 2). Never shortened.
--   · a trialing row with NULL `trialEndsAt` — effectiveStatus() never lapses
--     it, so it is already free past November 2.
--   · any row with a `source` (stripe / apple / google) — a payment rail owns it.
--   · `active` / `past_due` — paying. `canceled` / `none` — before enforcement
--     only a deliberate act writes those. Leave them.

UPDATE subscriptions
SET "trialEndsAt" = ((TIMESTAMP '2026-11-02 23:59:59' AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'),
    "updatedAt"   = (now() AT TIME ZONE 'UTC')
WHERE status = 'trialing'
  AND source IS NULL
  AND "trialEndsAt" < ((TIMESTAMP '2026-11-02 23:59:59' AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC');

-- ── 2. STAFF AND REVIEWER ACCOUNTS — a far-future date, not a new enum. ──
--
-- 🔴 COMMENTED OUT ON PURPOSE, AND THE EMAIL LIST IS DELIBERATELY EMPTY. Hans
-- fills it in. A lane does not get to decide which accounts are exempt from
-- paying, and an exemption list with a guess in it is worse than no list.
--
-- Fill in the addresses, uncomment, and run it AFTER statement 1 (this one
-- overwrites what statement 1 wrote for these accounts, which is the intent).
--
-- Why a far-future `trialEndsAt` and not a `comped` status: adding an enum value
-- means a migration, a mapping in webhookMirror.ts, a branch in
-- ENTITLED_STATUSES, and a state the Stripe webhook could overwrite without
-- meaning to. A date in 2099 needs none of that and is visible in the same
-- column everyone else uses. It costs one row of weirdness instead of a schema.
--
-- ⚠️ Add `reviewer@kitchenwizard.ai` while the stores are still reviewing, and
-- REMOVE the exemption once 1.1 is approved — a reviewer account with a
-- 73-year trial is a reviewer account that never sees the paywall it is meant
-- to be reviewing.
--
-- UPDATE subscriptions
-- SET "trialEndsAt" = '2099-01-01 00:00:00+00'::timestamptz,
--     "updatedAt"   = now()
-- WHERE "userId" IN (
--   SELECT id FROM users WHERE email IN (
--     -- '',   <- Hans's own address
--     -- '',   <- reviewer@kitchenwizard.ai, while under review
--     ''
--   )
-- );

-- ── 3. VERIFY. Nothing unpaid should end before the ruled instant. ───────

SELECT
  status,
  (source IS NOT NULL)                AS paid_source,
  count(*)                            AS rows,
  count(*) FILTER (WHERE "trialEndsAt" < ((TIMESTAMP '2026-11-02 23:59:59' AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'))
                                      AS ends_before_nov_2,
  count(*) FILTER (WHERE "trialEndsAt" = ((TIMESTAMP '2026-11-02 23:59:59' AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'))
                                      AS ends_nov_2,
  count(*) FILTER (WHERE "trialEndsAt" > ((TIMESTAMP '2026-11-02 23:59:59' AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'))
                                      AS ends_later
FROM subscriptions
GROUP BY status, (source IS NOT NULL)
ORDER BY status, paid_source;

-- `ends_before_nov_2` must be 0 on the `trialing` row with paid_source false.
-- Any other number means statement 1 did not run, or a signup arrived between
-- the two (it gets its own 14 days from lib/authAccount.ts; a signup on the
-- cutover day itself can end a few hours short of the ruled instant — re-run
-- statement 1 to bring it in line).
