// Row 13 "Test Kitchen" · Block 2 Part F (R8 / D-WS9-263) — the nudge's gate.
//
// The fourth deliberate break in this block lives here: show the nudge for
// showPersonalizeNudge: false and one of these goes red.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NUDGE_BODY,
  NUDGE_PRIMARY,
  NUDGE_SECONDARY,
  NUDGE_TITLE,
  PERSONALIZE_NUDGE_DEVICE_KEY,
  shouldShowPersonalizeNudge,
} from "../personalizeNudge";

const base = { serverFlag: true, deviceDismissed: false, hasUser: true };

test("server says show, device has not dismissed, user present → SHOW", () => {
  assert.equal(shouldShowPersonalizeNudge(base), true);
});

test("🔴 showPersonalizeNudge FALSE → never shown", () => {
  assert.equal(shouldShowPersonalizeNudge({ ...base, serverFlag: false }), false);
});

test("🔴 showPersonalizeNudge ABSENT → never shown (a server that predates the field)", () => {
  assert.equal(shouldShowPersonalizeNudge({ ...base, serverFlag: undefined }), false);
});

test("'Later' on THIS device hides it here, whatever the server says", () => {
  assert.equal(
    shouldShowPersonalizeNudge({ ...base, deviceDismissed: true }),
    false,
  );
});

test("no user → never shown (a loading or signed-out Home)", () => {
  assert.equal(shouldShowPersonalizeNudge({ ...base, hasUser: false }), false);
});

test("the two flags are independent — either one hides it", () => {
  for (const serverFlag of [true, false, undefined]) {
    for (const deviceDismissed of [true, false]) {
      const expected = serverFlag === true && !deviceDismissed;
      assert.equal(
        shouldShowPersonalizeNudge({ serverFlag, deviceDismissed, hasUser: true }),
        expected,
        `server=${String(serverFlag)} device=${deviceDismissed}`,
      );
    }
  }
});

// ── the copy, ruled word for word (R8) ───────────────────────────────────

test("🔴 the four strings are Hans's copy, verbatim", () => {
  assert.equal(NUDGE_TITLE, "Your plan is saved. Welcome to Kiwi!");
  assert.equal(
    NUDGE_BODY,
    "The Test Kitchen only asked the basics. Tell Kiwi how you really cook — your skill, your gear, who's at the table — and every plan after this one fits you better.",
  );
  assert.equal(NUDGE_PRIMARY, "Personalize my plans");
  assert.equal(NUDGE_SECONDARY, "Later");
});

test("the device key is stable — changing it would re-show the nudge on every device", () => {
  assert.equal(PERSONALIZE_NUDGE_DEVICE_KEY, "personalizeNudgeLater");
});
