// Row 9 (1.1) · Stripe S1 Part C — ENTITLEMENT, MADE REAL.
//
// This file was a stub whose `can()` always returned `{ allowed: true }`
// (D-WS9-258: no billing surface in 1.0, every account effectively premium —
// the state the store reviewers see). It now resolves real billing state, and
// it still returns `{ allowed: true }` for everyone until `BILLING_ENFORCED` is
// set. That is the point: S1 can deploy, Stripe can be commissioned in test
// mode, the webhook can be exercised against live events, and nobody is locked
// out by accident. Flipping the switch is a Cloud Run env change Hans makes on
// purpose, after the cutover SQL.
//
// ── THE THREE RULES, AND WHERE EACH ONE LIVES ────────────────────────────
//
//   1. `effectiveStatus()` — `none` IS DERIVED, NEVER SCHEDULED. A row with
//      `status = trialing` and `trialEndsAt` in the past *is* `none`, computed
//      on read. There is no nightly job, so no row is ever stale and no cron
//      failure can silently hand out free AI. Pure function, tested by clock.
//
//   2. `ENTITLEMENTS` — ONE TABLE, and it is one table on purpose (D-WS9-270
//      §4a). Hans asked whether some fraction-of-a-cent calls could stay on for
//      a lapsed account. The ruling was no — "No Pay / No Trial = No AI" — but
//      the ruling came with an instruction: make revisiting it a one-line
//      change. Every key's price is a value in this record. Making
//      `recipe_scale_ai` free later is editing one word in one place, with no
//      store review and no client change.
//
//   3. `can()` — the gate, and it is checked BEFORE the spend at every call
//      site, never after. A 402 that arrives after the model call has been paid
//      for is a bill with a refusal attached.
//
// ── WHY THIS FAILS OPEN WHEN requireAuth FAILS CLOSED ────────────────────
//
// 🔴 The asymmetry is deliberate and it is the first thing a reader will
// question. `middleware/auth.ts` answers 503 when its revocation lookup throws,
// with the reasoning "a guard that opens when its datastore hiccups is not a
// guard, and the failure mode it would restore is account takeover".
//
// Entitlement is not that kind of guard. It guards REVENUE, not access to
// someone else's account. The two failure modes are:
//
//   fail closed → a Neon blip paywalls the entire paying user base at once,
//                 mid-cook, and every one of them gets "upgrade required" for
//                 a subscription they already bought.
//   fail open   → some users get AI they have not paid for, for the length of
//                 the blip, bounded by the same AI_* spend ceilings as everyone
//                 else (D-WS9-240), with an `error` line per occurrence.
//
// The second is cheaper in money and very much cheaper in trust, so a thrown
// query ALLOWS and logs loudly. Same call for a missing Subscription row: it is
// written in the same transaction as the User (lib/authAccount.ts
// `createAccountInTx`), so its absence is not a state a real signup reaches —
// it is corruption, and the right response to corruption is to serve the person
// in front of you and shout.

import type { PrismaClient, SubscriptionStatus } from "@prisma/client";

import { readBillingConfig, type BillingConfig } from "./billing/config";
import { logger } from "./logger";
import { prisma as productionPrisma } from "./prisma";

// ── the keys ─────────────────────────────────────────────────────────────

/**
 * Every entitlement the server checks. NAMED BY WHAT THE USER DID, not by which
 * model or prompt runs — a key outlives the prompt behind it (the registry has
 * already retired several) and a route named after its implementation is a key
 * that has to be renamed when the implementation changes.
 *
 * The first ten predate this block. The seven after them were found by
 * inventorying every caller that reaches the function which writes an
 * `LLMCallLog` row — `lib/ai/runAICall.ts`, `lib/ai/streamPlanCandidates.ts` and
 * `lib/images/imageGenerator.ts` — and then walking up to the enclosing route
 * handler. Seven routes were spending model calls with NO entitlement check at
 * all; see the table in ENTITLEMENTS below.
 */
export type EntitlementKey =
  // ── the ten that already existed ──
  | "kitchen_wizard_set_preferences"
  | "kitchen_wizard_just_say"
  | "kitchen_wizard_cook_what_i_have_now"
  | "meal_builder_text_input"
  | "kitchen_wizard_one_meal"
  | "prep_the_week_orchestrated"
  | "grocery_ordering"
  | "unlimited_plans"
  | "ad_free"
  | "find_similar_ai"
  // ── S1: the seven the inventory found unguarded ──
  | "recipe_import_ai"
  | "recipe_scale_ai"
  | "grocery_list_generate"
  | "grocery_list_reconcile"
  | "plan_macro_recalc"
  | "meal_macro_estimate"
  | "plan_finalize_steps";

/**
 * 🔴 THE ENTITLEMENT MATRIX — ONE TABLE, ONE WORD PER KEY (D-WS9-270 §4a).
 *
 * "paid" = requires an entitled status. "free" = available to a lapsed account.
 *
 * THE RULE THAT DECIDES EVERY ROW: does it spend a model call? If yes it is
 * paid, without exception. The ruling is "No Pay / No Trial = No AI", and its
 * reasoning is that the app already functions without AI — the cookbook, every
 * saved plan and recipe with its steps, the grocery list (deterministic from the
 * plan once generated), Instacart and catalog search all work in the read-only
 * state — while the cheap calls are the DOOR to the expensive ones: a swap makes
 * a meal that needs steps, which re-does the list.
 *
 * The two `free` AI-adjacent entries are not exceptions to that rule, they are
 * outside it:
 *
 *   · `grocery_ordering` — the Instacart handoff is a retailer link-out. It
 *     makes NO model call (verified: routes/groceryLists.ts's instacart-link
 *     handler reaches lib/retailers/*, which never imports the AI layer), and
 *     Kiwi EARNS on it. Paywalling the one feature that pays us would be
 *     remarkable.
 *   · `ad_free` — not a feature that spends anything; a property of the account.
 *
 * `unlimited_plans` is paid per the ruling. It has no call site yet — the plan
 * count is unlimited for everyone today — and it is kept in the union rather
 * than deleted because the PRD names it and a key that has to be re-invented is
 * a key that gets re-invented with a different name.
 *
 * ⚠️ TWO KEYS DENY GRACEFULLY INSTEAD OF WITH A 402, and both predate or follow
 * the read-only ruling rather than contradicting it:
 *   · `find_similar_ai` → returns the cuisine-only fallback in the same
 *     response shape (routes/meals.ts, which has done this since WS6).
 *   · `grocery_list_reconcile` → serves the list's prior persisted state
 *     un-stamped, exactly as a reconcile FAILURE already does.
 * In both cases the model call does not happen, which is the whole objective;
 * answering 402 to a READ would break "read-only, not locked".
 */
export const ENTITLEMENTS: Record<EntitlementKey, "paid" | "free"> = {
  // route → key                                                  paid/free
  // POST /wizard/shelf · /wizard/build-plans · /candidates/:id/expand
  kitchen_wizard_set_preferences: "paid",
  // POST /wizard/tell-kiwi
  kitchen_wizard_just_say: "paid",
  // (no call site — PRD §6.4 mode, not yet built)
  kitchen_wizard_cook_what_i_have_now: "paid",
  // POST /builder/meals/parse-text · /builder/dishes/parse-text
  meal_builder_text_input: "paid",
  // (no call site — PRD mode, not yet built)
  kitchen_wizard_one_meal: "paid",
  // POST /plans/:id/prep-week
  prep_the_week_orchestrated: "paid",
  // POST /grocery-lists/:id/instacart-link — NO model call, and it pays us.
  grocery_ordering: "free",
  // (no call site — plan count is unlimited for everyone today)
  unlimited_plans: "paid",
  // (no call site — not a spending feature)
  ad_free: "free",
  // POST /meals/find-similar — denies to the cuisine-only fallback, not 402.
  find_similar_ai: "paid",
  // POST /recipes/import-url · /recipes/import-image · /recipes/import-text
  recipe_import_ai: "paid",
  // POST /recipes/scale
  recipe_scale_ai: "paid",
  // POST /plans/:id/generate-grocery-list — Haiku gap-fill + Sonnet final pass.
  grocery_list_generate: "paid",
  // GET /grocery-lists/:id — the reconcile-on-read. Skips, never 402s.
  grocery_list_reconcile: "paid",
  // POST /plans/:id/recalc-macros
  plan_macro_recalc: "paid",
  // POST /me/meals · POST /me/dishes — the BUG-274 macros-at-save pre-pass.
  meal_macro_estimate: "paid",
  // POST /wizard/drafts/:id/activate · /wizard/drafts/:id/save — finalize-steps.
  plan_finalize_steps: "paid",
};

/**
 * The statuses that carry entitlement. `past_due` IS ENTITLED, deliberately:
 * Stripe's dunning window (Smart Retries, 7 days) is the grace period, Kiwi
 * keeps no second timer, and cutting a subscriber off on the first failed card
 * retry — which is usually an expiry, not a decision — would lose the customer
 * that dunning exists to keep.
 */
export const ENTITLED_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  "trialing",
  "active",
  "past_due",
]);

/** The one code the clients key on to open the paywall. */
export const SUBSCRIPTION_REQUIRED_CODE = "subscription_required";

// ── rule 1: the derived status ───────────────────────────────────────────

/**
 * The stored status, except that an EXPIRED TRIAL is `none`.
 *
 * Pure, and the only place the trial clock is read. Everything else in the
 * server asks this rather than comparing `trialEndsAt` itself, so there is
 * exactly one definition of "the trial is over".
 *
 * ⚠️ `trialing` WITH A NULL `trialEndsAt` STAYS `trialing` — an unbounded trial.
 * That is the ruling applied literally ("`trialing` with `trialEndsAt < now` →
 * `none`; everything else is the stored status"), and NULL is not `< now`. It is
 * safe today because `createAccountInTx` writes `trialEndsAt = now + 14 d` in
 * the same transaction as the row, for both the password and the OAuth lane, so
 * no real signup produces it. It is reported as an open finding rather than
 * quietly tightened here: treating NULL as expired would lock out any account
 * whose timestamp failed to write, which is the worse of the two errors, and
 * choosing between them is Hans's call, not this block's. `subscriptionEntitlement.test.ts`
 * pins the current behaviour so it stays deliberate.
 */
export function effectiveStatus(
  row: { status: SubscriptionStatus; trialEndsAt: Date | null },
  now: Date,
): SubscriptionStatus {
  if (
    row.status === "trialing" &&
    row.trialEndsAt !== null &&
    row.trialEndsAt.getTime() < now.getTime()
  ) {
    return "none";
  }
  return row.status;
}

/** Whether a status may spend. Trivial, but named so no call site inlines it. */
export function isEntitled(status: SubscriptionStatus): boolean {
  return ENTITLED_STATUSES.has(status);
}

// ── the service ──────────────────────────────────────────────────────────

export interface EntitlementResult {
  allowed: boolean;
  reason?: string;
  /**
   * Present only on a denial. The clients key on this, not on the prose in
   * `reason` — S2 opens the paywall sheet from one check at the fetch layer.
   */
  code?: string;
  /** The status the decision was made on. For the log and the client's banner. */
  status?: SubscriptionStatus;
}

export interface SubscriptionService {
  can(userId: string, feature: EntitlementKey): Promise<EntitlementResult>;
}

/**
 * The 402 body every paid-gate denial sends. One function so ten call sites
 * cannot drift into ten slightly different shapes.
 *
 * ⚠️ `error: "upgrade required"` IS KEPT. The eight gates that predate this
 * block have sent that exact string since WS6 and the clients may read it; `code`
 * is ADDED beside it, and `code` is what S2 keys on. Widening a response is safe
 * in a way that replacing one is not — the mobile build in the stores right now
 * has never heard of `code`.
 */
export function subscriptionRequiredBody(ent: EntitlementResult, fallbackReason: string): {
  error: string;
  code: string;
  reason: string;
} {
  return {
    error: "upgrade required",
    code: ent.code ?? SUBSCRIPTION_REQUIRED_CODE,
    reason: ent.reason ?? fallbackReason,
  };
}

/** The columns entitlement and `GET /me/subscription` both need. */
export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  planCode: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  earlyPayBonusApplied: boolean;
}

type PrismaLike = Pick<PrismaClient, "subscription">;

/**
 * Read the row and derive the status. Returns `null` when there is NO ROW —
 * the caller decides what that means, because the two callers decide
 * differently: `can()` fails open (see the header), while
 * `GET /me/subscription` reports `none` so the client shows a paywall rather
 * than a spinner.
 */
export async function readSubscriptionSnapshot(
  prisma: PrismaLike,
  userId: string,
): Promise<SubscriptionSnapshot | null> {
  const row = await prisma.subscription.findUnique({
    where: { userId },
    select: {
      status: true,
      planCode: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      earlyPayBonusApplied: true,
    },
  });
  return row ?? null;
}

export interface SubscriptionServiceDeps {
  prisma?: PrismaLike;
  /**
   * Read per call rather than captured at construction, so flipping
   * `BILLING_ENFORCED` on Cloud Run takes effect on the new revision without
   * any import-order subtlety about when this module was first evaluated.
   */
  readConfig?: () => BillingConfig;
  /** Injected in tests so the clock is not the wall. */
  now?: () => Date;
}

export function createSubscriptionService(
  deps: SubscriptionServiceDeps = {},
): SubscriptionService {
  const prisma = deps.prisma ?? productionPrisma;
  const readConfig = deps.readConfig ?? (() => readBillingConfig());
  const now = deps.now ?? (() => new Date());

  return {
    async can(userId, feature) {
      // ── the flag, checked FIRST and cheaply ──
      //
      // Enforcement off means no query at all. That keeps today's behaviour
      // byte-identical in cost as well as in outcome: before this block `can()`
      // was a function call that returned a literal, and with the flag unset it
      // still is. No route pays a round trip for a check that cannot deny.
      const config = readConfig();
      if (!config.enforced) return { allowed: true };

      // A `free` key is free whether or not the flag is on.
      if (ENTITLEMENTS[feature] === "free") return { allowed: true };

      let snapshot: SubscriptionSnapshot | null;
      try {
        snapshot = await readSubscriptionSnapshot(prisma, userId);
      } catch (err) {
        // FAIL OPEN. See the header for why this differs from requireAuth.
        logger.error(
          { event: "entitlement_lookup_failed", userId, feature, err },
          "Entitlement lookup threw — ALLOWING the call (billing gates fail open; a datastore blip must not paywall the paying user base)",
        );
        return { allowed: true };
      }

      if (snapshot === null) {
        // Corruption, not a real signup state — the row is written in the same
        // transaction as the User. Serve the person, shout in the log.
        logger.error(
          { event: "entitlement_no_subscription_row", userId, feature },
          "No Subscription row for an authenticated user — ALLOWING the call. The row is created in the same transaction as the User, so this is data corruption, not a signup path",
        );
        return { allowed: true };
      }

      const status = effectiveStatus(snapshot, now());
      if (isEntitled(status)) return { allowed: true, status };

      // ── the opportunistic rewrite (§2.2) ──
      //
      // The stored value is brought in line with the derived one, and it can
      // only ever happen HERE, on the deny path: an entitled user returned
      // above, so `status` differing from `snapshot.status` means the trial has
      // lapsed. A failed write changes nothing — the status is derived on every
      // read, so the next call re-derives it. That is why this is awaited but
      // its failure is swallowed: correctness does not depend on it, only tidy
      // rows do.
      if (status !== snapshot.status) {
        try {
          await (prisma as PrismaClient).subscription.update({
            where: { userId },
            data: { status },
          });
        } catch (err) {
          logger.warn(
            { event: "entitlement_status_rewrite_failed", userId, status, err },
            "Could not persist the derived lapsed status — harmless, it is re-derived on every read",
          );
        }
      }

      return {
        allowed: false,
        code: SUBSCRIPTION_REQUIRED_CODE,
        status,
        reason:
          status === "canceled"
            ? "Your Kiwi subscription has ended. Resubscribe to plan and cook with Kiwi again."
            : "Your free trial has ended. Subscribe to keep planning and cooking with Kiwi.",
      };
    },
  };
}

/**
 * Production binding. Route factories take a `subscriptionService` dep and
 * default to this, exactly as they did when it was the stub — all eight existing
 * call sites are unchanged, only the behaviour behind them is.
 */
export const subscriptionService: SubscriptionService = createSubscriptionService();
