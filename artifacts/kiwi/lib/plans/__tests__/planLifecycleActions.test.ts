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
  shouldShowDietaryNote,
  demotionToastMessage,
} from "../planLifecycleActions";

test("canUseAgain: only a saved instance with a backing template", () => {
  assert.equal(
    canUseAgain({ source: "instance", mealPlanTemplateId: "t-1" }),
    true,
  );
  // Template-less instance (e.g. empty POST /plans) — nothing to copy.
  assert.equal(
    canUseAgain({ source: "instance", mealPlanTemplateId: null }),
    false,
  );
  // Template rows use their own Use-Plan flow.
  assert.equal(
    canUseAgain({ source: "template", mealPlanTemplateId: "t-1" }),
    false,
  );
});

test("needsActiveCompostConfirm: only the active-this-week plan", () => {
  assert.equal(needsActiveCompostConfirm(true), true);
  assert.equal(needsActiveCompostConfirm(false), false);
});

test("shouldShowDietaryNote: fires only when a dietary edit post-dates commit", () => {
  const committedAt = "2026-07-01T00:00:00.000Z";
  // Dietary edit AFTER commit → show.
  assert.equal(
    shouldShowDietaryNote({
      isDraft: false,
      committedAt,
      dietaryUpdatedAt: "2026-07-10T00:00:00.000Z",
    }),
    true,
  );
  // Dietary edit BEFORE commit → hide.
  assert.equal(
    shouldShowDietaryNote({
      isDraft: false,
      committedAt,
      dietaryUpdatedAt: "2026-06-01T00:00:00.000Z",
    }),
    false,
  );
});

test("shouldShowDietaryNote: silent on a draft even when the edit is newer", () => {
  assert.equal(
    shouldShowDietaryNote({
      isDraft: true,
      committedAt: "2026-07-01T00:00:00.000Z",
      dietaryUpdatedAt: "2026-07-10T00:00:00.000Z",
    }),
    false,
  );
});

test("shouldShowDietaryNote: silent when either timestamp is null", () => {
  assert.equal(
    shouldShowDietaryNote({
      isDraft: false,
      committedAt: null,
      dietaryUpdatedAt: "2026-07-10T00:00:00.000Z",
    }),
    false,
    "no commit anchor → silent",
  );
  assert.equal(
    shouldShowDietaryNote({
      isDraft: false,
      committedAt: "2026-07-01T00:00:00.000Z",
      dietaryUpdatedAt: null,
    }),
    false,
    "no dietary edit recorded → silent",
  );
});

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
