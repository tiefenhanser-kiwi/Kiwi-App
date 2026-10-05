// Row 9 (1.1) · Stripe S2 — EVERY BILLING STRING, IN ONE FILE.
//
// 🔴 HANS OWNS THIS COPY. The ruling that produced this file is explicit about
// why it exists: "put every string in ONE file so he can rewrite without a
// hunt." So nothing below is composed at a call site, and nothing below is
// assembled from fragments — the three lines that carry a number or a date are
// FUNCTIONS taking that value, not templates a screen fills in. A screen that
// needed to build a sentence would be a screen that owned a sentence.
//
// The report's copy table lists every export here with where it appears. If you
// are changing wording, this file and that table are the whole surface.
//
// ── WHAT IS NOT HERE, DELIBERATELY ───────────────────────────────────────
//
// The three lapsed-account notices each end with the SAME sentence — "Upgrade to
// get unlimited access to all features." — and it is written out three times
// rather than factored into an UPGRADE_TAIL constant. A shared tail is a shared
// edit: re-wording the grocery notice would silently re-word the macro one. Copy
// Hans owns is copy that must be editable one line at a time.

import { formatDate } from "@/lib/date";

// ── the paywall / upsell sheet (§2.2) ───────────────────────────────────

/** The upsell, shown to a TRIALING account. */
export const SHEET_TRIALING_TITLE = "Keep every week this easy";

/** The paywall, shown to a `none` / `canceled` account. */
export const SHEET_LAPSED_TITLE = "Your free trial has ended";
export const SHEET_LAPSED_BODY =
  "Everything you saved is still here. Subscribe to keep planning with Kiwi.";

/**
 * The six benefits, from the Test Kitchen door sheet (lib/guest/doors.ts's
 * DOOR_UNLOCKS).
 *
 * ⚠️ FIVE OF THE SIX ARE BYTE-IDENTICAL TO THE DOOR SHEET AND ONE IS NOT. The
 * door's first line is "Save, edit and re-use this plan" — written for a visitor
 * looking AT a plan they just built. This sheet opens from Home, from a 402, and
 * from three upsell moments, where "this plan" has no referent at all. So the
 * first line is pluralised here and the other five are quoted exactly; the test
 * beside this file asserts that split, so a future edit to either list surfaces
 * as a failure rather than as drift.
 *
 * They are COPIED rather than imported because the ruling is "every string in
 * ONE file". An import would put five of Hans's strings somewhere else.
 */
export const SHEET_BENEFITS = [
  "Save, edit and re-use your plans",
  "Unlimited plans",
  "The grocery list and online ordering",
  "Your own meals",
  "Prep & Cook — the order to cook things in",
  "Find and share recipes",
] as const;

export const SHEET_PRICE_MONTHLY = "$9.99 / month";
export const SHEET_PRICE_ANNUAL = "$99.99 / year — 2 months free";
export const SHEET_SECONDARY = "Not now";

// Resub C2 — the pay-early bonus is gone on every platform (Hans, October 4:
// subscribing during the trial bills at purchase). Its line is gone with it; the
// trialing sheet says the one true thing instead.
export const SHEET_BILLING_STARTS_TODAY = "Subscribe now and billing starts today.";

// ── the in-app purchase sheet, iOS and Android (Resub C2) ───────────────
//
// Apple 3.1.1: a subscription must be buyable in the app, through the store.
// Apple 3.1.2: the sheet itself carries what the subscription includes, its
// price per period, how renewal and cancellation work, and the Terms / Privacy
// links. Web keeps Stripe and none of these strings.

export const SHEET_INCLUDES_HEADING = "Kiwi Premium includes";

/** One package button: the store's localized price and its period. */
export function storePriceLabel(priceString: string, period: "month" | "year"): string {
  return `${priceString} / ${period}`;
}

/** The price-per-period line of the 3.1.2 terms. Either price may be missing. */
export function storeTermsPrices(monthly: string | null, annual: string | null): string {
  if (monthly && annual) {
    return `Kiwi Premium is a subscription: ${monthly} per month or ${annual} per year.`;
  }
  if (monthly) return `Kiwi Premium is a subscription: ${monthly} per month.`;
  if (annual) return `Kiwi Premium is a subscription: ${annual} per year.`;
  return "Kiwi Premium is a subscription.";
}

/** The renewal paragraph of the 3.1.2 terms, with the store named per platform. */
export function storeTermsPayment(store: "apple" | "google"): string {
  const account = store === "apple" ? "Apple ID" : "Google Play account";
  const settings = store === "apple" ? "App Store" : "Google Play";
  return `Payment is charged to your ${account} at confirmation. The subscription renews automatically unless cancelled at least 24 hours before the end of the current period. Manage or cancel any time in your ${settings} settings.`;
}

export const SHEET_TERMS_LINK = "Terms of Use";
export const SHEET_PRIVACY_LINK = "Privacy Policy";
export const SHEET_RESTORE = "Restore Purchases";
export const SHEET_LOADING_PRICES = "Loading prices…";
/** No key on this build, no RevenueCat on the server, or no offering. No buy buttons. */
export const SHEET_STORE_UNAVAILABLE =
  "Purchases aren't available right now. Please try again later.";
/** Between the store's receipt and Kiwi's store-sync answer. No buy buttons. */
export const SHEET_CONFIRMING = "Purchase received — confirming it with Kiwi…";
/** store-sync kept failing. The money is taken; the next step is a retry, never a re-buy. */
export const SHEET_CONFIRM_STALLED =
  "Your purchase went through, but Kiwi hasn't confirmed it yet. Check again in a moment.";
export const SHEET_CONFIRM_RETRY = "Check again";
export const SHEET_PURCHASE_FAILED = "The purchase didn't go through. Please try again.";
export const SHEET_PURCHASE_PENDING =
  "Your purchase is waiting for approval. Kiwi Premium turns on as soon as it's approved.";
export const SHEET_RESTORE_NONE = "There's no Kiwi Premium purchase to restore on this account.";
export const SHEET_RESTORE_FAILED = "Couldn't restore purchases. Please try again.";

// ── the checkout return, which proves nothing (§2.3) ─────────────────────
//
// The webhook is the truth. These two strings cover the window between "the
// browser came back" and "the webhook landed", which is normally under a second
// and occasionally is not.

export const SHEET_FINISHING = "Finishing up…";
export const SHEET_CHECK_AGAIN = "I've paid — check again";

// ── the Home banners (§2.4) ─────────────────────────────────────────────

// Resub C2 — no bonus clause. It would have printed "get 0 extra days free".
export function bannerTrialEnding(daysLeft: number): string {
  return `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left in your trial — subscribe to keep planning with Kiwi.`;
}
export const BANNER_TRIAL_CTA = "Subscribe";

export const BANNER_LAPSED = "Your trial has ended. Your plans and recipes are saved.";
export const BANNER_LAPSED_CTA = "Upgrade";

export const BANNER_PAST_DUE =
  "There's a problem with your payment. Kiwi stays unlocked for a few days while we retry.";
export const BANNER_PAST_DUE_CTA = "Manage payment";

// ── the lapsed-account notices (§2.6 / D-WS9-272) ────────────────────────
//
// Hans's ruling, verbatim: "keep what exists · do not pretend the call ran ·
// say why in place · offer the upgrade." Each of these three is the "say why in
// place" half; the "keep what exists" half is that none of them REPLACES the
// content beside it — the stale list, the stored macros and the cuisine matches
// all stay on screen underneath.

export const NOTICE_GROCERY_STALE =
  "This list was generated during your trial and may not reflect changes to your plan. Upgrade to get unlimited access to all features.";
export const NOTICE_MACROS =
  "Macros are a premium feature. Upgrade to get unlimited access to all features.";
export const NOTICE_FIND_SIMILAR =
  "Kiwi's smart matches are a premium feature — these are cuisine matches. Upgrade to get unlimited access to all features.";
/** The one CTA all three notices share. A label, not a sentence. */
export const NOTICE_CTA = "Upgrade";

// ── Settings → Subscription (§2.8) ──────────────────────────────────────

export const SETTINGS_ROW_TITLE = "Subscription";

export function settingsTrialing(trialEndsAtIso: string): string {
  return `Free trial · ends ${formatDate(trialEndsAtIso)}`;
}
export function settingsMonthly(renewsIso: string): string {
  return `Kiwi Monthly · renews ${formatDate(renewsIso)}`;
}
export function settingsAnnual(renewsIso: string): string {
  return `Kiwi Annual · renews ${formatDate(renewsIso)}`;
}
export function settingsCancels(endsIso: string): string {
  return `Cancels ${formatDate(endsIso)}`;
}
export const SETTINGS_PAST_DUE = "Payment problem";
export const SETTINGS_TRIAL_ENDED = "Trial ended";
export const SETTINGS_SUBSCRIBE = "Subscribe";
export const SETTINGS_MANAGE = "Manage subscription";

// ── Resub C2 · Profile → Kiwi Premium, and managing by source ────────────

/** The row the App Review account can reach during its trial (§2). */
export const PREMIUM_ROW_TITLE = "Kiwi Premium";
export function premiumTrialDaysLeft(daysLeft: number): string {
  return `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left in your free trial`;
}
/** A trial with no end date to count to (see trialDaysLeft). */
export const PREMIUM_TRIAL_OPEN = "You're on your free trial";
export const PREMIUM_TRIAL_ENDED = "Your free trial has ended";

/** Linking.openURL refused a store subscription page (a device with no browser). */
export const MANAGE_OPEN_FAILED =
  "Couldn't open your subscription settings. Please try again in a moment.";

/** A Stripe subscriber in the app: where to manage it, with no link (3.1.1). */
export const MANAGE_STRIPE_ON_WEB = "Manage your subscription at kitchenwizard.ai";

/**
 * A store subscriber on the web — and the web's 409 `subscribed_elsewhere`.
 * Kiwi cannot manage or cancel a store subscription; the store does.
 */
export function subscribedInStore(source: "apple" | "google"): string {
  return `You're subscribed through ${source === "apple" ? "the App Store" : "Google Play"} — manage it there.`;
}

/** BUG-356 — on the delete-account confirmation, BEFORE the user confirms. */
export function deleteAccountStoreNotice(source: "apple" | "google"): string {
  return `Your Kiwi Premium subscription is billed by ${source === "apple" ? "the App Store" : "Google Play"} and keeps renewing until you cancel it there.`;
}

/**
 * The status line when a date the line needs is missing.
 *
 * Reachable, and not only through corruption: `effectiveStatus` keeps an
 * account `trialing` when `trialEndsAt` is NULL (the unbounded trial the server
 * reports as an open finding rather than tightening), and an `active`
 * subscription is read once by this client before its first
 * `customer.subscription.updated` webhook has written `currentPeriodEnd`. In
 * both cases the row must say something true, and "ends undefined" is not it.
 */
export const SETTINGS_ACTIVE_NO_DATE = "Kiwi subscription · active";
export const SETTINGS_TRIAL_NO_DATE = "Free trial";

// ── the web return pages (§2.3) ─────────────────────────────────────────

export const RETURN_TITLE = "You're all set";
export const RETURN_BODY =
  "You're all set — Kiwi is unlocked. If you came from the app, head back to it.";
export const CANCELLED_TITLE = "No charge was made";
export const CANCELLED_BODY =
  "No charge was made. Your plans are right where you left them.";
export const RETURN_HOME_CTA = "Home";

// ── the failures a link-out can hand back (§1) ──────────────────────────
//
// `503 billing_unavailable` is reachable on a deploy with no Stripe, and the
// ruling for that state is that no button leading to it is rendered at all
// (`billingAvailable` gates every one). This copy is the belt to that braces:
// the config can change under a client that is already on screen.

export const CHECKOUT_UNAVAILABLE =
  "Kiwi cannot take payments right now. Please try again a little later.";
export const CHECKOUT_FAILED =
  "Something went wrong starting checkout. Please try again in a moment.";
/** `409 already_subscribed` — two devices, or a paywall that never refetched. */
export const CHECKOUT_ALREADY = "You're already subscribed — welcome back.";
/** `409 no_billing_account` from the Portal: there is nothing to manage yet. */
export const PORTAL_NO_ACCOUNT =
  "There is no billing account to manage yet. Subscribe first and this will open your billing settings.";
