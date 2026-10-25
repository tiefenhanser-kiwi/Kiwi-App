// BOOK-1C1 (D-WS9-312) — the Cookbook Ask Kiwi helper: the meal maker with
// the search text, or the subscribe sheet on a lapsed, enforced account.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SubscriptionPayload } from "../../billing/subscriptionView";
import { askKiwiAction } from "../askKiwi";
import { allergyLine, EATING_STYLES_SOON_LINE } from "../sheetCopy";

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
  test("CLIENT-2 A2: the allergy line — locked when some are set or still loading, plain when none are set", () => {
    assert.deepEqual(allergyLine(["Dairy-free", " Peanuts "]), {
      text: "Allergies always on: Dairy-free, Peanuts. Change them in Profile.",
      locked: true,
    });
    assert.deepEqual(allergyLine([]), {
      text: "Allergies: none set, so nothing is hidden. Add them in Profile.",
      locked: false,
    });
    assert.deepEqual(allergyLine(["  "]), allergyLine([]));
    assert.deepEqual(allergyLine(null), {
      text: "Your allergies are always on. Change them in Profile.",
      locked: true,
    });
  });

  test("BOOK-1C2: eating styles are one line that names no style", () => {
    assert.equal(EATING_STYLES_SOON_LINE, "Eating styles: coming in December");
    for (const style of ["Vegetarian", "Vegan", "Pescatarian", "Keto", "Paleo"]) {
      assert.ok(!EATING_STYLES_SOON_LINE.includes(style), style);
    }
  });
});
