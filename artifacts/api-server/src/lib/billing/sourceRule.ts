// Resubmission B1 — ONE ROW, TWO POSSIBLE SOURCES: THE RULE.
//
// `subscriptions` stays the single truth for entitlement. A user can pay
// through Stripe (web) or through the App Store / Google Play (RevenueCat),
// and in the rare case they pay through both, the row describes ONE of them —
// the one that keeps them entitled longest. Nothing ever double-entitles, and
// nothing a second rail says can take entitlement away from the first.
//
// ── THE RULE ─────────────────────────────────────────────────────────────
//
// A write from source B may change the row when ANY of:
//   · the row has no source yet (a trial — nobody has paid), or
//   · the row's source IS B (a rail updating its own subscription), or
//   · the row is NOT currently entitled by its source A, or
//   · B entitles the user AND B's `currentPeriodEnd` is later than A's.
// Otherwise: log `billing_dual_subscription` and leave the row.
//
// "B entitles" is part of the last clause on purpose. The ruling says "or B's
// currentPeriodEnd is later"; a CANCELED Stripe subscription can carry a later
// period end than a live Apple one, and letting it take the row would lock a
// paying iPhone user out. Pick the longest-LIVED, so B has to be alive.
//
// Pure — no I/O, no clock of its own. Both mirrors (Stripe's webhookMirror.ts,
// RevenueCat's storeSync.ts) ask it before every write.

import type { BillingSource, SubscriptionStatus } from "@prisma/client";

import { effectiveStatus, isEntitled } from "../subscriptionService";

export interface RowForRule {
  source: BillingSource | null;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

export interface IncomingForRule {
  source: BillingSource;
  /** Whether B's own state, as it would be written, is entitled. */
  entitled: boolean;
  currentPeriodEnd: Date | null;
}

export type RuleDecision =
  | { write: true; reason: "no_source" | "same_source" | "row_not_entitled" | "longer_lived" }
  | { write: false; reason: "dual_subscription"; rowSource: BillingSource };

export function decideSourceWrite(
  row: RowForRule,
  incoming: IncomingForRule,
  now: Date,
): RuleDecision {
  if (row.source === null) return { write: true, reason: "no_source" };
  if (row.source === incoming.source) return { write: true, reason: "same_source" };

  const rowEntitled = isEntitled(effectiveStatus(row, now));
  if (!rowEntitled) return { write: true, reason: "row_not_entitled" };

  const incomingEnd = incoming.currentPeriodEnd?.getTime() ?? null;
  const rowEnd = row.currentPeriodEnd?.getTime() ?? null;
  if (
    incoming.entitled &&
    incomingEnd !== null &&
    // A NULL end on an entitled row is open-ended; nothing is "later" than it.
    rowEnd !== null &&
    incomingEnd > rowEnd
  ) {
    return { write: true, reason: "longer_lived" };
  }
  return { write: false, reason: "dual_subscription", rowSource: row.source };
}
