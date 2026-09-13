// D-WS9-240 — AI spend guard. Sits at the top of BOTH doors to Anthropic
// (runAICall + streamPlanCandidates) after descriptor/rate resolution and
// before any `messages.*` call.
//
// Why this exists: the api-server is public on Cloud Run and every plan-gen
// call spends real Anthropic tokens. The per-route limiters (rateLimit.ts)
// bound request RATE per IP; nothing bounded SPEND, and a slow-drip abuser
// stays under every limiter. Hans's monthly cap in the Anthropic console is
// the backstop; this is the thing in front of it.
//
// Three checks, in this order, each independently env-driven so any one can
// be turned on without the others. UNSET ENV = CHECK DISABLED — nothing here
// changes behaviour until a variable is set. All three are Cloud Run env vars
// (a new revision, no build), so a false trip costs seconds to undo while a
// missed drain is unbounded — that asymmetry is why the defaults lean tight.
//
//   1. AI_DISABLED            — kill switch. Truthy → refuse everything.
//   2. AI_DAILY_CEILING_USD   — SUM(costEstimateUsd) over the current UTC day
//                               WHERE userId IS NOT NULL ≥ ceiling → refuse.
//   3. AI_USER_DAILY_CALLS    — COUNT(*) for this userId over the current UTC
//                               day ≥ cap → refuse THAT USER only.
//
// Keyed on userId, never IP: `trust proxy` defaults to 0 so on Cloud Run
// req.ip is Google's front end for everyone (see app.ts / TRUST_PROXY_HOPS).
// Every AI route sits behind requireAuth (Phase 0 §2.3), so userId is always
// present on a request path; null userId only comes from CLI/seed callers.
//
// `userId IS NOT NULL` on the global sum is deliberate: the threat is
// user-facing traffic on the public server. Hans's CLI seed runs (userId null)
// are governed by his Anthropic console cap and must not lock the server
// mid-seed.
//
// ⚠️ Known limit — LLMCallLog writes fail soft (writeLogSafely swallows a
// failed insert, and D-WS6-030 records that an unknown userId drops the row),
// so both sums UNDER-COUNT by exactly the rows that were dropped. Acceptable in
// front of a hard console cap; not acceptable as the only line.
//
// ⚠️ A refusal writes NO LLMCallLog row. A row per refusal is a write-
// amplification vector under exactly the traffic this guards against. Refusals
// are logged via pino at `warn`, sampled (first, then every Nth per reason).
//
// ⚠️ No process-memory cache of either sum. Cloud Run may run more than one
// instance and a per-process counter diverges silently. Two DB reads per AI
// call is the cost of this design; both hit existing indexes
// (llm_call_logs_createdAt_idx / [userId, createdAt] — Phase 0 §2.4 EXPLAIN).
//
// ⚠️ DEFAULT CALIBRATION (2026-09-13). The proposed values — AI_USER_DAILY_CALLS
// = 500, AI_DAILY_CEILING_USD = 10 — were derived from a 9-user, 83-user-day
// sample in which ONE account (Hans's) is 59% of all user-attributed rows.
// Per-user p95 was 190 calls/day (84 with a CLI audit day excluded); the
// largest real app day was $3.50. THE CEILING MUST BE RE-DERIVED BEFORE THE
// USER BASE GROWS: at 50 users a $10/day ceiling is an outage, not a guard.
//
// Fail-open on a DB read error: if the sum/count query itself throws (Neon
// asleep, connection lost) the check passes and the error is logged. This is
// consistent — the same outage would also drop the LLMCallLog write and
// requireAuth's epoch read fails the request before it reaches here — and it
// keeps the guard from converting a DB hiccup into an AI outage.

import { logger } from "./logger";
import type { PrismaLike } from "./ai/promptRegistry";

export type SpendGuardReason =
  | "ai_disabled"
  | "spend_cap_global"
  | "spend_cap_user";

export interface SpendGuardConfig {
  disabled: boolean;
  // null = check disabled.
  dailyCeilingUsd: number | null;
  // null = check disabled.
  userDailyCalls: number | null;
}

export type SpendGuardVerdict =
  | { refused: false }
  | { refused: true; reason: SpendGuardReason; retryAfterSeconds: number };

export interface SpendGuardInput {
  prisma: PrismaLike | null;
  userId: string | null;
  // Diagnostic only — rides on the sampled refusal log line.
  promptKey: string;
  // Test seams. Production omits both.
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export const ENV_AI_DISABLED = "AI_DISABLED";
export const ENV_AI_DAILY_CEILING_USD = "AI_DAILY_CEILING_USD";
export const ENV_AI_USER_DAILY_CALLS = "AI_USER_DAILY_CALLS";

// A kill switch has no natural expiry; midnight would be a lie. Tell clients
// to come back in five minutes.
export const AI_DISABLED_RETRY_AFTER_SECONDS = 300;

// Log the 1st refusal per reason, then every Nth.
const REFUSAL_LOG_SAMPLE = 50;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

// ── env ──────────────────────────────────────────────────────────────

// Warn once per (name, raw) so a typo in Cloud Run env is visible in the logs
// without a line per AI call. Dedupe state only — never a counter the guard
// reads back.
const warnedInvalid = new Set<string>();
const warnedCannotEvaluate = new Set<string>();

function parseThreshold(
  name: string,
  raw: string | undefined,
): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    const key = `${name}=${trimmed}`;
    if (!warnedInvalid.has(key)) {
      warnedInvalid.add(key);
      logger.warn(
        { event: "spend_guard_invalid_env", name, raw: trimmed },
        "spend guard env var is not a non-negative number — check disabled",
      );
    }
    return null;
  }
  // 0 is a valid threshold: it refuses everything (a kill switch by another
  // name). Only unset / blank / garbage disables the check.
  return n;
}

export function readSpendGuardConfig(
  env: NodeJS.ProcessEnv = process.env,
): SpendGuardConfig {
  const disabledRaw = env[ENV_AI_DISABLED]?.trim().toLowerCase() ?? "";
  return {
    disabled: TRUTHY.has(disabledRaw),
    dailyCeilingUsd: parseThreshold(
      ENV_AI_DAILY_CEILING_USD,
      env[ENV_AI_DAILY_CEILING_USD],
    ),
    userDailyCalls: parseThreshold(
      ENV_AI_USER_DAILY_CALLS,
      env[ENV_AI_USER_DAILY_CALLS],
    ),
  };
}

// ── UTC day arithmetic ───────────────────────────────────────────────

export function utcDayStart(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export function secondsUntilNextUtcDay(now: Date): number {
  const next = utcDayStart(now).getTime() + 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

// ── refusal logging (sampled) ────────────────────────────────────────

// Sampling state only — log cadence, not a value any check reads.
const refusalsSeen: Record<SpendGuardReason, number> = {
  ai_disabled: 0,
  spend_cap_global: 0,
  spend_cap_user: 0,
};

// Test-only.
export function _resetSpendGuardLogSampling(): void {
  refusalsSeen.ai_disabled = 0;
  refusalsSeen.spend_cap_global = 0;
  refusalsSeen.spend_cap_user = 0;
  warnedInvalid.clear();
  warnedCannotEvaluate.clear();
}

function logRefusal(
  reason: SpendGuardReason,
  ctx: { userId: string | null; promptKey: string; observed?: number; threshold?: number },
): void {
  const n = ++refusalsSeen[reason];
  if (n !== 1 && n % REFUSAL_LOG_SAMPLE !== 0) return;
  logger.warn(
    {
      event: "spend_guard_refused",
      reason,
      userId: ctx.userId,
      promptKey: ctx.promptKey,
      observed: ctx.observed,
      threshold: ctx.threshold,
      refusalsSinceStart: n,
      sampleEvery: REFUSAL_LOG_SAMPLE,
    },
    "AI call refused by spend guard",
  );
}

// ── the check ────────────────────────────────────────────────────────

export async function checkSpendGuard(
  input: SpendGuardInput,
): Promise<SpendGuardVerdict> {
  const cfg = readSpendGuardConfig(input.env ?? process.env);
  const now = input.now ?? new Date();
  const { prisma, userId, promptKey } = input;

  // 1. Kill switch — no DB read.
  if (cfg.disabled) {
    logRefusal("ai_disabled", { userId, promptKey });
    return {
      refused: true,
      reason: "ai_disabled",
      retryAfterSeconds: AI_DISABLED_RETRY_AFTER_SECONDS,
    };
  }

  const needsDb = cfg.dailyCeilingUsd != null || (cfg.userDailyCalls != null && userId != null);
  if (!needsDb) return { refused: false };

  const log = prisma?.lLMCallLog;
  const dayStart = utcDayStart(now);

  // 2. Global daily ceiling (user-attributed rows only — see header).
  if (cfg.dailyCeilingUsd != null) {
    if (!log?.aggregate) {
      logCannotEvaluate("spend_cap_global", promptKey);
    } else {
      try {
        const agg = await log.aggregate({
          _sum: { costEstimateUsd: true },
          where: { createdAt: { gte: dayStart }, userId: { not: null } },
        });
        // Prisma hands back a Decimal (or null when the day has no rows).
        const spent = Number(agg._sum.costEstimateUsd ?? 0);
        if (spent >= cfg.dailyCeilingUsd) {
          logRefusal("spend_cap_global", {
            userId,
            promptKey,
            observed: spent,
            threshold: cfg.dailyCeilingUsd,
          });
          return {
            refused: true,
            reason: "spend_cap_global",
            retryAfterSeconds: secondsUntilNextUtcDay(now),
          };
        }
      } catch (err) {
        logger.error(
          { event: "spend_guard_read_failed", check: "spend_cap_global", err },
          "spend guard DB read failed — passing the call through",
        );
      }
    }
  }

  // 3. Per-user daily cap. Count-based: "you've hit today's limit" is legible
  //    to a human; a dollar figure is not.
  if (cfg.userDailyCalls != null && userId != null) {
    if (!log?.count) {
      logCannotEvaluate("spend_cap_user", promptKey);
    } else {
      try {
        const calls = await log.count({
          where: { userId, createdAt: { gte: dayStart } },
        });
        if (calls >= cfg.userDailyCalls) {
          logRefusal("spend_cap_user", {
            userId,
            promptKey,
            observed: calls,
            threshold: cfg.userDailyCalls,
          });
          return {
            refused: true,
            reason: "spend_cap_user",
            retryAfterSeconds: secondsUntilNextUtcDay(now),
          };
        }
      } catch (err) {
        logger.error(
          { event: "spend_guard_read_failed", check: "spend_cap_user", err },
          "spend guard DB read failed — passing the call through",
        );
      }
    }
  }

  return { refused: false };
}

// A DB-backed check is configured but the caller handed us no prisma (or a
// stub without the aggregate/count surface). Production always passes the real
// client; this is a test/unconfigured-caller condition, and it passes through
// — refusing here would make every prisma-less test fail the moment the env
// is set in a shell. Logged (deduped) so it cannot go unnoticed in production.
function logCannotEvaluate(check: SpendGuardReason, promptKey: string): void {
  if (warnedCannotEvaluate.has(check)) return;
  warnedCannotEvaluate.add(check);
  logger.warn(
    { event: "spend_guard_no_prisma", check, promptKey },
    "spend guard check configured but no prisma client with count/aggregate was supplied — passing through",
  );
}
