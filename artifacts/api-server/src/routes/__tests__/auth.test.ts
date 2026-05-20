// WS7-2 Block A — GET /auth/me response shape widening.
// Confirms the new onboardingComplete + firstRunChoiceMade booleans are
// included alongside the existing user payload.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createAuthRouter } from "../auth";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(createAuthRouter({ prisma: prisma as never }));

  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

describe("GET /auth/me — onboarding + first-run-choice widening (WS7-2 Block A)", () => {
  let harness: Harness;

  const USER_ID = "test-user-auth-me-widen";
  const prisma = {
    user: {
      findUnique: async () => ({
        id: USER_ID,
        email: "widen@example.com",
        firstName: "Widen",
        lastName: "Test",
        phone: null,
        zipCode: null,
        timezone: "America/New_York",
        accountStatus: "active",
        subscriptionStatus: "trialing",
        defaultHouseholdSize: 2,
        lastPlanDiscoveryFilters: [],
        lastPlansFilters: [],
        lastMealsFilters: [],
        onboardingComplete: true,
        firstRunChoiceMade: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        subscription: {
          status: "trialing",
          planCode: "free",
          trialEndsAt: new Date("2026-02-01T00:00:00Z"),
          currentPeriodEnd: null,
        },
      }),
    },
  };

  before(async () => {
    harness = await spinUp(prisma);
  });
  after(async () => harness.close());

  it("includes onboardingComplete + firstRunChoiceMade in the user payload", async () => {
    const token = signToken(USER_ID);
    const res = await fetch(`${harness.baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      user: {
        id: string;
        onboardingComplete: boolean;
        firstRunChoiceMade: boolean;
        subscription: { planCode: string };
      };
    };
    assert.equal(body.user.id, USER_ID);
    assert.equal(body.user.onboardingComplete, true);
    assert.equal(body.user.firstRunChoiceMade, false);
    // Sanity: existing fields still round-trip.
    assert.equal(body.user.subscription.planCode, "free");
  });
});
