// Row 9 (1.1) · Stripe S1 Part A — THE ENVIRONMENT CONTRACT FOR BILLING.
//
// ── THE POSTURE, WHICH IS THIS SERVER'S POSTURE EVERYWHERE ───────────────
//
// An unset feature variable means the feature is OFF and SAYS SO. The spend
// guard (BUG-263), Turnstile (D-WS9-262), Instacart (Row 8) and OAuth (Row 9
// Block 1) all work this way and this is the same shape: Stripe not configured
// → the billing routes answer 503 `billing_unavailable`, GET /me/subscription
// reports `billingAvailable: false`, and ONE line at boot names the state.
//
// ── THE ONE PLACE THE POSTURE IS NOT "DEGRADE QUIETLY" ───────────────────
//
// 🔴 `BILLING_ENFORCED=true` WITH STRIPE UNCONFIGURED THROWS AT BOOT (§2.4).
//
// Every other variable in this server degrades: the feature goes off, the
// server serves. This one cannot, because the state it describes is not a
// degraded feature — it is a LOCKED FRONT DOOR WITH NO KEY CUT. Enforcement on
// means an account past its trial gets 402 on everything that spends a model
// call; Stripe unconfigured means `POST /billing/checkout-session` answers 503.
// Together they are an app that tells the user to pay and then cannot take
// their money, for every user, until someone notices. There is no revision of
// that state that is better than refusing to boot, and a refusal to boot on
// Cloud Run rolls the traffic back to the previous revision by itself.
//
// The asymmetry is deliberate and it is the whole of the reasoning: OFF is
// free to be silent because off is today's behaviour (D-WS9-258 — every
// account is effectively premium and that is what the reviewers see). ON is
// not allowed to be silent because on is the first state in this project's
// history in which a configuration mistake takes the product away from the
// people using it.
//
// 🔴 NOTHING IN THIS FILE EVER LOGS A VALUE. `STRIPE_SECRET_KEY` is a live
// key against money and `STRIPE_WEBHOOK_SECRET` is what stops a stranger
// writing subscription rows. The price ids and the return base are not secret
// but are logged as presence anyway — BUG-219's rule, that a credential does
// not go in a log sink, is easier to keep when the file has no exceptions to
// it at all. The tests assert it.

import { logger } from "../logger";

export const ENV_STRIPE_SECRET_KEY = "STRIPE_SECRET_KEY";
export const ENV_STRIPE_WEBHOOK_SECRET = "STRIPE_WEBHOOK_SECRET";
export const ENV_STRIPE_PRICE_MONTHLY = "STRIPE_PRICE_MONTHLY";
export const ENV_STRIPE_PRICE_ANNUAL = "STRIPE_PRICE_ANNUAL";
export const ENV_BILLING_RETURN_URL_BASE = "BILLING_RETURN_URL_BASE";
export const ENV_BILLING_EARLY_PAY_BONUS_DAYS = "BILLING_EARLY_PAY_BONUS_DAYS";
export const ENV_BILLING_ENFORCED = "BILLING_ENFORCED";

/**
 * The five that Stripe cannot work without. All present = `available`; any
 * missing = the billing routes 503 and say which are missing, by NAME.
 *
 * ⚠️ ORDER IS THE ORDER THEY ARE REPORTED IN. Kept stable so the boot line and
 * the 503's log line read the same way every time.
 */
export const REQUIRED_STRIPE_VARS = [
  ENV_STRIPE_SECRET_KEY,
  ENV_STRIPE_WEBHOOK_SECRET,
  ENV_STRIPE_PRICE_MONTHLY,
  ENV_STRIPE_PRICE_ANNUAL,
  ENV_BILLING_RETURN_URL_BASE,
] as const;

/** §2.5 — the default when `BILLING_EARLY_PAY_BONUS_DAYS` is unset. */
export const DEFAULT_EARLY_PAY_BONUS_DAYS = 14;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export interface BillingConfig {
  secretKey: string | null;
  webhookSecret: string | null;
  priceMonthly: string | null;
  priceAnnual: string | null;
  /** No trailing slash; normalised here so no call site has to think about it. */
  returnUrlBase: string | null;
  /** Never null — an unset or unparseable value falls back to the default. */
  earlyPayBonusDays: number;
  enforced: boolean;
  /** All five of REQUIRED_STRIPE_VARS are set. */
  available: boolean;
  /** Which of the five are missing. NAMES, for the log and the 503. */
  missing: string[];
  /** Vars that were SET but could not be parsed. Presence only, never a value. */
  invalid: string[];
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Unset / blank / a FALSY word → off, not invalid. TRUTHY → on. Anything else
 * ("ture") → OFF and invalid, which is the safe direction for this particular
 * variable: a typo must not switch enforcement on, and it must not switch it
 * on in the one configuration that would also make the boot throw.
 *
 * (Sibling of spendGuard.ts's `parseDisabledRaw` rather than a reuse of it:
 * that one is not exported, and its report shape is bound to the AI_* set.)
 */
function parseFlag(raw: string | undefined): { value: boolean; invalid: boolean } {
  if (raw === undefined) return { value: false, invalid: false };
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || FALSY.has(trimmed)) return { value: false, invalid: false };
  if (TRUTHY.has(trimmed)) return { value: true, invalid: false };
  return { value: false, invalid: true };
}

/**
 * A whole number of days ≥ 0. Unset / blank → the default, not invalid.
 * Garbage or negative → the default AND invalid.
 *
 * 0 is VALID and means "no bonus": the first charge lands on `trialEndsAt`
 * exactly. That is a coherent configuration of the experiment (§5a) and the
 * lever Hans turns to end it without a deploy, so it must not be treated as
 * unset — which is why this does not use a falsy check anywhere.
 */
function parseBonusDays(raw: string | undefined): { value: number; invalid: boolean } {
  if (raw === undefined) return { value: DEFAULT_EARLY_PAY_BONUS_DAYS, invalid: false };
  const trimmed = raw.trim();
  if (trimmed === "") return { value: DEFAULT_EARLY_PAY_BONUS_DAYS, invalid: false };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { value: DEFAULT_EARLY_PAY_BONUS_DAYS, invalid: true };
  }
  return { value: n, invalid: false };
}

export function readBillingConfig(
  env: NodeJS.ProcessEnv = process.env,
): BillingConfig {
  const secretKey = readSecret(env, ENV_STRIPE_SECRET_KEY);
  const webhookSecret = readSecret(env, ENV_STRIPE_WEBHOOK_SECRET);
  const priceMonthly = readSecret(env, ENV_STRIPE_PRICE_MONTHLY);
  const priceAnnual = readSecret(env, ENV_STRIPE_PRICE_ANNUAL);
  const returnUrlBaseRaw = readSecret(env, ENV_BILLING_RETURN_URL_BASE);
  // One trailing slash or five — every call site appends "/billing/return".
  const returnUrlBase =
    returnUrlBaseRaw === null ? null : returnUrlBaseRaw.replace(/\/+$/, "");

  const enforcedParsed = parseFlag(env[ENV_BILLING_ENFORCED]);
  const bonusParsed = parseBonusDays(env[ENV_BILLING_EARLY_PAY_BONUS_DAYS]);

  const present: Record<string, string | null> = {
    [ENV_STRIPE_SECRET_KEY]: secretKey,
    [ENV_STRIPE_WEBHOOK_SECRET]: webhookSecret,
    [ENV_STRIPE_PRICE_MONTHLY]: priceMonthly,
    [ENV_STRIPE_PRICE_ANNUAL]: priceAnnual,
    [ENV_BILLING_RETURN_URL_BASE]: returnUrlBase,
  };
  const missing = REQUIRED_STRIPE_VARS.filter((n) => present[n] === null);

  const invalid: string[] = [];
  if (enforcedParsed.invalid) invalid.push(ENV_BILLING_ENFORCED);
  if (bonusParsed.invalid) invalid.push(ENV_BILLING_EARLY_PAY_BONUS_DAYS);

  return {
    secretKey,
    webhookSecret,
    priceMonthly,
    priceAnnual,
    returnUrlBase,
    earlyPayBonusDays: bonusParsed.value,
    enforced: enforcedParsed.value,
    available: missing.length === 0,
    missing: [...missing],
    invalid,
  };
}

/**
 * The named error §2.4 asks for. Named so the Cloud Run log shows WHICH
 * misconfiguration stopped the boot rather than a stack trace whose first
 * useful line is four frames down.
 */
export class BillingEnforcedWithoutStripeError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `${ENV_BILLING_ENFORCED} is on but Stripe is not configured (${missing.join(
        ", ",
      )} unset). Enforcing a paywall with no way to pay is never a valid state: every account past its trial would be refused, and POST /api/billing/checkout-session would answer 503 to all of them. Set the missing variables, or unset ${ENV_BILLING_ENFORCED}.`,
    );
    this.name = "BillingEnforcedWithoutStripeError";
    this.missing = missing;
  }
}

interface BootLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * BUG-263's rule applied to billing: every variable that is SET is validated at
 * boot and the effective state is one line. Called once from app.ts beside
 * `validateSpendGuardEnv`, `logTurnstileConfig` and `logOAuthConfig`.
 *
 * ⚠️ THIS ONE CAN STOP THE BOOT, and it is the only one of the four that can.
 * See the header for why. Every other state here logs and serves.
 */
export function logBillingConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: BootLogger = logger,
): BillingConfig {
  const config = readBillingConfig(env);

  for (const name of config.invalid) {
    log.error(
      { event: "billing_env_invalid", envVar: name },
      name === ENV_BILLING_ENFORCED
        ? `${ENV_BILLING_ENFORCED} is set but unparseable: expected 1/true/yes/on or 0/false/no/off — enforcement is OFF`
        : `${ENV_BILLING_EARLY_PAY_BONUS_DAYS} is set but unparseable: expected a non-negative whole number of days — falling back to ${DEFAULT_EARLY_PAY_BONUS_DAYS}`,
    );
  }

  // 🔴 THE THROW. After the `error` lines above, so a deploy that got here by
  // typing `BILLING_ENFORCED=ture` sees the typo named on the line before the
  // crash rather than having to infer it from the crash.
  if (config.enforced && !config.available) {
    const err = new BillingEnforcedWithoutStripeError(config.missing);
    log.error(
      { event: "billing_enforced_without_stripe", vars: config.missing },
      err.message,
    );
    throw err;
  }

  if (!config.available) {
    log.warn(
      { event: "billing_not_configured", vars: config.missing },
      `Billing: NOT configured (${config.missing.join(
        ", ",
      )} unset) — POST /api/billing/checkout-session and /api/billing/portal-session answer 503 billing_unavailable, and GET /api/me/subscription reports billingAvailable: false`,
    );
  }

  log.info(
    {
      event: "billing_config",
      // PRESENCE, not the values — see this file's header.
      stripe: config.available ? "configured" : "disabled",
      missingVars: config.missing,
      enforced: config.enforced,
      earlyPayBonusDays: config.earlyPayBonusDays,
      invalidVars: config.invalid,
    },
    `Billing: stripe ${config.available ? "on" : "off"} · enforcement ${
      config.enforced ? "ON" : "off"
    } · early-pay bonus ${config.earlyPayBonusDays} d`,
  );

  return config;
}
