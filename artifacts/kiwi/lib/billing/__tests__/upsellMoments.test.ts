// Row 9 (1.1) · Stripe S2 Part B — the three moments, and the four gates.
//
// The invariant that matters more than any single case: for EVERY moment, the
// only combination that fires is (enforced, trialing, not-yet-seen). It is
// asserted over the whole product below rather than at three chosen points,
// because the failure this shape exists to prevent is a fourth moment added
// later with one gate forgotten.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SubscriptionPayload, SubscriptionStatus } from "../subscriptionView";
import {
  UPSELL_MOMENTS,
  UPSELL_MOMENTS_DEVICE_KEY,
  allUpsellMoments,
  markMomentSeen,
  parseSeenMoments,
  shouldFireUpsellMoment,
  type UpsellMoment,
} from "../upsellMoments";

const ALL_STATUSES: SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "none",
  "canceled",
];

function sub(over: Partial<SubscriptionPayload> = {}): SubscriptionPayload {
  return {
    status: "trialing",
    planCode: "free",
    trialEndsAt: "2026-10-11T12:00:00.000Z",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingAvailable: true,
    enforced: true,
    earlyPayBonusDays: 14,
    firstChargeDateIfSubscribedNow: "2026-10-25T12:00:00.000Z",
    ...over,
  };
}

const NOTHING_SEEN: ReadonlySet<UpsellMoment> = new Set();

// ── the table ──────────────────────────────────────────────────────────

test("the three moments D-WS9-270 §5a names, and no others", () => {
  assert.deepEqual(allUpsellMoments().sort(), [
    "first_grocery_list",
    "first_instacart_handoff",
    "first_plan_generated",
  ]);
});

test("every moment records WHERE it is wired — §27.2's question, answered in the table", () => {
  for (const m of allUpsellMoments()) {
    assert.ok(UPSELL_MOMENTS[m].where.length > 0, m);
  }
});

// ── the gates, over the whole product ──────────────────────────────────

test("🔴 THE INVARIANT: a moment fires ONLY for (enforced × trialing × unseen)", () => {
  for (const moment of allUpsellMoments()) {
    for (const status of ALL_STATUSES) {
      for (const enforced of [true, false]) {
        for (const seenIt of [true, false]) {
          const expected = enforced && status === "trialing" && !seenIt;
          const seen: ReadonlySet<UpsellMoment> = seenIt ? new Set([moment]) : NOTHING_SEEN;
          assert.equal(
            shouldFireUpsellMoment({ moment, sub: sub({ status, enforced }), seen }),
            expected,
            `${moment} · ${status} · enforced=${enforced} · seen=${seenIt}`,
          );
        }
      }
    }
  }
});

test("🔴 a moment fires ONCE per device — the second ask is refused", () => {
  const moment: UpsellMoment = "first_plan_generated";
  const s = sub();
  assert.equal(shouldFireUpsellMoment({ moment, sub: s, seen: NOTHING_SEEN }), true);
  const afterFirst = new Set<UpsellMoment>([moment]);
  assert.equal(shouldFireUpsellMoment({ moment, sub: s, seen: afterFirst }), false);
});

test("seeing one moment does not consume the other two", () => {
  const seen = new Set<UpsellMoment>(["first_plan_generated"]);
  const s = sub();
  assert.equal(shouldFireUpsellMoment({ moment: "first_grocery_list", sub: s, seen }), true);
  assert.equal(
    shouldFireUpsellMoment({ moment: "first_instacart_handoff", sub: s, seen }),
    true,
  );
});

test("no upsell over a load — a null payload never fires", () => {
  for (const moment of allUpsellMoments()) {
    assert.equal(shouldFireUpsellMoment({ moment, sub: null, seen: NOTHING_SEEN }), false);
  }
});

// ── the persisted set ──────────────────────────────────────────────────

test("markMomentSeen returns the widened set and does not mutate the input", () => {
  const before = new Set<UpsellMoment>(["first_grocery_list"]);
  return markMomentSeen("first_plan_generated", before).then((after) => {
    assert.deepEqual([...after].sort(), ["first_grocery_list", "first_plan_generated"]);
    assert.deepEqual([...before], ["first_grocery_list"], "the caller's set is untouched");
  });
});

test("the round trip: what markMomentSeen persists is what parseSeenMoments reads", async () => {
  const next = await markMomentSeen("first_instacart_handoff", NOTHING_SEEN);
  // saveJSON stores the array form; parse takes it back to a typed set.
  assert.deepEqual(parseSeenMoments([...next]), new Set(["first_instacart_handoff"]));
});

test("every malformed stored shape reads as NOTHING SEEN rather than throwing in a render", () => {
  for (const raw of [null, undefined, 0, "", "first_plan_generated", {}, true, NaN]) {
    assert.deepEqual(parseSeenMoments(raw), new Set(), JSON.stringify(raw ?? null));
  }
  // A retired / unknown key is dropped, not carried into a typed set.
  assert.deepEqual(
    parseSeenMoments(["first_plan_generated", "first_dinner_party", 42, null]),
    new Set(["first_plan_generated"]),
  );
});

test("the device key is namespaced by lib/storage.ts's prefix, not hand-written", () => {
  // The key here is the BARE key; lib/storage.ts adds "kiwi:". A key that
  // already carried the prefix would be double-prefixed and silently orphan
  // every flag written by a previous build.
  assert.equal(UPSELL_MOMENTS_DEVICE_KEY, "billingUpsellMomentsSeen");
  assert.ok(!UPSELL_MOMENTS_DEVICE_KEY.startsWith("kiwi:"));
});
