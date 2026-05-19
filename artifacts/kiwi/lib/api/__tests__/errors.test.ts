import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApiError,
  ApiNetworkError,
  ApiSchemaError,
  UnauthenticatedError,
  UpgradeRequiredError,
  extractUserFacingMessage,
} from "../errors";

test("ApiError carries status + body + userFacingMessage", () => {
  const err = new ApiError("boom", {
    status: 500,
    body: { x: 1 },
    userFacingMessage: "u",
  });
  assert.equal(err.status, 500);
  assert.deepEqual(err.body, { x: 1 });
  assert.equal(err.userFacingMessage, "u");
  assert.equal(err.message, "boom");
  assert.equal(err.name, "ApiError");
});

test("UnauthenticatedError prefers userFacingMessage as the Error message", () => {
  const err = new UnauthenticatedError({
    status: 401,
    body: null,
    userFacingMessage: "Please sign in",
  });
  assert.equal(err.message, "Please sign in");
  assert.equal(err.name, "UnauthenticatedError");
  assert.ok(err instanceof ApiError);
});

test("UnauthenticatedError falls back to default message when no userFacingMessage", () => {
  const err = new UnauthenticatedError({ status: 401, body: null });
  assert.equal(err.message, "Unauthenticated");
});

test("UpgradeRequiredError prefers userFacingMessage", () => {
  const err = new UpgradeRequiredError({
    status: 402,
    body: { reason: "trial_expired" },
    userFacingMessage: "Upgrade to keep going",
  });
  assert.equal(err.message, "Upgrade to keep going");
  assert.ok(err instanceof ApiError);
});

test("ApiNetworkError holds the cause and is not an ApiError", () => {
  const cause = new Error("ECONNREFUSED");
  const err = new ApiNetworkError("offline", cause);
  assert.equal(err.message, "offline");
  assert.equal(err.cause, cause);
  assert.ok(!(err instanceof ApiError));
});

test("ApiSchemaError preserves issues and received body", () => {
  const issues = [{ path: ["x"], message: "expected string" }];
  const received = { x: 1 };
  const err = new ApiSchemaError("bad shape", issues, received);
  assert.deepEqual(err.issues, issues);
  assert.deepEqual(err.received, received);
});

test("extractUserFacingMessage: userFacingMessage wins over error + message", () => {
  const m = extractUserFacingMessage({
    userFacingMessage: "first",
    error: "second",
    message: "third",
  });
  assert.equal(m, "first");
});

test("extractUserFacingMessage: error wins when userFacingMessage absent", () => {
  const m = extractUserFacingMessage({ error: "second", message: "third" });
  assert.equal(m, "second");
});

test("extractUserFacingMessage: falls through to message", () => {
  const m = extractUserFacingMessage({ message: "third" });
  assert.equal(m, "third");
});

test("extractUserFacingMessage: undefined on missing / non-object body", () => {
  assert.equal(extractUserFacingMessage(null), undefined);
  assert.equal(extractUserFacingMessage(undefined), undefined);
  assert.equal(extractUserFacingMessage("string"), undefined);
  assert.equal(extractUserFacingMessage(42), undefined);
  assert.equal(extractUserFacingMessage({}), undefined);
  // Ignores non-string fields.
  assert.equal(extractUserFacingMessage({ error: 12 }), undefined);
});
