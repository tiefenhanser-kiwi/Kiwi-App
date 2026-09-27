// Row 9 (1.1) · Stripe S1 Part C — entitlement.
//
// What is defended here, in the order it matters:
//
//   1. `none` IS DERIVED BY CLOCK. The whole design rests on there being no
//      scheduler: a trialing row whose trialEndsAt has passed IS `none` on read.
//      If that ever stops being true, every lapsed account silently keeps its
//      AI, and nothing else in the system would notice.
//
//   2. THE FLAG IS THE WHOLE SAFETY NET. With BILLING_ENFORCED unset the answer
//      must be `allowed` for a `none` account on every key — that is what makes
//      it safe to deploy S1 into production before Stripe is commissioned. A
//      test that only checked the ON path would let a shipped default lock out
//      the entire user base.
//
//   3. IT FAILS OPEN. Both when the query throws and when the row is missing.
//      This is the opposite of requireAuth and is asserted deliberately, because
//      it looks like a bug to anyone who reads it without the reasoning.
//
//   4. EVERY KEY HAS A PRICE. A key added to the union without a row in
//      ENTITLEMENTS is a key whose gate silently does nothing, so the table is
//      asserted exhaustive against the union rather than spot-checked.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SubscriptionStatus } from "@prisma/client";

import {
  createSubscriptionService,
  effectiveStatus,
  ENTITLED_STATUSES,
  ENTITLEMENTS,
  isEntitled,
  SUBSCRIPTION_REQUIRED_CODE,
  subscriptionRequiredBody,
  type EntitlementKey,
} from "../subscriptionService";
import { readBillingConfig } from "../billing/config";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

// ── 1. the derived status ────────────────────────────────────────────────

describe("effectiveStatus — `none` is derived, never scheduled", () => {
  it("trialing with trialEndsAt in the FUTURE stays trialing", () => {
    const row = { status: "trialing" as SubscriptionStatus, trialEndsAt: new Date(NOW.getTime() + DAY) };
    assert.equal(effectiveStatus(row, NOW), "trialing");
  });

  it("trialing with trialEndsAt in the PAST is none", () => {
    const row = { status: "trialing" as SubscriptionStatus, trialEndsAt: new Date(NOW.getTime() - DAY) };
    assert.equal(effectiveStatus(row, NOW), "none");
  });

  it("the boundary: one millisecond before the end is still trialing, one after is none", () => {
    const end = new Date(NOW.getTime());
    // trialEndsAt === now is NOT `< now`, so the trial is still running.
    assert.equal(effectiveStatus({ status: "trialing", trialEndsAt: end }, NOW), "trialing");
    assert.equal(
      effectiveStatus({ status: "trialing", trialEndsAt: new Date(end.getTime() - 1) }, NOW),
      "none",
    );
  });

  it("the SAME ROW reads differently as the clock moves — no write in between", () => {
    const row = { status: "trialing" as SubscriptionStatus, trialEndsAt: new Date(NOW.getTime() + DAY) };
    assert.equal(effectiveStatus(row, NOW), "trialing");
    assert.equal(effectiveStatus(row, new Date(NOW.getTime() + 2 * DAY)), "none");
  });

  it("every NON-trialing status is returned as stored, whatever trialEndsAt says", () => {
    const past = new Date(NOW.getTime() - 100 * DAY);
    for (const status of ["active", "past_due", "canceled", "none"] as SubscriptionStatus[]) {
      assert.equal(effectiveStatus({ status, trialEndsAt: past }, NOW), status);
      assert.equal(effectiveStatus({ status, trialEndsAt: null }, NOW), status);
    }
  });

  // ⚠️ PINNING A KNOWN GAP, not endorsing it. The ruling is "trialing with
  // trialEndsAt < now → none; everything else is the stored status", and NULL is
  // not `< now`, so a null-trialEndsAt trial is UNBOUNDED. It is unreachable
  // today (createAccountInTx writes the timestamp in the same transaction as the
  // row, for both the password and the OAuth lane) and it is reported as an open
  // finding. This test exists so the behaviour is deliberate: if someone changes
  // it, they change a test that says why.
  it("trialing with a NULL trialEndsAt stays trialing — an unbounded trial (known, reported)", () => {
    assert.equal(effectiveStatus({ status: "trialing", trialEndsAt: null }, NOW), "trialing");
  });
});

describe("the entitled set", () => {
  it("trialing, active and past_due are entitled; none and canceled are not", () => {
    assert.equal(isEntitled("trialing"), true);
    assert.equal(isEntitled("active"), true);
    // past_due is entitled ON PURPOSE — Stripe's dunning window is the grace
    // period and a failed card retry is usually an expiry, not a decision.
    assert.equal(isEntitled("past_due"), true);
    assert.equal(isEntitled("none"), false);
    assert.equal(isEntitled("canceled"), false);
  });

  it("the set is exactly those three", () => {
    assert.deepEqual([...ENTITLED_STATUSES].sort(), ["active", "past_due", "trialing"]);
  });
});

// ── 4. the matrix ───────────────────────────────────────────────────────

describe("ENTITLEMENTS — one table, one word per key", () => {
  // The union has no runtime representation, so this is the next best thing: a
  // literal list that a compiler error guards. Adding a key to EntitlementKey
  // without adding it here fails `tsc`, and adding it here without the union
  // fails too.
  const ALL_KEYS: EntitlementKey[] = [
    "kitchen_wizard_set_preferences",
    "kitchen_wizard_just_say",
    "kitchen_wizard_cook_what_i_have_now",
    "meal_builder_text_input",
    "kitchen_wizard_one_meal",
    "prep_the_week_orchestrated",
    "grocery_ordering",
    "unlimited_plans",
    "ad_free",
    "find_similar_ai",
    "recipe_import_ai",
    "recipe_scale_ai",
    "grocery_list_generate",
    "grocery_list_reconcile",
    "plan_macro_recalc",
    "meal_macro_estimate",
    "plan_finalize_steps",
  ];

  it("every key has a price, and there are no keys in the table that are not keys", () => {
    assert.deepEqual(Object.keys(ENTITLEMENTS).sort(), [...ALL_KEYS].sort());
    for (const k of ALL_KEYS) {
      assert.ok(ENTITLEMENTS[k] === "paid" || ENTITLEMENTS[k] === "free", k);
    }
  });

  it("the two free keys are exactly grocery_ordering and ad_free — no model call between them", () => {
    const free = ALL_KEYS.filter((k) => ENTITLEMENTS[k] === "free").sort();
    assert.deepEqual(free, ["ad_free", "grocery_ordering"]);
  });

  it('every key that spends a model call is "paid" — the "No Pay / No Trial = No AI" ruling', () => {
    // Named one by one rather than derived, so that making one free later is a
    // change to this list too — i.e. a decision, visible in a diff.
    const spenders: EntitlementKey[] = [
      "kitchen_wizard_set_preferences",
      "kitchen_wizard_just_say",
      "meal_builder_text_input",
      "prep_the_week_orchestrated",
      "find_similar_ai",
      "recipe_import_ai",
      "recipe_scale_ai",
      "grocery_list_generate",
      "grocery_list_reconcile",
      "plan_macro_recalc",
      "meal_macro_estimate",
      "plan_finalize_steps",
    ];
    for (const k of spenders) assert.equal(ENTITLEMENTS[k], "paid", k);
  });
});

// ── 2 + 3. can() ────────────────────────────────────────────────────────

/** A prisma stub with exactly the surface readSubscriptionSnapshot touches. */
function stubPrisma(
  row: { status: SubscriptionStatus; trialEndsAt: Date | null } | null,
  opts: { throwOnRead?: boolean } = {},
) {
  const updates: Array<Record<string, unknown>> = [];
  return {
    subscription: {
      findUnique: async () => {
        if (opts.throwOnRead) throw new Error("neon had a moment");
        if (row === null) return null;
        return {
          status: row.status,
          planCode: "free",
          trialEndsAt: row.trialEndsAt,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          earlyPayBonusApplied: false,
        };
      },
      update: async (args: Record<string, unknown>) => {
        updates.push(args);
        return {};
      },
    },
    _updates: updates,
  };
}

const CONFIGURED = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_PRICE_MONTHLY: "price_m",
  STRIPE_PRICE_ANNUAL: "price_a",
  BILLING_RETURN_URL_BASE: "https://app.example",
};

function service(
  row: { status: SubscriptionStatus; trialEndsAt: Date | null } | null,
  opts: { enforced?: boolean; throwOnRead?: boolean } = {},
) {
  const prisma = stubPrisma(row, opts);
  const svc = createSubscriptionService({
    prisma: prisma as never,
    readConfig: () =>
      readBillingConfig({
        ...CONFIGURED,
        ...(opts.enforced ? { BILLING_ENFORCED: "true" } : {}),
      }),
    now: () => NOW,
  });
  return { svc, prisma };
}

const LAPSED = { status: "trialing" as SubscriptionStatus, trialEndsAt: new Date(NOW.getTime() - DAY) };

describe("can() with BILLING_ENFORCED OFF — today's behaviour, byte for byte", () => {
  it("a LAPSED account is allowed on EVERY key", async () => {
    const { svc } = service(LAPSED, { enforced: false });
    for (const key of Object.keys(ENTITLEMENTS) as EntitlementKey[]) {
      const ent = await svc.can("u1", key);
      assert.equal(ent.allowed, true, `${key} must be allowed while enforcement is off`);
    }
  });

  it("a CANCELED account is allowed too", async () => {
    const { svc } = service({ status: "canceled", trialEndsAt: null }, { enforced: false });
    assert.equal((await svc.can("u1", "kitchen_wizard_set_preferences")).allowed, true);
  });

  it("does not even READ the database — off means no round trip", async () => {
    // A stub that throws on read: if the flag check is not first, this fails.
    const { svc } = service(LAPSED, { enforced: false, throwOnRead: true });
    assert.equal((await svc.can("u1", "kitchen_wizard_set_preferences")).allowed, true);
  });
});

describe("can() with BILLING_ENFORCED ON", () => {
  it("a lapsed trial is DENIED with code subscription_required and the derived status", async () => {
    const { svc } = service(LAPSED, { enforced: true });
    const ent = await svc.can("u1", "kitchen_wizard_set_preferences");
    assert.equal(ent.allowed, false);
    assert.equal(ent.code, SUBSCRIPTION_REQUIRED_CODE);
    assert.equal(ent.status, "none");
    assert.match(ent.reason ?? "", /trial has ended/i);
  });

  it("a canceled account is denied, with copy that does NOT mention a trial", async () => {
    const { svc } = service({ status: "canceled", trialEndsAt: null }, { enforced: true });
    const ent = await svc.can("u1", "kitchen_wizard_set_preferences");
    assert.equal(ent.allowed, false);
    assert.equal(ent.status, "canceled");
    assert.match(ent.reason ?? "", /subscription has ended/i);
  });

  it("trialing, active and past_due are all allowed", async () => {
    for (const row of [
      { status: "trialing" as SubscriptionStatus, trialEndsAt: new Date(NOW.getTime() + DAY) },
      { status: "active" as SubscriptionStatus, trialEndsAt: null },
      { status: "past_due" as SubscriptionStatus, trialEndsAt: null },
    ]) {
      const { svc } = service(row, { enforced: true });
      const ent = await svc.can("u1", "kitchen_wizard_set_preferences");
      assert.equal(ent.allowed, true, row.status);
      assert.equal(ent.status, row.status);
    }
  });

  it("a FREE key is allowed even for a lapsed account — Instacart still works", async () => {
    const { svc } = service(LAPSED, { enforced: true });
    assert.equal((await svc.can("u1", "grocery_ordering")).allowed, true);
    assert.equal((await svc.can("u1", "ad_free")).allowed, true);
  });

  it("the lapsed status is written back opportunistically, ONCE, on the deny path", async () => {
    const { svc, prisma } = service(LAPSED, { enforced: true });
    await svc.can("u1", "kitchen_wizard_set_preferences");
    assert.equal(prisma._updates.length, 1);
    assert.deepEqual(prisma._updates[0], { where: { userId: "u1" }, data: { status: "none" } });
  });

  it("an ALREADY-none row is not rewritten — no pointless write on every refusal", async () => {
    const { svc, prisma } = service({ status: "none", trialEndsAt: null }, { enforced: true });
    const ent = await svc.can("u1", "kitchen_wizard_set_preferences");
    assert.equal(ent.allowed, false);
    assert.equal(prisma._updates.length, 0);
  });

  it("an ENTITLED account is never written to", async () => {
    const { svc, prisma } = service(
      { status: "active", trialEndsAt: null },
      { enforced: true },
    );
    await svc.can("u1", "kitchen_wizard_set_preferences");
    assert.equal(prisma._updates.length, 0);
  });

  // ── fail open, and it is deliberate ──
  it("a THROWN query ALLOWS — a datastore blip must not paywall the paying user base", async () => {
    const { svc } = service(LAPSED, { enforced: true, throwOnRead: true });
    const ent = await svc.can("u1", "kitchen_wizard_set_preferences");
    assert.equal(ent.allowed, true, "entitlement fails OPEN, unlike requireAuth");
  });

  it("a MISSING Subscription row ALLOWS — its absence is corruption, not a signup state", async () => {
    const { svc } = service(null, { enforced: true });
    assert.equal((await svc.can("u1", "kitchen_wizard_set_preferences")).allowed, true);
  });

  it("a failed status write-back does not change the refusal", async () => {
    const prisma = {
      subscription: {
        findUnique: async () => ({
          status: "trialing" as SubscriptionStatus,
          planCode: "free",
          trialEndsAt: new Date(NOW.getTime() - DAY),
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          earlyPayBonusApplied: false,
        }),
        update: async () => {
          throw new Error("write failed");
        },
      },
    };
    const svc = createSubscriptionService({
      prisma: prisma as never,
      readConfig: () => readBillingConfig({ ...CONFIGURED, BILLING_ENFORCED: "1" }),
      now: () => NOW,
    });
    const ent = await svc.can("u1", "kitchen_wizard_set_preferences");
    assert.equal(ent.allowed, false, "the refusal stands; the rewrite is cosmetic");
    assert.equal(ent.status, "none");
  });
});

describe("subscriptionRequiredBody", () => {
  it("keeps the legacy `error` string AND adds `code`", () => {
    const body = subscriptionRequiredBody(
      { allowed: false, code: SUBSCRIPTION_REQUIRED_CODE, reason: "because" },
      "fallback",
    );
    // The eight pre-existing gates have sent this exact string since WS6 and the
    // shipped mobile build may read it. Widening is safe; replacing is not.
    assert.equal(body.error, "upgrade required");
    assert.equal(body.code, SUBSCRIPTION_REQUIRED_CODE);
    assert.equal(body.reason, "because");
  });

  it("falls back to the call site's copy when the service gave no reason", () => {
    assert.equal(subscriptionRequiredBody({ allowed: false }, "fallback").reason, "fallback");
    assert.equal(subscriptionRequiredBody({ allowed: false }, "fallback").code, SUBSCRIPTION_REQUIRED_CODE);
  });
});
