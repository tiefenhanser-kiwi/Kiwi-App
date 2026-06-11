// WS7-6 G3-fix — the one-shot in-place dish handoff used by the Meal Builder's
// dish-side Ask Kiwi flow.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  armDishHandoff,
  disarmDishHandoff,
  isDishHandoffArmed,
  deliverDishToBuilder,
} from "../dishHandoff";
import type { DraftDish } from "../parsedDishToDraft";

const draft: DraftDish = {
  name: "Garlic Green Beans",
  type: "side",
  estimatedTimeMinutes: 12,
  servingsDefault: 4,
  ingredients: [{ name: "green beans", quantity: 1, unit: "lb" }],
  steps: [{ text: "sauté" }],
};

test("deliverDishToBuilder: fires the armed consumer with the draft", () => {
  let received: DraftDish | null = null;
  armDishHandoff((d) => {
    received = d;
  });
  assert.equal(isDishHandoffArmed(), true);
  const delivered = deliverDishToBuilder(draft);
  assert.equal(delivered, true);
  assert.equal(received, draft);
});

test("deliverDishToBuilder: is one-shot — a second deliver finds nothing armed", () => {
  let count = 0;
  armDishHandoff(() => {
    count += 1;
  });
  assert.equal(deliverDishToBuilder(draft), true);
  assert.equal(isDishHandoffArmed(), false, "consumer cleared after firing");
  assert.equal(deliverDishToBuilder(draft), false, "second deliver no-ops");
  assert.equal(count, 1);
});

test("deliverDishToBuilder: returns false when nothing armed (caller falls back)", () => {
  disarmDishHandoff();
  assert.equal(isDishHandoffArmed(), false);
  assert.equal(deliverDishToBuilder(draft), false);
});

test("disarmDishHandoff: clears a pending consumer without firing it", () => {
  let fired = false;
  armDishHandoff(() => {
    fired = true;
  });
  disarmDishHandoff();
  assert.equal(isDishHandoffArmed(), false);
  assert.equal(deliverDishToBuilder(draft), false);
  assert.equal(fired, false);
});
