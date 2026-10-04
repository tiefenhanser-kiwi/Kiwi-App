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
// Resubmission B1 adds the second rail on the same terms: RevenueCat (Apple
// In-App Purchase, Google Play Billing) not configured → POST
// /api/webhooks/revenuecat and POST /api/billing/store-sync answer 503, and the
// boot line says so. Either rail can be on without the other.
//
// ── THE ONE PLACE THE POSTURE IS NOT "DEGRADE QUIETLY" ───────────────────
//
// 🔴 `BILLING_ENFORCED=true` WITH EITHER RAIL UNCONFIGURED THROWS AT BOOT
// (§2.4, and Resubmission B1 for the store rail).
//
// Every other variable in this server degrades: the feature goes off, the
// server serves. This one cannot, because the state it describes is not a
// degraded feature — it is a LOCKED FRONT DOOR WITH NO KEY CUT. Enforcement on
// means an account past its trial gets 402 on everything that spends a model
// call; Stripe unconfigured means `POST /billing/checkout-session` answers 503,
// and RevenueCat unconfigured means an iPhone purchase never reaches the
// account. Either way it is an app that tells the user to pay and then cannot
// take (or cannot honour) their money, for every user, until someone notices.
// There is no revision of that state that is better than refusing to boot, and
// a refusal to boot on Cloud Run rolls the traffic back to the previous
// revision by itself.
//
// The asymmetry is deliberate and it is the whole of the reasoning: OFF is
// free to be silent because off is today's behaviour (D-WS9-258 — every
// account is effectively premium and that is what the reviewers see). ON is
// not allowed to be silent because on is the first state in this project's
// history in which a configuration mistake takes the product away from the
// people using it.
//
// 🔴 NOTHING IN THIS FILE EVER LOGS A VALUE. `STRIPE_SECRET_KEY` is a live
// key against money, `STRIPE_WEBHOOK_SECRET` and `REVENUECAT_WEBHOOK_AUTH` are
// what stop a stranger writing subscription rows, and
// `REVENUECAT_SECRET_API_KEY` reads every customer's purchase history. The
// price ids and the return base are not secret but are logged as presence
// anyway — BUG-219's rule, that a credential does not go in a log sink, is
// easier to keep when the file has no exceptions to it at all. The tests
// assert it.
//
// (The pay-early bonus and BILLING_EARLY_PAY_BONUS_DAYS are GONE — Resubmission
// B1, Hans 2026-10-04: one rule on all three platforms, subscribing during the
// trial bills at purchase. Promotions are store and Stripe promo settings.)

import { logger } from "../logger";

export const ENV_STRIPE_SECRET_KEY = "STRIPE_SECRET_KEY";
export const ENV_STRIPE_WEBHOOK_SECRET = "STRIPE_WEBHOOK_SECRET";
export const ENV_STRIPE_PRICE_MONTHLY = "STRIPE_PRICE_MONTHLY";
export const ENV_STRIPE_PRICE_ANNUAL = "STRIPE_PRICE_ANNUAL";
export const ENV_BILLING_RETURN_URL_BASE = "BILLING_RETURN_URL_BASE";
export const ENV_BILLING_ENFORCED = "BILLING_ENFORCED";

// Resubmission B1 — Apple In-App Purchase and Google Play Billing, through
// RevenueCat. The two secrets are what the webhook and the re-read need; the
// entitlement id names which RevenueCat entitlement means "Kiwi Premium".
export const ENV_REVENUECAT_WEBHOOK_AUTH = "REVENUECAT_WEBHOOK_AUTH";
export const ENV_REVENUECAT_SECRET_API_KEY = "REVENUECAT_SECRET_API_KEY";
export const ENV_REVENUECAT_ENTITLEMENT_ID = "REVENUECAT_ENTITLEMENT_ID";

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

/**
 * Resubmission B1 — the two RevenueCat variables the store rail cannot work
 * without. Same ordering rule as Stripe's five.
 */
export const REQUIRED_REVENUECAT_VARS = [
  ENV_REVENUECAT_WEBHOOK_AUTH,
  ENV_REVENUECAT_SECRET_API_KEY,
] as const;

/** The RevenueCat entitlement that means "Kiwi Premium" when the env is unset. */
export const DEFAULT_REVENUECAT_ENTITLEMENT_ID = "premium";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export interface BillingConfig {
  secretKey: string | null;
  webhookSecret: string | null;
  priceMonthly: string | null;
  priceAnnual: string | null;
  /** No trailing slash; normalised here so no call site has to think about it. */
  returnUrlBase: string | null;
  enforced: boolean;
  /** All five of REQUIRED_STRIPE_VARS are set. */
  available: boolean;
  /** Which of the five are missing. NAMES, for the log and the 503. */
  missing: string[];
  /** Vars that were SET but could not be parsed. Presence only, never a value. */
  invalid: string[];
  /**
   * Resubmission B1 — RevenueCat. `revenuecatAvailable` = both required vars
   * set; the store webhook and POST /billing/store-sync answer 503 otherwise.
   * Independent of `available` (Stripe): either rail can be on alone.
   */
  revenuecatWebhookAuth: string | null;
  revenuecatSecretApiKey: string | null;
  /** Never null — unset falls back to DEFAULT_REVENUECAT_ENTITLEMENT_ID. */
  revenuecatEntitlementId: string;
  revenuecatAvailable: boolean;
  /** Which of REQUIRED_REVENUECAT_VARS are missing. NAMES only. */
  revenuecatMissing: string[];
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

  const present: Record<string, string | null> = {
    [ENV_STRIPE_SECRET_KEY]: secretKey,
    [ENV_STRIPE_WEBHOOK_SECRET]: webhookSecret,
    [ENV_STRIPE_PRICE_MONTHLY]: priceMonthly,
    [ENV_STRIPE_PRICE_ANNUAL]: priceAnnual,
    [ENV_BILLING_RETURN_URL_BASE]: returnUrlBase,
  };
  const missing = REQUIRED_STRIPE_VARS.filter((n) => present[n] === null);

  const revenuecatWebhookAuth = readSecret(env, ENV_REVENUECAT_WEBHOOK_AUTH);
  const revenuecatSecretApiKey = readSecret(env, ENV_REVENUECAT_SECRET_API_KEY);
  const revenuecatEntitlementId =
    readSecret(env, ENV_REVENUECAT_ENTITLEMENT_ID) ?? DEFAULT_REVENUECAT_ENTITLEMENT_ID;
  const revenuecatPresent: Record<string, string | null> = {
    [ENV_REVENUECAT_WEBHOOK_AUTH]: revenuecatWebhookAuth,
    [ENV_REVENUECAT_SECRET_API_KEY]: revenuecatSecretApiKey,
  };
  const revenuecatMissing = REQUIRED_REVENUECAT_VARS.filter(
    (n) => revenuecatPresent[n] === null,
  );

  const invalid: string[] = [];
  if (enforcedParsed.invalid) invalid.push(ENV_BILLING_ENFORCED);

  return {
    secretKey,
    webhookSecret,
    priceMonthly,
    priceAnnual,
    returnUrlBase,
    enforced: enforcedParsed.value,
    available: missing.length === 0,
    missing: [...missing],
    invalid,
    revenuecatWebhookAuth,
    revenuecatSecretApiKey,
    revenuecatEntitlementId,
    revenuecatAvailable: revenuecatMissing.length === 0,
    revenuecatMissing: [...revenuecatMissing],
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

/**
 * Resubmission B1 — the same refusal for the store rail. A paywall enforced on
 * iPhone and Android with RevenueCat unconfigured takes the user's money in
 * the store and never unlocks the account: the webhook 503s and store-sync
 * 503s, so the purchase lands nowhere.
 */
export class BillingEnforcedWithoutRevenueCatError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `${ENV_BILLING_ENFORCED} is on but RevenueCat is not configured (${missing.join(
        ", ",
      )} unset). An App Store or Google Play purchase would be charged and never reach the account: POST /api/webhooks/revenuecat and POST /api/billing/store-sync would answer 503. Set the missing variables, or unset ${ENV_BILLING_ENFORCED}.`,
    );
    this.name = "BillingEnforcedWithoutRevenueCatError";
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
      `${ENV_BILLING_ENFORCED} is set but unparseable: expected 1/true/yes/on or 0/false/no/off — enforcement is OFF`,
    );
  }

  // 🔴 THE THROWS. After the `error` lines above, so a deploy that got here by
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
  if (config.enforced && !config.revenuecatAvailable) {
    const err = new BillingEnforcedWithoutRevenueCatError(config.revenuecatMissing);
    log.error(
      { event: "billing_enforced_without_revenuecat", vars: config.revenuecatMissing },
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
  if (!config.revenuecatAvailable) {
    log.warn(
      { event: "revenuecat_not_configured", vars: config.revenuecatMissing },
      `Billing: RevenueCat NOT configured (${config.revenuecatMissing.join(
        ", ",
      )} unset) — POST /api/webhooks/revenuecat and /api/billing/store-sync answer 503`,
    );
  }

  log.info(
    {
      event: "billing_config",
      // PRESENCE, not the values — see this file's header.
      stripe: config.available ? "configured" : "disabled",
      missingVars: config.missing,
      revenuecat: config.revenuecatAvailable ? "configured" : "disabled",
      revenuecatMissingVars: config.revenuecatMissing,
      enforced: config.enforced,
      invalidVars: config.invalid,
    },
    `Billing: stripe ${config.available ? "on" : "off"} · revenuecat ${
      config.revenuecatAvailable ? "on" : "off"
    } · enforcement ${config.enforced ? "ON" : "off"}`,
  );

  return config;
}
