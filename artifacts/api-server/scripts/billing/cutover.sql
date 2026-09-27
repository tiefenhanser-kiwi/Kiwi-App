-- Row 9 (1.1) "Stripe" · S1 — THE CUTOVER. Run ONCE, immediately before
-- BILLING_ENFORCED is set to true, and not before.
--
-- ⚠️ 🔴 THIS FILE IS NOT RUN BY ANY CODE AND MUST NOT BE. It is Hans's, executed
-- by hand in the Neon console against production, in the sequence below. No
-- script imports it, no migration includes it, and it is deliberately not
-- idempotent in a useful way — see "RUNNING IT TWICE".
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
-- So: a fresh 14 days from the day the paywall appears. It is the honest version
-- (a trial the user can actually see and use), and it doubles as the launch's
-- first conversion window.
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
-- ── RUNNING IT TWICE ─────────────────────────────────────────────────────
--
-- Statement 1's WHERE clause makes a second run with the SAME `:cutover`
-- harmless: after the first run no trialing row has `trialEndsAt < :cutover` any
-- more, so it matches nothing. But a second run with a LATER `:cutover` would
-- extend everyone again. Run it once, with one value, and write the value down.
--
-- ── HOW TO RUN IT ────────────────────────────────────────────────────────
--
-- `:cutover` is a placeholder, not Postgres syntax. In the Neon SQL editor,
-- replace it by hand with one timestamptz literal — the SAME literal in both
-- places — e.g.:
--
--   '2026-10-15 00:00:00+00'::timestamptz
--
-- Read the SELECT first. It is the same predicate as the UPDATE and it tells you
-- how many rows you are about to touch; if that number surprises you, stop.

-- ── 0. DRY RUN. Read this before running anything below it. ──────────────

SELECT
  count(*)                                    AS rows_to_extend,
  min("trialEndsAt")                          AS oldest_expired_trial,
  max("trialEndsAt")                          AS newest_expired_trial
FROM subscriptions
WHERE status = 'trialing'
  AND "trialEndsAt" < :cutover;

-- ── 1. THE CUTOVER. Every lapsed trial gets a fresh 14 days. ─────────────
--
-- `status = 'trialing'` AND an expired timestamp is exactly the set that
-- effectiveStatus() would derive `none` for. Rows already stored as `none`,
-- `canceled`, `active` or `past_due` are NOT touched:
--
--   · `active` / `past_due` — paying. Handing them a trial would be absurd.
--   · `canceled` / `none` — these can only exist if something already wrote
--     them, which before enforcement means a deliberate act. Leave them.
--   · `trialing` with a FUTURE trialEndsAt — a genuinely live trial. Extending it
--     would be a gift nobody asked for and would muddy the conversion read.

UPDATE subscriptions
SET "trialEndsAt" = :cutover + interval '14 days',
    "updatedAt"   = now()
WHERE status = 'trialing'
  AND "trialEndsAt" < :cutover;

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

-- ── 3. VERIFY. Nothing should be left in the lapsed set. ─────────────────

SELECT
  status,
  count(*)                            AS rows,
  count(*) FILTER (WHERE "trialEndsAt" < :cutover) AS still_lapsed
FROM subscriptions
GROUP BY status
ORDER BY status;

-- `still_lapsed` must be 0 for `trialing`. Any other number means statement 1
-- did not run, ran with a different `:cutover`, or new signups arrived between
-- the two — the last of which is fine and self-correcting (a signup after the
-- cutover gets its own 14 days from lib/authAccount.ts).
