// BUG-219 — password-reset and email-change tokens must never reach the log.
//
// These assertions read the REAL emitted log bytes (see fixtures/bug219LogFixture.ts
// for why that needs a child process), not a restated constant. They are
// token-agnostic on purpose: rather than recomputing the token the handler
// minted — which would only ever match inside the same wall-clock second, since
// a JWT's `iat` has second resolution — they assert that NO JWT and NO deep
// link appears in the output at all. Every JWT begins "eyJ" (base64 of `{"`),
// so that prefix is a structural signature, not a guess about one token.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "bug219LogFixture.ts");

function runFixture(mode: string): { stdout: string; stderr: string } {
  let stderr = "";
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", FIXTURE, mode],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        // Production shape: no pino-pretty worker, plain JSON straight to fd 1.
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        JWT_SECRET: process.env.JWT_SECRET ?? "bug219-fixture-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return { stdout, stderr };
}

describe("BUG-219 — no account-takeover token reaches the log", () => {
  it("the reset-request handler logs the event but no token and no deep link", () => {
    const { stdout } = runFixture("handler");

    // Non-vacuity FIRST. An "absence" assertion over empty output would pass
    // for the wrong reason, so prove the line actually fired before asserting
    // what is missing from it.
    assert.ok(
      stdout.includes("password_reset_requested"),
      `expected the reset log line to have been emitted; stdout was:\n${stdout}`,
    );

    assert.ok(
      !stdout.includes("eyJ"),
      `a JWT reached the log (every JWT starts "eyJ"); stdout was:\n${stdout}`,
    );
    assert.ok(
      !stdout.includes("kiwi://"),
      `a deep link reached the log; stdout was:\n${stdout}`,
    );
    assert.ok(
      !stdout.includes("reset-password?token="),
      `a reset URL reached the log; stdout was:\n${stdout}`,
    );

    // STRUCTURAL, and the reason this test can actually fail.
    //
    // The value assertions above cannot see a source regression on their own:
    // the redact list censors `resetToken`/`resetUrl`, so re-adding them to the
    // handler still emits token-free output. Verified — that exact break stayed
    // green. Redaction is the backstop, not the guard.
    //
    // The KEY survives redaction (pino emits `"resetToken":"[Redacted]"`), so
    // asserting on key presence is what distinguishes "the source is fixed"
    // from "the source regressed and the backstop caught it". Both matter, and
    // only the second one is a bug.
    for (const key of ["resetToken", "resetUrl", "verifyToken", "verifyUrl"]) {
      assert.ok(
        !stdout.includes(key),
        `the handler passed a "${key}" field to the logger — redaction censored the value, but the field must not be there at all; stdout was:\n${stdout}`,
      );
    }
    // Nothing sensitive should reach the redactor on this path in the first
    // place, so the censor marker firing at all is itself the signal.
    assert.ok(
      !stdout.includes("[Redacted]"),
      `redaction fired on the reset path, meaning a sensitive field was still handed to the logger; stdout was:\n${stdout}`,
    );
  });

  it("the email-change VERIFY handler logs no address (the fa1859c leftover)", () => {
    // `fa1859c` removed `newEmail` from the email-change REQUEST log and left
    // it on the VERIFY line. Hans ruled the field out of logs outright — an
    // address is PII and a retained sink is the wrong place for it, whichever
    // handler writes it — so the same rule applies to the second site.
    const { stdout } = runFixture("verify");

    assert.ok(
      stdout.includes("email_change_verified"),
      `expected the verify log line to have been emitted; stdout was:\n${stdout}`,
    );
    assert.ok(
      !stdout.includes("bug219-verify-leak@example.test"),
      `the verify handler leaked an email address into the log; stdout was:\n${stdout}`,
    );
    assert.ok(
      !stdout.includes("newEmail"),
      `a "newEmail" field is still being passed to the logger; stdout was:\n${stdout}`,
    );
    assert.ok(
      !stdout.includes("eyJ"),
      `a JWT reached the log; stdout was:\n${stdout}`,
    );
  });

  it("pino's redact list censors every token field name, live", () => {
    const { stdout } = runFixture("redact");

    assert.ok(
      stdout.includes("bug219_redact_probe"),
      `expected the redact probe line to have been emitted; stdout was:\n${stdout}`,
    );
    // The fixture logged six fields whose values all contain "eyJ". If the
    // redact list covers them, not one survives.
    assert.ok(
      !stdout.includes("eyJ"),
      `redact did not censor a token field; stdout was:\n${stdout}`,
    );
    assert.ok(
      !stdout.includes("kiwi://"),
      `redact did not censor a deep-link field; stdout was:\n${stdout}`,
    );
    assert.ok(
      stdout.includes("[Redacted]"),
      `expected pino's censor marker in the output; stdout was:\n${stdout}`,
    );
  });
});
