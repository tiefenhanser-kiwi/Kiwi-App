-- Row 9 (1.1) "Stripe" · S1 — WHAT EACH AI FEATURE ACTUALLY COSTS, per promptKey.
--
-- ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
--
-- Hans asked whether some "fraction of a cent" AI calls could stay free for an
-- account past its trial, so the app still functions. The ruling was no — "No Pay
-- / No Trial = No AI" (D-WS9-270 §4a) — but it came with a condition: make the
-- question answerable with numbers next time instead of instinct. This is that
-- number, and lib/subscriptionService.ts's ENTITLEMENTS table is the one-word
-- change that acts on it.
--
-- So the pairing is deliberate: this query names the cheap calls WITH their
-- measured price, and the matrix makes any of them free in one line, with no
-- store review and no client change.
--
-- ── HOW TO RUN IT ────────────────────────────────────────────────────────
--
-- READ-ONLY. Safe against production, and that is where the useful answer is —
-- run it in the Neon console against the production branch. Against a dev branch
-- it returns whatever a handful of local test runs happen to have left behind,
-- which is not a price.
--
-- ⚠️ TWO THINGS THAT WOULD MAKE THE ANSWER WRONG, both handled below:
--
--   · `success = false` rows. A refused or failed call still writes a row with
--     whatever tokens it burned, and averaging those in prices a feature that did
--     not happen. Filtered out.
--   · MEMBER AND GUEST ROWS ARE DIFFERENT THINGS. Row 13's Test Kitchen is
--     catalog-only and its calls are cheaper and shaped differently
--     (D-WS9-261), so mixing them understates what a real member costs. They are
--     split, and the split is the `cohort` column.
--
-- MEDIAN AND p90, NOT MEAN. A single CLI audit day or one pathological plan drags
-- a mean a long way — the spend guard's own calibration note says one account was
-- 59% of all user-attributed rows in the sample it was derived from. The median is
-- what a typical call costs; p90 is what to size a ceiling against.

SELECT
  "promptKey",
  CASE
    WHEN "guestSessionId" IS NOT NULL THEN 'guest'
    WHEN "userId" IS NOT NULL         THEN 'member'
    -- Both null = system-triggered: seeds, batch jobs, Hans's CLI runs. Not a
    -- user-facing feature at all, and the spend guard exempts them (BUG-262), so
    -- they must not be priced as if a person had asked for them.
    ELSE 'system'
  END                                                              AS cohort,
  count(*)                                                         AS calls,
  round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY "costEstimateUsd")::numeric, 6) AS median_usd,
  round(percentile_cont(0.9)  WITHIN GROUP (ORDER BY "costEstimateUsd")::numeric, 6) AS p90_usd,
  round(sum("costEstimateUsd")::numeric, 4)                        AS total_usd,
  round(avg("inputTokens")::numeric, 0)                            AS avg_input_tokens,
  round(avg("outputTokens")::numeric, 0)                           AS avg_output_tokens
FROM llm_call_logs
WHERE "createdAt" >= now() - interval '30 days'
  AND success = true
GROUP BY 1, 2
-- Most expensive in aggregate first: that is the order in which "should this be
-- free?" is worth asking, because a cheap call made constantly costs more than an
-- expensive one made twice.
ORDER BY total_usd DESC, "promptKey";

-- ── the same thing rolled up, for the one-line version ───────────────────

SELECT
  CASE
    WHEN "guestSessionId" IS NOT NULL THEN 'guest'
    WHEN "userId" IS NOT NULL         THEN 'member'
    ELSE 'system'
  END                                                              AS cohort,
  count(*)                                                         AS calls,
  count(DISTINCT "promptKey")                                      AS distinct_prompts,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY "costEstimateUsd")::numeric, 6) AS median_usd,
  round(sum("costEstimateUsd")::numeric, 4)                        AS total_usd_30d
FROM llm_call_logs
WHERE "createdAt" >= now() - interval '30 days'
  AND success = true
GROUP BY 1
ORDER BY total_usd_30d DESC;
