// Row 13 "Test Kitchen" · Block 2 Part D (R4, R5, R6) — the door guard.
//
// The third deliberate break in this block lives here: let a guest through a
// write action and one of these goes red.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOOR_APP_NOTE,
  DOOR_INTRO,
  DOOR_NATIVE_INTRO,
  DOOR_NATIVE_NOTE,
  DOOR_PRIMARY,
  doorCopy,
  DOOR_SECONDARY,
  DOOR_SIGN_IN,
  DOOR_TITLE,
  DOOR_UNLOCKS,
  GUEST_ACTIONS,
  THIN_SHELF_TITLE,
  THIN_SHELF_TITLE_NATIVE,
  thinShelfTitle,
  guestDoorActions,
  guestGuard,
  type GuestAction,
} from "../doors";

const ALL = Object.keys(GUEST_ACTIONS) as GuestAction[];

// ── the invariant ────────────────────────────────────────────────────────

test("🔴 for a GUEST, every write-shaped action is a door — no exceptions", () => {
  for (const action of ALL) {
    const expected = GUEST_ACTIONS[action].write ? "door" : "allow";
    assert.equal(guestGuard({ isGuest: true, action }), expected, action);
  }
  // And the writes are not an empty set, so the loop above cannot pass vacuously.
  assert.ok(guestDoorActions().length >= 10);
});

test("🔴 every one of R4's named actions is on the door list", () => {
  // Hans's list, verbatim: "grocery list · Order Online · save / edit / swap /
  // add meals · Prep & Cook · a second generation · playlist · anything under
  // Profile".
  for (const action of [
    "grocery_list",
    "order_online",
    "save_plan",
    "edit_plan",
    "swap_meal",
    "add_meal",
    "prep_cook",
    "second_generation",
    "playlist",
    "profile",
  ] as GuestAction[]) {
    assert.equal(guestGuard({ isGuest: true, action }), "door", action);
  }
});

test("reads are free (R4) — the plan, a candidate and the full recipe", () => {
  for (const action of ["open_plan", "open_candidate", "open_recipe"] as GuestAction[]) {
    assert.equal(guestGuard({ isGuest: true, action }), "allow", action);
  }
});

test("🔴 a MEMBER is never gated — the guard adds nothing to that path", () => {
  for (const action of ALL) {
    assert.equal(guestGuard({ isGuest: false, action }), "allow", action);
  }
});

test("the thin shelf is a door, not a failure (R6)", () => {
  assert.equal(guestGuard({ isGuest: true, action: "thin_shelf" }), "door");
});

test("guestDoorActions lists exactly the writes", () => {
  const doors = guestDoorActions();
  for (const action of ALL) {
    assert.equal(doors.includes(action), GUEST_ACTIONS[action].write, action);
  }
});

// ── the copy (R5, §8.2–8.3) ──────────────────────────────────────────────

test("the door says ACCOUNT FIRST and names the app only as a note", () => {
  assert.equal(DOOR_TITLE, "Here's the plan you made");
  assert.equal(DOOR_PRIMARY, "Create my free account — save my plan");
  assert.equal(DOOR_SECONDARY, "Keep looking");
  assert.match(DOOR_APP_NOTE, /app comes right after/i);
  assert.match(DOOR_SIGN_IN, /Already have an account/i);
});

test("🔴 NO price and NO 'trial' wording anywhere on the door — payments do not exist yet", () => {
  const everything = [
    DOOR_TITLE,
    DOOR_PRIMARY,
    DOOR_SECONDARY,
    DOOR_APP_NOTE,
    DOOR_SIGN_IN,
    THIN_SHELF_TITLE,
    ...DOOR_UNLOCKS,
  ].join(" ");
  assert.equal(/trial/i.test(everything), false, "the word 'trial'");
  assert.equal(/\$|\bUSD\b|\bper month\b|\bpermonth\b|\b\/mo\b/i.test(everything), false, "a price");
});

test("the unlock list is the six ruled lines", () => {
  assert.equal(DOOR_UNLOCKS.length, 6);
  assert.match(DOOR_UNLOCKS[0], /Save, edit and re-use this plan/);
  assert.match(DOOR_UNLOCKS.join(" "), /Unlimited plans/);
  assert.match(DOOR_UNLOCKS.join(" "), /grocery list and online ordering/);
  assert.match(DOOR_UNLOCKS.join(" "), /Your own meals/);
  assert.match(DOOR_UNLOCKS.join(" "), /Prep & Cook/);
  assert.match(DOOR_UNLOCKS.join(" "), /Find and share recipes/);
});

test("the thin-shelf line is Hans's copy, verbatim (R6)", () => {
  assert.equal(
    THIN_SHELF_TITLE,
    "Access to the full Kiwi meal library and meals that meet unique dietary needs and preferences is available in the app — sign up here.",
  );
});

// ── Resub C1 — the same door, in the app ─────────────────────────────────

test("🔴 web keeps its door word for word — 'the app comes right after'", () => {
  const web = doorCopy("web");
  assert.equal(web.intro, DOOR_INTRO);
  assert.equal(web.note, DOOR_APP_NOTE);
  assert.match(web.note, /app comes right after/i);
  assert.equal(web.primary, DOOR_PRIMARY);
  assert.equal(web.title, DOOR_TITLE);
  assert.deepEqual(web.unlocks, DOOR_UNLOCKS);
});

test("🔴 on iOS and Android the account is made right here — no 'app comes after'", () => {
  for (const os of ["ios", "android"]) {
    const native = doorCopy(os);
    assert.equal(native.intro, "Create a free account to save this plan and keep going. An account gets you:");
    assert.equal(native.note, "Your plan comes with you — nothing to build again.");
    assert.equal(native.intro, DOOR_NATIVE_INTRO);
    assert.equal(native.note, DOOR_NATIVE_NOTE);
    assert.doesNotMatch(`${native.intro} ${native.note}`, /\bthe app\b|app store|download/i, os);
    // Everything else is the web door's, so the two cannot drift.
    assert.equal(native.title, DOOR_TITLE);
    assert.equal(native.primary, DOOR_PRIMARY);
    assert.equal(native.secondary, DOOR_SECONDARY);
    assert.equal(native.signIn, DOOR_SIGN_IN);
    assert.deepEqual(native.unlocks, DOOR_UNLOCKS);
  }
});

test("the native lines keep the door's rule: no price and no 'trial'", () => {
  const lines = `${DOOR_NATIVE_INTRO} ${DOOR_NATIVE_NOTE}`;
  assert.equal(/trial/i.test(lines), false);
  assert.equal(/\$|\bUSD\b|\bper month\b|\b\/mo\b/i.test(lines), false);
});

// ── Resub C2 §7 — the thin-shelf line IN the app ──────────────────────────

test("🔴 the thin-shelf line: web keeps Hans's sentence; native says the library comes with an account", () => {
  assert.equal(thinShelfTitle("web"), THIN_SHELF_TITLE);
  for (const os of ["ios", "android"]) {
    assert.equal(
      thinShelfTitle(os),
      "Access to the full Kiwi meal library and meals that meet unique dietary needs and preferences comes with an account — sign up here.",
    );
    assert.doesNotMatch(thinShelfTitle(os), /in the app/, os);
  }
  assert.equal(THIN_SHELF_TITLE_NATIVE, thinShelfTitle("ios"));
});
