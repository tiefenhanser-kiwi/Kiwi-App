// Row 9 (1.1) · Stripe S2 Part E — the per-device banner dismissals.
//
// §2.4: the banners are "dismissible per device except `past_due`". Per DEVICE and
// not per account, following the personalize nudge's "Later" flag
// (lib/home/personalizeNudge.ts) — the precedent this reuses, and the reason is
// the same one Hans gave there: a dismissal is a statement about this screen on
// this phone, not a durable account preference, and it does not deserve a column.
//
// `past_due` is never written here. `bannerFor` does not consult the set for it at
// all, so even a hand-written storage key cannot silence a failed payment.

import { loadJSON, saveJSON } from "@/lib/storage";

import type { BannerKind } from "./subscriptionView";

/** Through lib/storage.ts, which prefixes "kiwi:". */
export const BANNER_DISMISSED_DEVICE_KEY = "billingBannersDismissed";

/** The kinds a user may dismiss. `past_due` is deliberately absent. */
const DISMISSIBLE: ReadonlySet<string> = new Set<BannerKind>([
  "trial_ending",
  "lapsed",
]);

function isDismissible(x: unknown): x is BannerKind {
  return typeof x === "string" && DISMISSIBLE.has(x);
}

/** Exported for the test: garbage, and `past_due`, both read as absent. */
export function parseDismissed(raw: unknown): Set<BannerKind> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter(isDismissible));
}

export async function loadDismissedBanners(): Promise<Set<BannerKind>> {
  return parseDismissed(await loadJSON<unknown>(BANNER_DISMISSED_DEVICE_KEY, []));
}

/**
 * Record a dismissal and return the new set.
 *
 * A non-dismissible kind is a NO-OP rather than an error: the only caller is a
 * button that `bannerFor` only renders for a dismissible banner, so reaching here
 * with `past_due` would be a bug — and the right response to that bug is a
 * `past_due` banner that stays on screen, not a throw inside an onPress.
 */
export async function dismissBanner(
  kind: BannerKind,
  current: ReadonlySet<BannerKind>,
): Promise<Set<BannerKind>> {
  if (!isDismissible(kind)) return new Set(current);
  const next = new Set(current);
  next.add(kind);
  await saveJSON(BANNER_DISMISSED_DEVICE_KEY, [...next]);
  return next;
}
