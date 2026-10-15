// BOOK-1C1 (D-WS9-312) — the Cookbook Ask Kiwi helper: the meal maker with
// the search text, or the subscribe sheet on a lapsed, enforced account.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SubscriptionPayload } from "../../billing/subscriptionView";
import { askKiwiAction } from "../askKiwi";
import { allergyLine, EATING_STYLES_SOON } from "../sheetCopy";

function sub(status: SubscriptionPayload["status"], enforced = true): SubscriptionPayload {
  return {
    status,
    planCode: "monthly",
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingAvailable: true,
    enforced,
  };
}

describe("askKiwiAction", () => {
  test("an entitled account opens the meal maker with the trimmed search text", () => {
    for (const s of ["trialing", "active", "past_due"] as const) {
      assert.deepEqual(askKiwiAction(sub(s), "  spicy turkey chili "), { kind: "open", prompt: "spicy turkey chili" });
    }
  });

  test("empty text opens it with no prefill", () => {
    assert.deepEqual(askKiwiAction(sub("active"), "   "), { kind: "open", prompt: null });
  });

  test("a lapsed account under enforcement gets the subscribe sheet", () => {
    assert.deepEqual(askKiwiAction(sub("none"), "chili"), { kind: "paywall" });
    assert.deepEqual(askKiwiAction(sub("canceled"), "chili"), { kind: "paywall" });
  });

  test("enforcement off, or no subscription read yet: never the sheet (the server 402 stays the authority)", () => {
    assert.equal(askKiwiAction(sub("none", false), "chili").kind, "open");
    assert.equal(askKiwiAction(null, "chili").kind, "open");
  });
});

describe("the filter sheet copy", () => {
  test("the locked allergy line", () => {
    assert.equal(
      allergyLine(["Dairy-free", " Peanuts "]),
      "Your allergies: always on: Dairy-free, Peanuts. Change them in Profile.",
    );
    assert.equal(allergyLine([]), "Your allergies: none set. Add them in Profile.");
    assert.equal(allergyLine(null), "Your allergies are always on. Change them in Profile.");
  });

  test("eating styles are listed (shown disabled)", () => {
    assert.ok(EATING_STYLES_SOON.length > 0);
  });
});
