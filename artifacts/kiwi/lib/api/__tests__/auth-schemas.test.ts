// Universal Zod adoption (WS7-1 Decision 4) — sanity tests for the schemas
// shipped in commit 3 / 4. Each schema is exercised once on a known-good
// payload and once on a parse failure to make sure the schema actually
// validates (`.passthrough()` is permissive but the required keys still
// need to be present).

import assert from "node:assert/strict";
import { test } from "node:test";

import { LoginResponseSchema, MeUserSchema, SignupResponseSchema } from "../../auth";

const VALID_USER = {
  id: "u1",
  email: "a@b.co",
  firstName: "A",
  lastName: "B",
  phone: null,
  zipCode: null,
  timezone: "America/New_York",
  accountStatus: "active",
  subscriptionStatus: "trialing",
  defaultHouseholdSize: 4,
  lastPlanDiscoveryFilters: [],
  lastPlansFilters: [],
  lastMealsFilters: [],
  subscription: null,
  createdAt: "2026-05-19T00:00:00.000Z",
};

test("MeUserSchema accepts a valid user", () => {
  const parsed = MeUserSchema.parse(VALID_USER);
  assert.equal(parsed.email, "a@b.co");
});

test("MeUserSchema rejects when defaultHouseholdSize is wrong type", () => {
  const bad = { ...VALID_USER, defaultHouseholdSize: "four" };
  const result = MeUserSchema.safeParse(bad);
  assert.equal(result.success, false);
});

test("MeUserSchema accepts a nested Subscription block", () => {
  const withSub = {
    ...VALID_USER,
    subscription: {
      status: "trialing",
      planCode: "free",
      trialEndsAt: "2026-06-19T00:00:00.000Z",
      currentPeriodEnd: null,
    },
  };
  const parsed = MeUserSchema.parse(withSub);
  assert.equal(parsed.subscription?.planCode, "free");
});

test("MeUserSchema passes through unknown extra fields", () => {
  const withExtras = { ...VALID_USER, futureField: "ok" };
  // .passthrough() — extra fields preserved on parse output.
  const parsed = MeUserSchema.parse(withExtras) as unknown as {
    futureField: string;
  };
  assert.equal(parsed.futureField, "ok");
});

test("LoginResponseSchema requires authToken", () => {
  const ok = LoginResponseSchema.parse({ user: VALID_USER, authToken: "t" });
  assert.equal(ok.authToken, "t");
  assert.equal(
    LoginResponseSchema.safeParse({ user: VALID_USER }).success,
    false,
  );
});

test("SignupResponseSchema accepts onboardingRequired = true (optional)", () => {
  const parsed = SignupResponseSchema.parse({
    user: VALID_USER,
    authToken: "t",
    onboardingRequired: true,
  });
  assert.equal(parsed.onboardingRequired, true);

  // Missing onboardingRequired is OK (optional).
  const parsed2 = SignupResponseSchema.parse({
    user: VALID_USER,
    authToken: "t",
  });
  assert.equal(parsed2.onboardingRequired, undefined);
});
