// WS9 3d Part 3e — plan-lifecycle decision helpers (D-WS9-001/-008/-011a/-013).
// Pins the branch logic the Plan Review + Plans-tab screens consume:
//   - canUseAgain: instance + backing template only;
//   - needsActiveCompostConfirm: active plan gets a confirm, others don't;
//   - shouldShowDietaryNote: fires only when a dietary edit post-dates commit,
//     never on a draft, silent on null timestamps;
//   - demotionToastMessage: fire/no-fire boundary + copy.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canUseAgain,
  needsActiveCompostConfirm,
  demotionToastMessage,
} from "../planLifecycleActions";

test("canUseAgain: any saved instance (3b-3 copies the instance, not a template)", () => {
  // Every saved plan is copyable now — even a template-less one.
  assert.equal(canUseAgain({ source: "instance" }), true);
  // Template rows use their own Use-Plan flow.
  assert.equal(canUseAgain({ source: "template" }), false);
});

test("needsActiveCompostConfirm: only the active-this-week plan", () => {
  assert.equal(needsActiveCompostConfirm(true), true);
  assert.equal(needsActiveCompostConfirm(false), false);
});

// NOTE: the dietary-staleness decision moved server-side (Part 3b-1); its
// boundary tests now live in api-server planStaleness.test.ts.

test("demotionToastMessage: fires with copy only when a plan was displaced", () => {
  assert.equal(
    demotionToastMessage("Weeknight Dinners", { id: "y", name: "Old Plan" }),
    "Now cooking: Weeknight Dinners. Old Plan taken off this week.",
  );
  // No displacement → no toast.
  assert.equal(demotionToastMessage("Weeknight Dinners", null), null);
  assert.equal(demotionToastMessage("Weeknight Dinners", undefined), null);
  // Displaced row with an empty name → no toast (nothing meaningful to say).
  assert.equal(
    demotionToastMessage("Weeknight Dinners", { id: "y", name: "" }),
    null,
  );
});
