// CLIENT-7 B (BUG-603) — SERVER-9's 400 `password_too_common`, said under the
// password field on sign-up, reset and change. app/** is outside the test glob, so
// the screens' wiring is pinned at source level (orderOnlineWiring precedent).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError, ApiNetworkError, extractUserFacingMessage } from "@/lib/api/errors";
import {
  PASSWORD_TOO_COMMON,
  PASSWORD_TOO_COMMON_COPY,
  authErrorPresentation,
  passwordTooCommonMessage,
} from "../authErrorCopy";

/** What apiClient throws for a 4xx body (client.ts: message = userFacingMessage). */
function apiError(status: number, body: unknown): ApiError {
  const userFacingMessage = extractUserFacingMessage(body);
  return new ApiError(userFacingMessage ?? `Request failed (${status})`, { status, body, userFacingMessage });
}

// SERVER-9's body, verbatim (api-server lib/commonPasswords.ts passwordTooCommonBody).
const SERVER_LINE = "That password is too common. Try a longer phrase only you would use.";
const SERVER_BODY = { error: PASSWORD_TOO_COMMON, userFacingMessage: SERVER_LINE };

test("the server's own words, from { error: password_too_common, userFacingMessage }", () => {
  assert.equal(passwordTooCommonMessage(apiError(400, SERVER_BODY)), SERVER_LINE);
  const other = "Pick something only you would think of.";
  assert.equal(passwordTooCommonMessage(apiError(400, { ...SERVER_BODY, userFacingMessage: other })), other);
});

test("the error with no words of its own: the client's line", () => {
  assert.equal(passwordTooCommonMessage(apiError(400, { error: PASSWORD_TOO_COMMON })), PASSWORD_TOO_COMMON_COPY);
  assert.equal(passwordTooCommonMessage(apiError(400, { error: PASSWORD_TOO_COMMON, userFacingMessage: "  " })), PASSWORD_TOO_COMMON_COPY);
});

test("anything else is not it: an older server's 400s, another status, no ApiError", () => {
  assert.equal(passwordTooCommonMessage(apiError(400, { error: "invalid request body" })), null);
  assert.equal(passwordTooCommonMessage(apiError(400, { error: "email already registered" })), null);
  assert.equal(passwordTooCommonMessage(apiError(400, { error: "invalid or expired reset token" })), null);
  assert.equal(passwordTooCommonMessage(apiError(400, { error: "invalid_current_password" })), null);
  assert.equal(passwordTooCommonMessage(apiError(400, { userFacingMessage: SERVER_LINE })), null);
  assert.equal(passwordTooCommonMessage(apiError(422, SERVER_BODY)), null);
  assert.equal(passwordTooCommonMessage(apiError(400, null)), null);
  assert.equal(passwordTooCommonMessage(new ApiNetworkError("offline")), null);
  assert.equal(passwordTooCommonMessage(new Error(SERVER_LINE)), null);
  assert.equal(passwordTooCommonMessage(undefined), null);
});

test("BUG-296's presentation is unchanged for the same error (the screens branch before it)", () => {
  assert.deepEqual(authErrorPresentation(apiError(400, SERVER_BODY), "Signup failed"), { message: SERVER_LINE, retryAfterSec: null });
});

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, "../../app", p), "utf8");

/** The handler's catch, from `catch (err)` to the next `finally`. */
function catchBlock(src: string): string {
  const start = src.indexOf("} catch (err) {", src.indexOf("const tooCommon") - 200);
  return src.slice(start, src.indexOf("} finally {", start));
}

test("sign-up: the line under the password field, no dialog, cleared by typing", () => {
  const src = read("(auth)/sign-up.tsx");
  const c = catchBlock(src);
  assert.match(c, /const tooCommon = passwordTooCommonMessage\(err\);\s*if \(tooCommon !== null\) \{\s*setPasswordError\(tooCommon\);\s*return;/);
  assert.ok(c.indexOf("setPasswordError(tooCommon)") < c.indexOf("dialog.alert"), "branches before the generic dialog");
  const field = src.indexOf("placeholder={PASSWORD_PLACEHOLDER}");
  const line = src.indexOf("{passwordError && <Text style={styles.errorText}>{passwordError}</Text>}");
  const helper = src.indexOf("<Text style={styles.helper}>{PASSWORD_HELPER}</Text>");
  assert.ok(field > 0 && line > field && helper > line, "password field → the line → the helper");
  assert.match(src, /setPassword\(v\);\s*setPasswordError\(null\);/);
});

test("reset: the line under New password, and the link is NOT declared dead", () => {
  const src = read("(auth)/reset-password.tsx");
  const c = catchBlock(src);
  const tooCommon = c.indexOf("setPasswordError(tooCommon)");
  const invalid = c.indexOf('setStage("invalid")');
  assert.ok(tooCommon > 0 && invalid > tooCommon, "the code is read before any 400 means a dead link");
  assert.match(c, /if \(tooCommon !== null\) \{[\s\S]*?\} else if \(err instanceof ApiError && err.status === 400\)/);
  const field = src.indexOf('placeholder="New password"');
  const line = src.indexOf("{passwordError && <Text style={styles.errorText}>{passwordError}</Text>}");
  const confirm = src.indexOf('placeholder="Confirm new password"');
  assert.ok(field > 0 && line > field && confirm > line, "New password → the line → Confirm");
  assert.match(src, /setPassword\(v\);\s*setPasswordError\(null\);/);
});

test("change password (Profile): the line under New password, not the form's status line", () => {
  const src = read("(tabs)/profile.tsx");
  const c = catchBlock(src);
  assert.match(c, /const tooCommon = passwordTooCommonMessage\(err\);\s*if \(tooCommon !== null\) \{\s*setNewPwError\(tooCommon\);\s*return;/);
  assert.ok(c.indexOf("setNewPwError(tooCommon)") < c.indexOf("setPwStatus"), "branches before the status line");
  const row = src.slice(src.indexOf('label="New password"'), src.indexOf('label="Confirm new password"'));
  assert.match(row, /error=\{newPwError\}/);
  assert.match(row, /setNewPw\(v\);\s*setNewPwError\(null\);/);
  assert.match(src, /\{error \? <Text style=\{\[s\.pwFieldError, s\.statusError\]\}>\{error\}<\/Text> : null\}/, "PasswordRow says it under its input");
});
