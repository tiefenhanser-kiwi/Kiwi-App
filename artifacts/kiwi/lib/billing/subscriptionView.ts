// Row 9 (1.1) · Stripe S2 Part B — THE ONE DECISION TABLE.
//
// Everything the billing UI decides is decided here, from the payload of
// `GET /api/me/subscription` and a clock: which banner (if any), the days-left
// number in it, which state the paywall sheet opens in, whether the pay-early
// line renders, what the Settings row says, and which of the three
// lapsed-account notices a response has earned.
//
// PURE, AND IN lib/ BECAUSE app/** IS OUTSIDE THE TEST GLOB (D-WS9-164). A
// screen that computed "is the trial nearly over" inline would be a screen whose
// most important branch can never be covered. Every function below is total over
// the five statuses × `enforced` × the date being absent, and the test beside it
// walks that product rather than sampling it.
//
// ── THE BLACKOUT, WHICH IS THE POINT OF THE FILE ─────────────────────────
//
// 🔴 `enforced === false` MEANS NOTHING BILLING-RELATED IS VISIBLE (§2.1), and
// 1.1 ships in exactly that state until Hans flips `BILLING_ENFORCED` on Cloud
// Run after the cutover. So the blackout is not a condition sprinkled over five
// screens — it is the FIRST LINE of `bannerFor`, `sheetStateFor` and
// `shouldFireUpsellMoment`, and the deliberate-break test in the S2 report
// proves a banner cannot render without it.
//
// The Settings row is the single exception the ruling carves out, because a row
// that says "Free trial · ends Oct 11" promises nothing and answers the one
// question a user in a trial actually has.

import {
  BANNER_LAPSED,
  BANNER_LAPSED_CTA,
  BANNER_PAST_DUE,
  BANNER_PAST_DUE_CTA,
  BANNER_TRIAL_CTA,
  MANAGE_STRIPE_ON_WEB,
  NOTICE_FIND_SIMILAR,
  NOTICE_GROCERY_STALE,
  NOTICE_MACROS,
  PREMIUM_TRIAL_ENDED,
  PREMIUM_TRIAL_OPEN,
  SETTINGS_ACTIVE_NO_DATE,
  SETTINGS_MANAGE,
  SETTINGS_PAST_DUE,
  SETTINGS_SUBSCRIBE,
  SETTINGS_TRIAL_ENDED,
  SETTINGS_TRIAL_NO_DATE,
  bannerTrialEnding,
  deleteAccountStoreNotice,
  premiumTrialDaysLeft,
  settingsAnnual,
  settingsCancels,
  settingsMonthly,
  settingsTrialing,
  subscribedInStore,
} from "./copy";

// ── the wire shape ───────────────────────────────────────────────────────

/**
 * The five statuses `GET /me/subscription` can report. This is the EFFECTIVE
 * status: the server derives it on every read (lib/subscriptionService.ts's
 * `effectiveStatus`), so an expired trial arrives as `none` and this client
 * never compares `trialEndsAt` against a clock to decide whether a trial is
 * over. It reads the dates only to say how MANY days are left.
 */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "none"
  | "canceled";

export interface SubscriptionPayload {
  status: SubscriptionStatus;
  planCode: string;
  /** ISO. NULL is a real state — see `trialDaysLeft`. */
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** False until Stripe is configured on the deploy. Gates every BUTTON. */
  billingAvailable: boolean;
  /** Mirrors `BILLING_ENFORCED`. Gates every billing SURFACE but the Settings row. */
  enforced: boolean;
  /**
   * Resub C2 — the pay-early bonus is gone (Hans, October 4). B1 still sends
   * both fields (always 0 / null) because the shipped 1.0 schema required them.
   * OPTIONAL here so either server shape parses, and READ NOWHERE.
   */
  earlyPayBonusDays?: number;
  firstChargeDateIfSubscribedNow?: string | null;
  /**
   * Resub B1 — which rail the row describes: "stripe" | "apple" | "google", or
   * null (a trial, or never paid). A plain string on the wire so a fourth rail
   * cannot fail this schema; `subscriptionSource` narrows it.
   */
  source?: string | null;
  /** RevenueCat's management URL — store rows only, else null. */
  managementUrl?: string | null;
  /**
   * The store twin of `billingAvailable`: RevenueCat is configured on the deploy.
   * Absent (an older server) reads as false — a purchase the server cannot sync
   * is money taken for an account that never unlocks.
   */
  storeBillingAvailable?: boolean;
  /**
   * Whether a Stripe billing account exists for this user, so the Portal
   * link-out can be offered without a guess.
   *
   * ⚠️ ADDED BY S2 (see the report). §2.8 rules that "Manage subscription"
   * appears "when a Stripe subscription exists", and the S1 contract carried no
   * field saying so — the client would have had to infer it from the status,
   * which is wrong in both directions: a `canceled` account still has a portal
   * worth opening (invoices, resubscribe), and an `active` one read before its
   * first webhook does not yet. Optional here so a client running against an
   * older server degrades to the inference rather than failing its schema.
   */
  hasBillingAccount?: boolean;
}

// ── the trial clock ──────────────────────────────────────────────────────

/** The banner's window. Four days, from §2.4. */
export const TRIAL_BANNER_DAYS = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days left in the trial, rounded UP, or null when there is no date to count to.
 *
 * ⚠️ NULL IS A REAL STATE, not a defensive one. `effectiveStatus` keeps an
 * account `trialing` when `trialEndsAt` is NULL — an unbounded trial — and the
 * server reports that as an open finding rather than tightening it, because
 * treating NULL as expired would lock out any account whose timestamp failed to
 * write. So this returns null and `bannerFor` shows nothing: a trial with no end
 * cannot have "3 days left", and inventing a number for it is the one thing
 * worse than staying quiet.
 *
 * ROUNDING UP is what makes the last day read "1 day left" instead of "0 days
 * left". A result at or below zero is possible — a payload read across the
 * expiry boundary — and `bannerFor` declines to render it rather than
 * second-guessing the server's status; the next foreground refetch reports
 * `none` and the lapsed banner takes over.
 */
export function trialDaysLeft(
  sub: Pick<SubscriptionPayload, "trialEndsAt">,
  now: Date,
): number | null {
  if (sub.trialEndsAt === null) return null;
  const ends = new Date(sub.trialEndsAt).getTime();
  if (!Number.isFinite(ends)) return null;
  return Math.ceil((ends - now.getTime()) / DAY_MS);
}

// ── the banner (§2.4) ────────────────────────────────────────────────────

export type BannerKind = "trial_ending" | "lapsed" | "past_due";

export interface BannerView {
  kind: BannerKind;
  text: string;
  ctaLabel: string;
  /**
   * `past_due` is the ONE non-dismissible banner, and the reason is that it is
   * the only one naming a problem the user has to act on to keep the account:
   * the card failed and Stripe is retrying. The other two are offers, and an
   * offer the user has declined must stay declined.
   */
  dismissible: boolean;
}

export interface BannerInput {
  /** null while `GET /me/subscription` has not answered — no banner over a load. */
  sub: SubscriptionPayload | null;
  now: Date;
  /** Per-device dismissals, from storage. `past_due` ignores this set. */
  dismissed: ReadonlySet<BannerKind>;
}

/**
 * Which banner Home shows at the top, or null. ONE AT A TIME by construction:
 * the status is a single value, so the three cases cannot contend — this is a
 * mapping, not a priority list, and there is no ordering bug available to write.
 */
export function bannerFor(input: BannerInput): BannerView | null {
  const { sub, now, dismissed } = input;
  if (sub === null) return null;
  // 🔴 THE BLACKOUT. Deliberate break (1) in the S2 report removes this line.
  if (!sub.enforced) return null;

  if (sub.status === "past_due") {
    // Not dismissible, so `dismissed` is not consulted at all.
    return {
      kind: "past_due",
      text: BANNER_PAST_DUE,
      ctaLabel: BANNER_PAST_DUE_CTA,
      dismissible: false,
    };
  }

  if (sub.status === "none" || sub.status === "canceled") {
    if (dismissed.has("lapsed")) return null;
    return {
      kind: "lapsed",
      text: BANNER_LAPSED,
      ctaLabel: BANNER_LAPSED_CTA,
      dismissible: true,
    };
  }

  if (sub.status === "trialing") {
    if (dismissed.has("trial_ending")) return null;
    const daysLeft = trialDaysLeft(sub, now);
    // Null (unbounded trial), already expired (a payload read across the
    // boundary), or still comfortably inside the trial — all three are silence.
    if (daysLeft === null) return null;
    if (daysLeft < 1 || daysLeft > TRIAL_BANNER_DAYS) return null;
    return {
      kind: "trial_ending",
      text: bannerTrialEnding(daysLeft),
      ctaLabel: BANNER_TRIAL_CTA,
      dismissible: true,
    };
  }

  // `active` — nothing to say on Home.
  return null;
}

// ── the sheet (§2.2) ─────────────────────────────────────────────────────

/**
 * The paywall sheet's two states. `past_due` is absent on purpose: the ruling
 * gives it a banner with "Manage payment", not a sheet, because the user already
 * pays us and the thing to fix is a card, not a decision.
 */
export type SheetState = "trialing" | "lapsed";

export interface SheetStateOptions {
  /**
   * Skip the `enforced` blackout. Passed by exactly ONE caller: the 402
   * interception in lib/api/client.ts.
   *
   * 🔴 §2.7's rule, and it reads backwards until you see why: "when `enforced`
   * is false a 402 cannot occur; if one arrives anyway, log it and show the
   * sheet — the server is the authority." A 402 IS the server enforcing. Our
   * copy of the flag came from an earlier read and is therefore the stale half
   * of the disagreement, so the refusal wins and the user is told what happened
   * rather than watching an action fail silently.
   */
  ignoreEnforcement?: boolean;
}

export function sheetStateFor(
  sub: SubscriptionPayload | null,
  opts: SheetStateOptions = {},
): SheetState | null {
  if (sub === null) {
    // A 402 with no subscription payload yet is still a refusal we must explain,
    // and "your trial has ended" is the honest reading of a server that said no.
    return opts.ignoreEnforcement === true ? "lapsed" : null;
  }
  if (!sub.enforced && opts.ignoreEnforcement !== true) return null;

  if (sub.status === "trialing") return "trialing";
  if (sub.status === "none" || sub.status === "canceled") return "lapsed";
  // `active` / `past_due`: no sheet from a status read.
  //
  // But a 402 for one of them is a contradiction — the server refused an account
  // its own snapshot calls entitled — which means OUR status is stale, not that
  // the server is wrong. The paywall is the honest surface for a refusal, and the
  // foreground refetch the sheet triggers is what corrects the status.
  return opts.ignoreEnforcement === true ? "lapsed" : null;
}


// ── Settings → Subscription (§2.8) ──────────────────────────────────────

export interface SettingsRowView {
  /** The status line. Always a complete, true sentence fragment. */
  statusLine: string;
  /** Opens the sheet. Absent while subscribed, or while Stripe is unconfigured. */
  subscribe: boolean;
  /** Link-out to the Stripe Portal. */
  manage: boolean;
  subscribeLabel: string;
  manageLabel: string;
}

/**
 * Whether the Portal is worth offering.
 *
 * Prefers the server's `hasBillingAccount` and falls back to the status when an
 * older server omits it. The fallback includes `canceled` deliberately: a
 * cancelled subscriber still has invoices and a resubscribe path behind the
 * Portal, and `409 no_billing_account` is handled at the call site for the case
 * where the guess is wrong.
 */
export function canManageBilling(sub: SubscriptionPayload): boolean {
  if (typeof sub.hasBillingAccount === "boolean") return sub.hasBillingAccount;
  return (
    sub.status === "active" ||
    sub.status === "past_due" ||
    sub.status === "canceled"
  );
}

/** True while the account is not paying — i.e. "Subscribe" is the right verb. */
function isUnsubscribed(status: SubscriptionStatus): boolean {
  return status === "trialing" || status === "none" || status === "canceled";
}

function settingsStatusLine(sub: SubscriptionPayload): string {
  // `cancelAtPeriodEnd` outranks the plan line: "renews Nov 1" and "cancels
  // Nov 1" are the same date and opposite facts, and the second is the one the
  // user needs. Checked first so no plan branch can shadow it.
  if (sub.cancelAtPeriodEnd && sub.currentPeriodEnd !== null) {
    return settingsCancels(sub.currentPeriodEnd);
  }
  switch (sub.status) {
    case "trialing":
      return sub.trialEndsAt === null
        ? SETTINGS_TRIAL_NO_DATE
        : settingsTrialing(sub.trialEndsAt);
    case "active": {
      if (sub.currentPeriodEnd === null) return SETTINGS_ACTIVE_NO_DATE;
      // planCode is the server's word for which price is on the subscription.
      // Anything neither monthly nor annual (including the `free` default a
      // never-subscribed row carries) gets the plan-agnostic line rather than a
      // wrong one.
      if (sub.planCode === "monthly") return settingsMonthly(sub.currentPeriodEnd);
      if (sub.planCode === "annual") return settingsAnnual(sub.currentPeriodEnd);
      return SETTINGS_ACTIVE_NO_DATE;
    }
    case "past_due":
      return SETTINGS_PAST_DUE;
    case "none":
    case "canceled":
      return SETTINGS_TRIAL_ENDED;
  }
}

/**
 * The Settings row, or null when the row is hidden entirely.
 *
 * Hidden only when there is genuinely nothing to say AND nothing to offer:
 * `billingAvailable` false and `enforced` false — the pre-cutover deploy, where
 * a "Subscription" row would raise a question the app cannot answer. This is the
 * ONE surface that survives the `enforced` blackout (§2.1).
 */
export function settingsRowFor(
  sub: SubscriptionPayload | null,
): SettingsRowView | null {
  if (sub === null) return null;
  if (!sub.billingAvailable && !sub.enforced) return null;
  return {
    statusLine: settingsStatusLine(sub),
    // Both buttons need Stripe: a button whose only outcome is a 503 is worse
    // than no button, and `billingAvailable` is exactly the field that says so.
    subscribe: sub.billingAvailable && isUnsubscribed(sub.status),
    manage: sub.billingAvailable && canManageBilling(sub),
    subscribeLabel: SETTINGS_SUBSCRIBE,
    manageLabel: SETTINGS_MANAGE,
  };
}

// ── the lapsed-account notices (§2.6) ───────────────────────────────────
//
// Each reads ONE server field and keys on the entitlement value ALONE. That is
// the whole ruling: a reconcile that FAILED and a reconcile that was SKIPPED
// for entitlement both leave a stale list, but only one of them is the user's
// to fix, and telling someone to upgrade because our AI call threw would be a
// sales pitch dressed as an explanation.

/** The value the server sends when the gate, not a failure, skipped the work. */
export const SKIPPED_FOR_SUBSCRIPTION = "subscription_required";

/**
 * `GET /grocery-lists/:id`'s `reconcileSkipped`, or the 402 from
 * `POST /plans/:id/generate-grocery-list`, → the stale-list notice or null.
 *
 * `"error"` returns NULL. Deliberate break (5) in the S2 report makes the server
 * send `"error"` for the entitlement skip and watches this go quiet.
 */
export function groceryStaleNotice(
  reconcileSkipped: string | null | undefined,
): string | null {
  return reconcileSkipped === SKIPPED_FOR_SUBSCRIPTION
    ? NOTICE_GROCERY_STALE
    : null;
}

/** `POST /meals/find-similar`'s `aiSkipped` → the cuisine-matches line or null. */
export function findSimilarNotice(
  aiSkipped: string | null | undefined,
): string | null {
  return aiSkipped === SKIPPED_FOR_SUBSCRIPTION ? NOTICE_FIND_SIMILAR : null;
}

/**
 * The statuses the server's `isEntitled` allows to spend
 * (api-server/src/lib/subscriptionService.ts's ENTITLED_STATUSES).
 *
 * ⚠️ MIRRORED, WHICH IS A COST WORTH NAMING. The server is the authority and this
 * client must never gate anything on its own copy — every real refusal is a 402 or
 * a `*Skipped` field. This set exists for ONE job the wire cannot do: the macro
 * notice (below) has no per-response flag to read on a screen that is only
 * DISPLAYING stored figures, so it has to answer "would a refresh be refused?"
 * from the status. If the server's set ever changes, the failure mode here is a
 * notice shown or hidden one status too early — not a wrong entitlement decision.
 */
const ENTITLED_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  "trialing",
  "active",
  "past_due",
]);

/**
 * The macros notice (§2.6), or null.
 *
 * 🔴 THE ONE NOTICE WITH NO RESPONSE FIELD BEHIND IT, and the reason is worth
 * reading before changing it. The other two answer "did this response's work get
 * skipped?", which a server field can say. This one answers a question about a
 * FIGURE ALREADY ON SCREEN: the plan's daily averages and a meal's macro strip
 * render from stored columns, and no request was made to carry a flag. The
 * `macrosSkipped` field S2 added covers the SAVE moment; it cannot cover a screen
 * the user opened a week later.
 *
 * So this one is derived from the status, and it is honest about what it claims:
 * not "this figure is wrong" but "a refresh of it is a premium feature". The
 * stored figures stay on screen either way — that is the "keep what exists"
 * clause, and it is why a wrong answer here is a redundant sentence rather than a
 * lie.
 *
 * Null while `enforced` is false: no refresh would be refused, so there is nothing
 * to explain.
 */
export function macrosNoticeFor(sub: SubscriptionPayload | null): string | null {
  if (sub === null) return null;
  if (!sub.enforced) return null;
  return ENTITLED_STATUSES.has(sub.status) ? null : NOTICE_MACROS;
}

// ── Resub C2 — the store rail ─────────────────────────────────────────────
//
// Apple rejected 1.0 under 3.1.1: a subscription existed that could not be
// bought in the app. iOS and Android now sell through the App Store and Google
// Play (RevenueCat); the web keeps Stripe. Every "which rail, which button,
// which sentence" question is answered below, from the payload and the
// platform, so the screens stay renderers.

export type BillingSource = "stripe" | "apple" | "google";
export type StoreSource = "apple" | "google";

/** The payload's `source`, narrowed. Anything unrecognised reads as none. */
export function subscriptionSource(sub: SubscriptionPayload | null): BillingSource | null {
  const s = sub?.source;
  return s === "stripe" || s === "apple" || s === "google" ? s : null;
}

/** The store a platform sells through: iOS → the App Store, Android → Google Play. */
export function platformStore(platform: string): StoreSource | null {
  if (platform === "ios") return "apple";
  if (platform === "android") return "google";
  return null;
}

/** Where a store subscriber manages, when RevenueCat sent no managementUrl. */
export const STORE_SUBSCRIPTIONS_URL: Readonly<Record<StoreSource, string>> = {
  apple: "https://apps.apple.com/account/subscriptions",
  google: "https://play.google.com/store/account/subscriptions",
};

/** True while the account pays — "Subscribe" is no longer the right verb. */
export function isPayingStatus(status: SubscriptionStatus): boolean {
  return !isUnsubscribed(status);
}

/**
 * Profile's manage action, by source × platform (the C2 §3 table):
 *
 *   apple / google · native → open managementUrl, else the store's page
 *   apple / google · web    → a sentence: manage it in the store
 *   stripe         · native → a sentence, NO link (a Stripe link-out in the
 *                             app is itself a 3.1.1 problem)
 *   stripe         · web    → the Portal, gated exactly as before
 *   none           · native → nothing here; the Kiwi Premium row covers it
 *   none           · web    → as before (settingsRowFor's Portal button)
 */
export type ManageAction =
  | { kind: "store_link"; url: string; label: string }
  | { kind: "store_text"; text: string }
  | { kind: "stripe_text"; text: string }
  | { kind: "stripe_portal"; label: string };

export function manageActionFor(
  platform: string,
  sub: SubscriptionPayload | null,
): ManageAction | null {
  if (sub === null) return null;
  const native = platform !== "web";
  const source = subscriptionSource(sub);
  if (source === "apple" || source === "google") {
    if (!native) return { kind: "store_text", text: subscribedInStore(source) };
    const url = sub.managementUrl && sub.managementUrl.length > 0
      ? sub.managementUrl
      : STORE_SUBSCRIPTIONS_URL[source];
    return { kind: "store_link", url, label: SETTINGS_MANAGE };
  }
  if (source === "stripe") {
    if (native) return { kind: "stripe_text", text: MANAGE_STRIPE_ON_WEB };
    return sub.billingAvailable && canManageBilling(sub)
      ? { kind: "stripe_portal", label: SETTINGS_MANAGE }
      : null;
  }
  if (native) return null;
  return settingsRowFor(sub)?.manage ? { kind: "stripe_portal", label: SETTINGS_MANAGE } : null;
}

/**
 * Profile → "Kiwi Premium" (C2 §2). The App Review account is on a 14-day
 * trial, so the 402 paywall never appears for it; this row is the purchase
 * entry it can reach. Native only (the web keeps its Subscribe button), for
 * any account that is not paying, trial included — and deliberately NOT behind
 * the `enforced` blackout: 3.1.1 is about being able to buy, not about being
 * made to.
 */
export interface PremiumRowView {
  line: string;
  /** The sheet state the row opens, passed explicitly so the blackout cannot swallow it. */
  sheet: SheetState;
}

export function premiumRowFor(
  platform: string,
  sub: SubscriptionPayload | null,
  now: Date,
): PremiumRowView | null {
  if (platform === "web" || sub === null) return null;
  if (isPayingStatus(sub.status)) return null;
  if (sub.status === "trialing") {
    const daysLeft = trialDaysLeft(sub, now);
    return {
      line: daysLeft !== null && daysLeft >= 1 ? premiumTrialDaysLeft(daysLeft) : PREMIUM_TRIAL_OPEN,
      sheet: "trialing",
    };
  }
  return { line: PREMIUM_TRIAL_ENDED, sheet: "lapsed" };
}

/** Profile's Subscription card, whole. Null hides it. */
export interface SubscriptionCardView {
  statusLine: string;
  premium: PremiumRowView | null;
  manage: ManageAction | null;
  /** Web only, unchanged: the Stripe Subscribe button that opens the sheet. */
  subscribe: boolean;
  subscribeLabel: string;
}

export function subscriptionCardFor(
  platform: string,
  sub: SubscriptionPayload | null,
  now: Date,
): SubscriptionCardView | null {
  if (sub === null) return null;
  const manage = manageActionFor(platform, sub);
  if (platform === "web") {
    const row = settingsRowFor(sub);
    if (row === null && manage === null) return null;
    return {
      statusLine: settingsStatusLine(sub),
      premium: null,
      manage,
      subscribe: row?.subscribe ?? false,
      subscribeLabel: SETTINGS_SUBSCRIBE,
    };
  }
  // Native: always shown — the Kiwi Premium row must be reachable in the trial.
  return {
    statusLine: settingsStatusLine(sub),
    premium: premiumRowFor(platform, sub, now),
    manage,
    subscribe: false,
    subscribeLabel: SETTINGS_SUBSCRIBE,
  };
}

/**
 * BUG-356 — deleting the account does not stop a store subscription. DELETE /me
 * cancels Stripe; only the user can cancel in the App Store or Google Play. So
 * an entitled store subscriber is told BEFORE confirming, with the manage
 * action beside it. Never a block: deletion proceeds when they confirm.
 *
 * Keyed on the SOURCE, not the platform — an iPhone subscriber deleting from
 * the web is still billed by the App Store. Silent when the subscription is
 * already set to end (`cancelAtPeriodEnd`): it will not renew, and the
 * sentence would be false.
 */
export interface DeleteAccountNoticeView {
  text: string;
  manage: ManageAction;
}

export function deleteAccountNoticeFor(
  platform: string,
  sub: SubscriptionPayload | null,
): DeleteAccountNoticeView | null {
  if (sub === null) return null;
  const source = subscriptionSource(sub);
  if (source !== "apple" && source !== "google") return null;
  if (!ENTITLED_STATUSES.has(sub.status) || sub.cancelAtPeriodEnd) return null;
  const manage = manageActionFor(platform, sub);
  if (manage === null) return null;
  return { text: deleteAccountStoreNotice(source), manage };
}

/**
 * Whether this build may take money in the store. All three must hold, and the
 * sheet shows no buy button otherwise: a RevenueCat key on the build, RevenueCat
 * configured on the server (`storeBillingAvailable` — without it store-sync and
 * the webhook 503, and the purchase would never unlock the account), and an
 * offering, which the sheet checks once it has loaded.
 */
export function storeBillingReady(input: {
  platform: string;
  keyPresent: boolean;
  sub: SubscriptionPayload | null;
}): boolean {
  if (platformStore(input.platform) === null) return false;
  return input.keyPresent && input.sub?.storeBillingAvailable === true;
}
