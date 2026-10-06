// Resub C2 — "the store took the money; does Kiwi know?"
//
// After a store purchase or a Restore the app calls POST /billing/store-sync,
// which re-reads RevenueCat for the signed-in user and answers with the
// subscription. The webhook would get there too, but the person is looking at
// the sheet NOW.
//
// 🔴 A FAILED CONFIRMATION IS NEVER A SECOND PURCHASE. The money is already
// taken; what failed is Kiwi hearing about it. So a 502 (RevenueCat did not
// answer) or a 429 is retried here with backoff, the sheet says "Purchase
// received — confirming it with Kiwi…" and shows no buy button the whole time,
// and when the retries run out the sheet offers "Check again" — another sync,
// never another buy. A 503 is not retried: the deploy has no RevenueCat, and no
// number of retries changes that.
//
// Pure apart from the injected `sync` and `sleep`, so the whole ladder is
// tested without a timer or a network.

import type { StoreSyncResult } from "./api";
import { isPayingStatus, type SubscriptionPayload } from "./subscriptionView";

/** Waits between attempts: five tries over about 15 s. */
export const STORE_SYNC_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

let backoffOverride: readonly number[] | null = null;
/** Test-only: shrink the waits so a provider test does not sit on real timers. */
export function __setStoreSyncBackoffForTests(ms: readonly number[] | null): void {
  backoffOverride = ms;
}
export function storeSyncBackoff(): readonly number[] {
  return backoffOverride ?? STORE_SYNC_BACKOFF_MS;
}

export type StoreConfirmOutcome =
  | { kind: "confirmed"; subscription: SubscriptionPayload }
  /** Retries exhausted. The sheet offers "Check again", never a purchase. */
  | { kind: "stalled" }
  /** 503 — no RevenueCat on the deploy. */
  | { kind: "unavailable" }
  /** 401 — the session cascade has already fired; the sheet is going away. */
  | { kind: "unauthenticated" };

export interface StoreConfirmDeps {
  sync: () => Promise<StoreSyncResult>;
  sleep?: (ms: number) => Promise<void>;
  backoff?: readonly number[];
  /**
   * After a PURCHASE the answer must say the account pays; a sync that lands
   * before RevenueCat has the receipt reads as not paying, and is retried like
   * a 502. After a RESTORE any answer is final — "nothing to restore" is a
   * real result.
   */
  expectPaying: boolean;
  /** Called before each retry, with the 1-based retry number. */
  onRetry?: (retry: number) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function confirmStorePurchase(deps: StoreConfirmDeps): Promise<StoreConfirmOutcome> {
  const backoff = deps.backoff ?? storeSyncBackoff();
  const sleep = deps.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    const res = await deps.sync();
    if (res.success) {
      if (!deps.expectPaying || isPayingStatus(res.subscription.status)) {
        return { kind: "confirmed", subscription: res.subscription };
      }
    } else if (res.error === "billing_unavailable") {
      return { kind: "unavailable" };
    } else if (res.error === "unauthenticated") {
      return { kind: "unauthenticated" };
    }
    // store_sync_failed, rate_limited, unknown — or a purchase not yet visible.
    if (attempt >= backoff.length) return { kind: "stalled" };
    deps.onRetry?.(attempt + 1);
    await sleep(backoff[attempt]);
  }
}
