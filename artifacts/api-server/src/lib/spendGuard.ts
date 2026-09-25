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
// Row 13 "Test Kitchen" · Block 1 (D-WS9-261) adds TWO MORE, for the guest
// lane only, on their own budget and their own lever:
//
//   4. AI_GUEST_DISABLED            — the guest kill switch. Stops the public
//                                     funnel WITHOUT stopping the product.
//   5. AI_GUEST_DAILY_CEILING_USD   — SUM(costEstimateUsd) over the current UTC
//                                     day WHERE guestSessionId IS NOT NULL.
//
// The two sums PARTITION the ledger: the user ceiling reads userId IS NOT NULL,
// the guest ceiling reads guestSessionId IS NOT NULL, and a system row (both
// null) is in neither. A guest is never measured against the user ceiling or
// the per-user call cap, and vice versa. The guest branch sits ABOVE the
// `userId == null` early return below — see the comment there for why that
// position is the whole point.
//
// Keyed on userId, never IP: `trust proxy` defaults to 0 so on Cloud Run
// req.ip is Google's front end for everyone (see app.ts / TRUST_PROXY_HOPS).
// Every AI route sits behind requireAuth (Phase 0 §2.3), so userId is always
// present on a request path; null userId only comes from CLI/seed callers.
//
// System-triggered calls (userId null — seeds, batch jobs, Hans's CLI runs)
// are OUTSIDE both DB-backed checks, on both sides of the ledger (BUG-262):
// their rows do not count toward the ceiling (`userId IS NOT NULL` on the
// sum), AND a null-userId caller skips the ceiling and per-user reads
// entirely — zero DB reads. The threat is user-facing traffic on the public
// server; a catalog run is thousands of sequential calls governed by Hans's
// Anthropic console cap, and refusing it partway through because daytime user
// traffic crossed the ceiling would leave a half-populated catalog. Only the
// kill switch applies to everything: AI_DISABLED is a deliberate manual act
// and must mean off, seeds included.
//
// Env hygiene (BUG-263): a var that is SET but unparseable disables its check
// (null) — a typo must not take the app down — but it is loud: app.ts calls
// validateSpendGuardEnv() once at boot, which logs `error` per bad var and an
// `info` line with the effective config, so the guard's real state is on the
// first page of every revision's logs. The per-call read only warns (deduped).
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
  | "spend_cap_user"
  // Row 13 "Test Kitchen" · Block 1 (D-WS9-261) — the guest lane's own two.
  | "guest_disabled"
  | "guest_daily_ceiling";

export interface SpendGuardConfig {
  disabled: boolean;
  // null = check disabled.
  dailyCeilingUsd: number | null;
  // null = check disabled.
  userDailyCalls: number | null;
  // Row 13 · Block 1 (D-WS9-261) — the GUEST kill switch and the GUEST ceiling,
  // deliberately SEPARATE from the two above rather than a widening of them.
  //
  // Hans's reasoning, and it is an operational one: "if I'm hitting that
  // regularly and getting a lot of signups, great. if I'm hitting that and no
  // signups, I can kill it before it hurts much." Guest spend is MARKETING
  // COST — a different budget with a different success test from the spend of
  // people who have accounts — so it needs a lever that stops the funnel
  // without stopping the product, and a ceiling that can be blown through on a
  // good day without touching what paying users are allowed to do.
  guestDisabled: boolean;
  // null = check disabled.
  guestDailyCeilingUsd: number | null;
}

export type SpendGuardVerdict =
  | { refused: false }
  | { refused: true; reason: SpendGuardReason; retryAfterSeconds: number };

export interface SpendGuardInput {
  prisma: PrismaLike | null;
  userId: string | null;
  // Row 13 · Block 1 (D-WS9-261) — set for a guest call, and then userId is
  // null (a guest has no User row). Mutually exclusive by construction.
  guestSessionId?: string | null;
  // Diagnostic only — rides on the sampled refusal log line.
  promptKey: string;
  // Test seams. Production omits both.
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export const ENV_AI_DISABLED = "AI_DISABLED";
export const ENV_AI_DAILY_CEILING_USD = "AI_DAILY_CEILING_USD";
export const ENV_AI_USER_DAILY_CALLS = "AI_USER_DAILY_CALLS";
// Row 13 · Block 1 (D-WS9-261). Same posture as the three above: UNSET = CHECK
// DISABLED, a set-but-unparseable value disables the check loudly, and both
// are plain Cloud Run env vars (a new revision, no build) so the kill switch
// is seconds away when Hans wants it.
export const ENV_AI_GUEST_DISABLED = "AI_GUEST_DISABLED";
export const ENV_AI_GUEST_DAILY_CEILING_USD = "AI_GUEST_DAILY_CEILING_USD";

// A kill switch has no natural expiry; midnight would be a lie. Tell clients
// to come back in five minutes.
export const AI_DISABLED_RETRY_AFTER_SECONDS = 300;

// Log the 1st refusal per reason, then every Nth.
const REFUSAL_LOG_SAMPLE = 50;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

// ── env ──────────────────────────────────────────────────────────────

// Warn once per (name, raw) so a typo in Cloud Run env is visible in the logs
// without a line per AI call. Dedupe state only — never a counter the guard
// reads back.
const warnedInvalid = new Set<string>();
const warnedCannotEvaluate = new Set<string>();

// One parsed variable. `invalid` = SET to something we could not read; the
// effective value is then the safe default (check off / switch off).
interface ParsedVar<T> {
  value: T;
  invalid: boolean;
  raw: string | undefined;
}

// Pure. Unset / blank → null, not invalid. Garbage / negative → null, invalid.
// 0 is a valid threshold: it refuses everything (a kill switch by another name).
function parseThresholdRaw(raw: string | undefined): ParsedVar<number | null> {
  if (raw === undefined) return { value: null, invalid: false, raw };
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, invalid: false, raw };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return { value: null, invalid: true, raw: trimmed };
  return { value: n, invalid: false, raw: trimmed };
}

// Pure. Unset / blank / a FALSY word → off, not invalid. TRUTHY → on. Anything
// else ("ture") → off AND invalid — the same silent-off class as a bad number.
function parseDisabledRaw(raw: string | undefined): ParsedVar<boolean> {
  if (raw === undefined) return { value: false, invalid: false, raw };
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || FALSY.has(trimmed)) return { value: false, invalid: false, raw: trimmed };
  if (TRUTHY.has(trimmed)) return { value: true, invalid: false, raw: trimmed };
  return { value: false, invalid: true, raw: trimmed };
}

interface ParsedEnv {
  disabled: ParsedVar<boolean>;
  dailyCeilingUsd: ParsedVar<number | null>;
  userDailyCalls: ParsedVar<number | null>;
  guestDisabled: ParsedVar<boolean>;
  guestDailyCeilingUsd: ParsedVar<number | null>;
}

function parseEnv(env: NodeJS.ProcessEnv): ParsedEnv {
  return {
    disabled: parseDisabledRaw(env[ENV_AI_DISABLED]),
    dailyCeilingUsd: parseThresholdRaw(env[ENV_AI_DAILY_CEILING_USD]),
    userDailyCalls: parseThresholdRaw(env[ENV_AI_USER_DAILY_CALLS]),
    guestDisabled: parseDisabledRaw(env[ENV_AI_GUEST_DISABLED]),
    guestDailyCeilingUsd: parseThresholdRaw(
      env[ENV_AI_GUEST_DAILY_CEILING_USD],
    ),
  };
}

function toConfig(parsed: ParsedEnv): SpendGuardConfig {
  return {
    disabled: parsed.disabled.value,
    dailyCeilingUsd: parsed.dailyCeilingUsd.value,
    userDailyCalls: parsed.userDailyCalls.value,
    guestDisabled: parsed.guestDisabled.value,
    guestDailyCeilingUsd: parsed.guestDailyCeilingUsd.value,
  };
}

// Per-call read. An invalid var warns once per (name, raw) — the loud version
// is validateSpendGuardEnv at boot.
export function readSpendGuardConfig(
  env: NodeJS.ProcessEnv = process.env,
): SpendGuardConfig {
  const parsed = parseEnv(env);
  const entries: Array<[string, ParsedVar<unknown>]> = [
    [ENV_AI_DISABLED, parsed.disabled],
    [ENV_AI_DAILY_CEILING_USD, parsed.dailyCeilingUsd],
    [ENV_AI_USER_DAILY_CALLS, parsed.userDailyCalls],
    [ENV_AI_GUEST_DISABLED, parsed.guestDisabled],
    [ENV_AI_GUEST_DAILY_CEILING_USD, parsed.guestDailyCeilingUsd],
  ];
  for (const [name, p] of entries) {
    if (!p.invalid) continue;
    const key = `${name}=${p.raw}`;
    if (warnedInvalid.has(key)) continue;
    warnedInvalid.add(key);
    logger.warn(
      { event: "spend_guard_invalid_env", envVar: name, raw: p.raw },
      "spend guard env var is unparseable — check disabled",
    );
  }
  return toConfig(parsed);
}

// ── boot-time validation (BUG-263) ───────────────────────────────────

export interface SpendGuardEnvReport {
  config: SpendGuardConfig;
  // Every var that was SET but could not be parsed. Empty = clean.
  invalid: Array<{ name: string; raw: string }>;
}

// Structural over pino so tests can hand in a recorder.
interface BootLogger {
  error(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

// Call ONCE at module load (app.ts, beside the TRUST_PROXY_HOPS warn). Logs
// `error` for each var that is set but unparseable — the check it governs is
// OFF, and whoever set it believes it is on — then ONE `info` line with the
// effective config so the guard's real state is on the first page of every
// revision's logs. Logs nothing but these three variables' own values.
export function validateSpendGuardEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: BootLogger = logger,
): SpendGuardEnvReport {
  const parsed = parseEnv(env);
  const invalid: SpendGuardEnvReport["invalid"] = [];
  const entries: Array<[string, ParsedVar<unknown>, string]> = [
    [ENV_AI_DISABLED, parsed.disabled, "expected 1/true/yes/on or 0/false/no/off — kill switch is OFF"],
    [ENV_AI_DAILY_CEILING_USD, parsed.dailyCeilingUsd, "expected a non-negative number — ceiling check is OFF"],
    [ENV_AI_USER_DAILY_CALLS, parsed.userDailyCalls, "expected a non-negative number — per-user cap is OFF"],
    [ENV_AI_GUEST_DISABLED, parsed.guestDisabled, "expected 1/true/yes/on or 0/false/no/off — the GUEST kill switch is OFF"],
    [ENV_AI_GUEST_DAILY_CEILING_USD, parsed.guestDailyCeilingUsd, "expected a non-negative number — the GUEST ceiling is OFF"],
  ];
  for (const [name, p, hint] of entries) {
    if (!p.invalid) continue;
    invalid.push({ name, raw: p.raw ?? "" });
    log.error(
      { event: "spend_guard_env_invalid", envVar: name, raw: p.raw },
      `${name} is set but unparseable: ${hint}`,
    );
  }
  const config = toConfig(parsed);
  log.info(
    {
      event: "spend_guard_config",
      killSwitch: config.disabled ? "on" : "off",
      dailyCeilingUsd: config.dailyCeilingUsd ?? "disabled",
      userDailyCalls: config.userDailyCalls ?? "disabled",
      guestKillSwitch: config.guestDisabled ? "on" : "off",
      guestDailyCeilingUsd: config.guestDailyCeilingUsd ?? "disabled",
      invalidVars: invalid.map((i) => i.name),
    },
    `AI spend guard: kill switch ${config.disabled ? "ON" : "off"} · daily ceiling ${
      config.dailyCeilingUsd == null ? "disabled" : `$${config.dailyCeilingUsd}`
    } · per-user cap ${
      config.userDailyCalls == null ? "disabled" : `${config.userDailyCalls} calls/day`
    } · guest kill switch ${config.guestDisabled ? "ON" : "off"} · guest ceiling ${
      config.guestDailyCeilingUsd == null
        ? "disabled"
        : `$${config.guestDailyCeilingUsd}`
    }`,
  );
  return { config, invalid };
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
  guest_disabled: 0,
  guest_daily_ceiling: 0,
};

// Test-only.
export function _resetSpendGuardLogSampling(): void {
  refusalsSeen.ai_disabled = 0;
  refusalsSeen.spend_cap_global = 0;
  refusalsSeen.spend_cap_user = 0;
  refusalsSeen.guest_disabled = 0;
  refusalsSeen.guest_daily_ceiling = 0;
  warnedInvalid.clear();
  warnedCannotEvaluate.clear();
}

function logRefusal(
  reason: SpendGuardReason,
  ctx: {
    userId: string | null;
    guestSessionId?: string | null;
    promptKey: string;
    observed?: number;
    threshold?: number;
  },
): void {
  const n = ++refusalsSeen[reason];
  if (n !== 1 && n % REFUSAL_LOG_SAMPLE !== 0) return;
  logger.warn(
    {
      event: "spend_guard_refused",
      reason,
      userId: ctx.userId,
      guestSessionId: ctx.guestSessionId ?? null,
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
  const guestSessionId = input.guestSessionId ?? null;

  // 1. Kill switch — no DB read.
  if (cfg.disabled) {
    logRefusal("ai_disabled", { userId, guestSessionId, promptKey });
    return {
      refused: true,
      reason: "ai_disabled",
      retryAfterSeconds: AI_DISABLED_RETRY_AFTER_SECONDS,
    };
  }

  // ── 1b. Row 13 · Block 1 (D-WS9-261) — THE GUEST BRANCH ─────────────────
  //
  // 🔴 THIS SITS ABOVE THE `userId == null` EARLY RETURN, AND THAT POSITION IS
  // THE ENTIRE FIX. A guest call carries userId null, so under the old order it
  // would hit BUG-262's system-caller exemption one line below and return
  // unrefused, having read nothing — guest spend would be both UNGUARDED and,
  // because the global sum filters `userId IS NOT NULL`, INVISIBLE. An
  // anonymous public funnel is the last traffic that should inherit the
  // exemption written for Hans's CLI runs.
  //
  // The guest lane gets its own kill switch and its own ceiling, and it
  // returns here either way: a guest is never measured against the user
  // ceiling or the per-user call cap, and its rows never enter the user sum.
  if (guestSessionId != null) {
    if (cfg.guestDisabled) {
      logRefusal("guest_disabled", { userId, guestSessionId, promptKey });
      return {
        refused: true,
        reason: "guest_disabled",
        retryAfterSeconds: AI_DISABLED_RETRY_AFTER_SECONDS,
      };
    }
    if (cfg.guestDailyCeilingUsd == null) return { refused: false };

    const guestLog = prisma?.lLMCallLog;
    if (!guestLog?.aggregate) {
      logCannotEvaluate("guest_daily_ceiling", promptKey);
      return { refused: false };
    }
    try {
      const agg = await guestLog.aggregate({
        _sum: { costEstimateUsd: true },
        where: {
          createdAt: { gte: utcDayStart(now) },
          // The mirror image of the user sum's `userId: { not: null }`: guest
          // rows only. The two sums partition the ledger; neither sees the
          // other's spend, and system rows (both null) are in neither.
          guestSessionId: { not: null },
        },
      });
      const spent = Number(agg._sum.costEstimateUsd ?? 0);
      if (spent >= cfg.guestDailyCeilingUsd) {
        logRefusal("guest_daily_ceiling", {
          userId,
          guestSessionId,
          promptKey,
          observed: spent,
          threshold: cfg.guestDailyCeilingUsd,
        });
        return {
          refused: true,
          reason: "guest_daily_ceiling",
          retryAfterSeconds: secondsUntilNextUtcDay(now),
        };
      }
    } catch (err) {
      // Fail OPEN on a read error, exactly as the two checks below do. The
      // asymmetry is deliberate and documented in the header: a DB hiccup must
      // not convert itself into an AI outage, and Hans's Anthropic console cap
      // is the backstop behind all of this.
      logger.error(
        { event: "spend_guard_read_failed", check: "guest_daily_ceiling", err },
        "spend guard DB read failed — passing the call through",
      );
    }
    return { refused: false };
  }

  // BUG-262 — system-triggered calls (seeds, batch jobs) are outside both
  // DB-backed checks: zero reads, never refused by a cap. Only the kill switch
  // above reaches them. See the header for why.
  if (userId == null) return { refused: false };

  const needsDb = cfg.dailyCeilingUsd != null || cfg.userDailyCalls != null;
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
  if (cfg.userDailyCalls != null) {
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
