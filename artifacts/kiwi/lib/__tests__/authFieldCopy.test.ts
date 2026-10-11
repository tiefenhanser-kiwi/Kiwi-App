// WEB-2 Part H (BUG-365) — short placeholders, the detail under the field.
// app/** is outside the test glob, so the screens' wiring is pinned at source
// level (orderOnlineWiring precedent).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PASSWORD_HELPER, PASSWORD_PLACEHOLDER, PHONE_PLACEHOLDER } from "../authFieldCopy";

const here = dirname(fileURLToPath(import.meta.url));
const signUp = readFileSync(resolve(here, "../../app/(auth)/sign-up.tsx"), "utf8");
const signIn = readFileSync(resolve(here, "../../app/(auth)/sign-in.tsx"), "utf8");

test("BUG-365: the strings", () => {
  assert.equal(PASSWORD_PLACEHOLDER, "Password");
  assert.equal(PASSWORD_HELPER, "At least 8 characters");
  assert.equal(PHONE_PLACEHOLDER, "Phone (optional)");
});

test("BUG-365 sign-up: the short placeholders, and the rule as helper text under the password field", () => {
  assert.match(signUp, /placeholder=\{PASSWORD_PLACEHOLDER\}/);
  assert.match(signUp, /placeholder=\{PHONE_PLACEHOLDER\}/);
  assert.doesNotMatch(signUp, /\(min 8 characters\)/, "the long placeholder is gone");
  assert.doesNotMatch(signUp, /Phone number \(optional\)/, "the long placeholder is gone");
  // The helper renders between the password field and the phone field.
  const pw = signUp.indexOf("placeholder={PASSWORD_PLACEHOLDER}");
  const helper = signUp.indexOf("<Text style={styles.helper}>{PASSWORD_HELPER}</Text>");
  const phone = signUp.indexOf("placeholder={PHONE_PLACEHOLDER}");
  assert.ok(pw > 0 && helper > pw && phone > helper, "password field → helper → phone field");
  assert.match(signUp, /accessibilityHint=\{PASSWORD_HELPER\}/, "a screen reader hears the rule on the field");
});

test("BUG-365 sign-in: already short — 'Email' and 'Password'", () => {
  assert.match(signIn, /placeholder="Email"/);
  assert.match(signIn, /placeholder="Password"/);
});
