// D-WS9-241 A (BUG-261) — lib/phone.ts mirrors the server's phone rule
// (artifacts/api-server/src/lib/phoneValidation.ts). The probe table is the
// SAME one the server test bug261SignupConsents runs through both routers:
// if either side changes, one of the two files goes red.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PHONE_MAX_LENGTH, PHONE_REGEX, isValidPhone } from "../phone";

test("mirrors the server constants exactly", () => {
  assert.equal(PHONE_MAX_LENGTH, 40);
  assert.equal(PHONE_REGEX.source, "(?:\\D*\\d){7,}");
  assert.equal(PHONE_REGEX.flags, "");
});

test("same verdicts as the server on the shared probe table", () => {
  const probes: Array<{ phone: string; ok: boolean }> = [
    { phone: "(555) 123-4567", ok: true },
    { phone: "+1 555 123 4567", ok: true },
    { phone: "5551234", ok: true }, // exactly 7 digits
    { phone: "555123", ok: false }, // 6 digits
    { phone: "call me", ok: false },
    { phone: "", ok: false },
    { phone: "1".repeat(41), ok: false }, // over the 40-char cap
    { phone: "1".repeat(40), ok: true },
  ];
  for (const { phone, ok } of probes) {
    assert.equal(isValidPhone(phone), ok, `phone=${JSON.stringify(phone.slice(0, 12))}`);
  }
});
