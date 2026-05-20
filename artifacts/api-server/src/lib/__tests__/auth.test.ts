// WS7-2 Block A — signToken / verifyToken purpose claim tests.
// Pure unit tests against the lib; no DB / HTTP harness needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import { signToken, verifyToken } from "../auth";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET required for tests");

describe("signToken / verifyToken — purpose claim", () => {
  it("defaults to session purpose when none is provided", () => {
    const token = signToken("u-1");
    const payload = verifyToken(token);
    assert.ok(payload);
    assert.equal(payload.userId, "u-1");
    assert.equal(payload.purpose, "session");
  });

  it("session token verifies under expectedPurpose='session'", () => {
    const token = signToken("u-2");
    const payload = verifyToken(token, "session");
    assert.ok(payload);
    assert.equal(payload.purpose, "session");
  });

  it("password_reset token rejected when expecting session", () => {
    const token = signToken("u-3", { purpose: "password_reset", expiresIn: "1h" });
    const payload = verifyToken(token, "session");
    assert.equal(payload, null);
  });

  it("password_reset token verifies under expectedPurpose='password_reset'", () => {
    const token = signToken("u-4", { purpose: "password_reset", expiresIn: "1h" });
    const payload = verifyToken(token, "password_reset");
    assert.ok(payload);
    assert.equal(payload.userId, "u-4");
    assert.equal(payload.purpose, "password_reset");
  });

  it("backward-compat: tokens minted before the purpose claim existed read as session", () => {
    // Hand-crafted legacy token: { userId } only, no purpose field.
    const legacy = jwt.sign({ userId: "u-legacy" }, JWT_SECRET!, {
      expiresIn: "30d",
    });
    const payload = verifyToken(legacy);
    assert.ok(payload);
    assert.equal(payload.userId, "u-legacy");
    assert.equal(payload.purpose, "session");
  });

  it("extra claims (e.g. newEmail) survive the round-trip", () => {
    const token = signToken("u-5", {
      purpose: "email_change",
      expiresIn: "1h",
      extra: { newEmail: "fresh@example.com" },
    });
    const payload = verifyToken(token, "email_change");
    assert.ok(payload);
    assert.equal(payload.userId, "u-5");
    assert.equal(payload.newEmail, "fresh@example.com");
  });
});

describe("password-reset token expiry — WS7-2 Block A locked decision 3", () => {
  it("expires 1 hour after issuance (exp - iat === 3600 seconds)", () => {
    const token = signToken("u-exp", {
      purpose: "password_reset",
      expiresIn: "1h",
    });
    const decoded = jwt.decode(token) as { iat: number; exp: number } | null;
    assert.ok(decoded);
    assert.equal(decoded.exp - decoded.iat, 3600);
  });

  it("already-expired reset token is rejected", () => {
    // Mint a token that expired 1 second ago.
    const expired = jwt.sign(
      { userId: "u-stale", purpose: "password_reset" },
      JWT_SECRET!,
      { expiresIn: "-1s" },
    );
    const payload = verifyToken(expired, "password_reset");
    assert.equal(payload, null);
  });
});
