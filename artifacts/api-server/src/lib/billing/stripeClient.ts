// Row 9 (1.1) · Stripe S1 Part A — THE OUTBOUND SEAM.
//
// ── WHY THIS FILE IS AN INTERFACE AND NOT AN IMPORT ──────────────────────
//
// The suite runs `node --env-file=.env`. Every test in this repository has a
// live `DATABASE_URL`, a live `ANTHROPIC_API_KEY` and — once Hans commissions
// S3 — a live `STRIPE_SECRET_KEY` in its environment. The OAuth block reached
// the same conclusion about Apple (lib/oauth/appleTokens.ts: "`fetch` is
// injected with NO default") and the lesson is identical here, with one extra
// edge: a Stripe call is not an idempotent read. `customers.create` against a
// live key makes a real customer, and `subscriptions.cancel` against a live key
// cancels a real person's subscription. A forgotten stub in a test would not
// fail loudly — it would succeed, quietly, against production.
//
// So `StripeLike` is a STRUCTURAL type covering exactly the calls S1 makes, and
// nothing in the billing code imports the `stripe` package. Only `getStripe()`
// below does, lazily. A test hands in a FakeStripe; there is no default for it
// to fall through to, because a default is the whole hazard.
//
// ── WHY THE TYPE IS HAND-WRITTEN AND NARROW ──────────────────────────────
//
// `Stripe.Subscription` has 47 top-level fields. A fake that satisfied the real
// interface would be 200 lines of nulls per test and would break on every SDK
// minor. These interfaces name the ~12 fields the mirror actually reads, and
// `getStripe()`'s return is checked against them by the compiler — so if a
// future SDK renames one of the 12, `tsc --noEmit` says so at the seam rather
// than at runtime in a webhook.
//
// ⚠️ THE API VERSION IS PINNED BY THE PACKAGE, NOT BY US. stripe@22.6.2 pins
// `2026-08-26.dahlia`, and on every version from 2025-03 (`…basil`) onward
// `current_period_start` / `current_period_end` ARE NOT ON THE SUBSCRIPTION
// OBJECT AT ALL — they live on the subscription ITEM. Verified against the
// installed types, not the changelog: `cjs/resources/Subscriptions.d.ts` has
// them only as list-filter params, and `cjs/resources/SubscriptionItems.d.ts`
// declares them at lines 54 and 58. `readPeriod()` below is the one place that
// knows this, and it is why `items` is in the narrow type.

// ⚠️ A STATIC IMPORT, NOT A LAZY `require`, AND THE REASON IS BUILD-SHAPED.
//
// The obvious version of this file required the SDK inside `getStripe()` so a
// test would never load it. That would have been the Row 5 Block 1c-fix bug
// again (revision kiwi-api-00010-fs2): `stripe` is NOT in build.mjs's `external`
// list, so esbuild BUNDLES it — but a `require("stripe")` call it cannot
// statically resolve survives into the output and is served at runtime by the
// banner's `globalThis.require`, resolving against a container tree that
// carries only @prisma/client. Green build, dead boot.
//
// A static import is bundled, needs no Dockerfile change and keeps
// bundleExternals.mjs quiet. And it costs nothing that matters: IMPORTING the
// SDK is inert — it opens no socket and reads no key. What had to be kept away
// from the tests was CALLING it, and that is what the seam above does.
import Stripe from "stripe";

import {
  type BillingConfig,
  ENV_STRIPE_SECRET_KEY,
} from "./config";

// ── the narrow shapes ────────────────────────────────────────────────────

/** A Stripe subscription, reduced to what the mirror reads. */
export interface StripeSubscriptionLike {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  trial_end: number | null;
  /** `string` unless the caller expanded it. The mirror only wants the id. */
  customer: string | { id: string };
  metadata?: Record<string, string> | null;
  /** The period dates and the price live in here. See the header. */
  items: {
    data: Array<{
      current_period_start?: number | null;
      current_period_end?: number | null;
      price?: { id?: string | null } | null;
    }>;
  };
}

export interface StripeCheckoutSessionLike {
  id: string;
  url: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
}

export interface StripeEventLike {
  id: string;
  type: string;
  /** Unix seconds. The out-of-order guard (§2.9) compares against this. */
  created: number;
  data: { object: unknown };
}

/**
 * Exactly the calls S1 makes. A FakeStripe in a test implements this and only
 * this; anything S2 or S3 needs is added here first, deliberately.
 */
export interface StripeLike {
  customers: {
    create(params: {
      email?: string | undefined;
      metadata: Record<string, string>;
    }): Promise<{ id: string }>;
    del(id: string): Promise<{ id: string; deleted?: boolean }>;
  };
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<StripeCheckoutSessionLike>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: { customer: string; return_url: string }): Promise<{ url: string }>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<StripeSubscriptionLike>;
    cancel(id: string): Promise<StripeSubscriptionLike>;
  };
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      header: string,
      secret: string,
    ): StripeEventLike;
  };
}

// ── the real client ──────────────────────────────────────────────────────

/**
 * Thrown rather than returned when `getStripe()` is called with no key. Every
 * route checks `config.available` first and answers 503, so reaching this is a
 * programming error, not a deploy state — and it should read like one.
 */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super(
      `${ENV_STRIPE_SECRET_KEY} is not set — getStripe() must not be called before checking BillingConfig.available`,
    );
    this.name = "StripeNotConfiguredError";
  }
}

let cached: { key: string; client: StripeLike } | null = null;

/**
 * The real client, built once per process per key.
 *
 * ⚠️ NO `apiVersion` IS PASSED, deliberately. Omitting it uses the version the
 * installed SDK pins (`2026-08-26.dahlia` for stripe@22.6.2), which is the
 * version whose TYPES the compiler just checked this code against. Passing a
 * string would let the wire format and the types disagree — the exact way the
 * `current_period_end` move bites people — and it would do it silently.
 *
 * The cast is the one place the narrow type meets the real one. It is checked
 * in the direction that matters: `Stripe` must satisfy `StripeLike`, so a
 * renamed method is a compile error here. `webhooks.constructEvent` needs the
 * cast because the SDK returns the full discriminated `Stripe.Event` union and
 * `StripeEventLike` deliberately flattens `data.object` to `unknown`.
 */
export function getStripe(config: BillingConfig): StripeLike {
  if (config.secretKey === null) throw new StripeNotConfiguredError();
  if (cached && cached.key === config.secretKey) return cached.client;

  const client = new Stripe(config.secretKey, {
    // Two attempts on a network blip. Stripe's own recommendation, and every
    // call S1 makes is either idempotent or a create whose double-execution
    // Stripe itself de-duplicates via the idempotency key it attaches.
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  const narrowed = client as unknown as StripeLike;
  cached = { key: config.secretKey, client: narrowed };
  return narrowed;
}

/** Test-only: drop the memoised client. Mirrors runAICall's `_resetClientCache`. */
export function _resetStripeCache(): void {
  cached = null;
}

// ── the period read, in ONE place ────────────────────────────────────────

/**
 * 🔴 THE API-VERSION GOTCHA, CONTAINED. See the file header.
 *
 * Reads the billing period from wherever the pinned version puts it: the
 * subscription ITEM on `…basil` (2025-03) and later, which includes the
 * `2026-08-26.dahlia` this SDK pins. The subscription-level fallback is kept
 * for two reasons — a webhook event that was minted by an OLDER API version
 * (Stripe sends the version the endpoint was created with, not the SDK's) still
 * mirrors correctly, and a downgrade of the SDK does not silently start writing
 * nulls.
 *
 * Returns nulls rather than throwing on a shape it does not recognise: a
 * subscription with no items is not a thing Stripe produces, and if it ever
 * were, losing the period dates is a smaller failure than losing the status.
 */
export function readPeriod(sub: StripeSubscriptionLike): {
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
} {
  const item = sub.items?.data?.[0];
  const legacy = sub as unknown as {
    current_period_start?: number | null;
    current_period_end?: number | null;
  };
  const start = item?.current_period_start ?? legacy.current_period_start ?? null;
  const end = item?.current_period_end ?? legacy.current_period_end ?? null;
  return {
    currentPeriodStart: typeof start === "number" ? new Date(start * 1000) : null,
    currentPeriodEnd: typeof end === "number" ? new Date(end * 1000) : null,
  };
}

/** The price id that decides `planCode`. Same containment as `readPeriod`. */
export function readPriceId(sub: StripeSubscriptionLike): string | null {
  const id = sub.items?.data?.[0]?.price?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** `customer` is a string unless someone expanded it. Accept both. */
export function readCustomerId(
  customer: string | { id: string } | null | undefined,
): string | null {
  if (typeof customer === "string") return customer === "" ? null : customer;
  if (customer && typeof customer.id === "string") return customer.id;
  return null;
}
