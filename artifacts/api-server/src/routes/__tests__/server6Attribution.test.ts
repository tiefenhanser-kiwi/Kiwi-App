// SERVER-6 A (ATTR) — where each signup came from, on the password door and the
// profile PATCH (the OAuth doors are in oauthRoutes.test.ts):
//
//   POST /auth/signup { attribution }  → sanitized into the ONE user.create
//                                         (five keys, strings ≤ 120, the rest dropped);
//                                         nothing usable → the key is absent (NULL)
//   a Test Kitchen claim                → the same create, signupSource test_kitchen
//   PATCH /me/profile { howHeard, howHeardDetail }
//                                       → set once (write-if-null); a second set is
//                                         a 200 that changes nothing; the rest of the
//                                         body still lands; the user shape says it

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createAuthRouter } from "../auth";
import { createMeRouter } from "../me";
import { withSessionUser } from "./fixtures/sessionUserStub";

const USER_ID = "u-server6";

function baseRow(data: Record<string, unknown>) {
  return {
    id: USER_ID,
    email: data.email ?? "a@example.com",
    firstName: data.firstName ?? "Att",
    lastName: data.lastName ?? "Ribution",
    phone: null,
    zipCode: null,
    timezone: "America/New_York",
    accountStatus: "active",
    subscriptionStatus: "trialing",
    defaultHouseholdSize: 2,
    lastPlanDiscoveryFilters: [],
    lastPlansFilters: [],
    lastMealsFilters: [],
    marketingConsentEmail: false,
    marketingConsentSms: false,
    onboardingComplete: false,
    firstRunChoiceMade: false,
    signupSource: (data.signupSource as string | null | undefined) ?? null,
    signupAttribution: data.signupAttribution ?? null,
    howHeard: null as string | null,
    howHeardDetail: null as string | null,
    personalizeNudgeDismissedAt: null,
    passwordHash: null,
    createdAt: new Date("2026-10-27T00:00:00Z"),
  };
}

function makePrisma() {
  let row: ReturnType<typeof baseRow> | null = null;
  let created: Record<string, unknown> | null = null;
  const prisma = {
    user: {
      findFirst: async () => null,
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.email !== undefined) return null;
        return row && where.id === row.id ? row : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created = data;
        row = baseRow(data);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (!row || where.id !== row.id) throw new Error("user not found");
        row = { ...row, ...data };
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!row || where.id !== row.id) return { count: 0 };
        if ("howHeard" in where && row.howHeard !== where.howHeard) return { count: 0 };
        row = { ...row, ...data } as typeof row;
        return { count: 1 };
      },
    },
    subscription: {
      create: async () => ({ status: "trialing", planCode: "free", trialEndsAt: new Date("2026-11-10T00:00:00Z"), currentPeriodEnd: null }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    _created: () => created,
    _row: () => row,
    _reset: () => {
      row = null;
      created = null;
    },
  };
  return prisma;
}

interface Harness { baseUrl: string; close: () => Promise<void> }

async function spinUp(build: (app: Express) => void): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  build(app);
  return await new Promise<Harness>((resolve) => {
    const server: Server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const SIGNUP = { email: "a@example.com", password: "password123", firstName: "Att", lastName: "Ribution" };

describe("SERVER-6 A — attribution on POST /auth/signup, howHeard on PATCH /me/profile", () => {
  let harness: Harness;
  const prisma = makePrisma();

  before(async () => {
    harness = await spinUp((app) => {
      const p = withSessionUser(prisma) as never;
      app.use(createAuthRouter({ prisma: p }));
      app.use(createMeRouter({ prisma: p }));
    });
  });
  after(async () => harness.close());

  async function signup(body: Record<string, unknown>) {
    prisma._reset();
    __clearRateLimitStoreForTests();
    return fetch(`${harness.baseUrl}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...SIGNUP, ...body }),
    });
  }
  const patch = (body: Record<string, unknown>) =>
    fetch(`${harness.baseUrl}/me/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(USER_ID)}` },
      body: JSON.stringify(body),
    });

  it("writes the sanitized attribution in the one create: five keys, trimmed, cut to 120, the rest dropped", async () => {
    const res = await signup({
      platform: "web",
      attribution: {
        ref: "  maya\u0000 ",
        utmSource: "instagram",
        utmMedium: "",
        utmCampaign: "c".repeat(300),
        landingPath: "/welcome?x=1",
        gclid: "not-kept",
        fbclid: 12,
      },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(prisma._created()!.signupAttribution, {
      ref: "maya",
      utmSource: "instagram",
      utmCampaign: "c".repeat(120),
      landingPath: "/welcome?x=1",
    });
    assert.equal(prisma._created()!.signupSource, "web");
    const body = (await res.json()) as { user: Record<string, unknown> };
    assert.equal(body.user.howHeard, null, "the user shape says it is not answered yet");
    assert.equal(body.user.howHeardDetail, null);
  });

  it("a body without one, or with nothing usable, writes no attribution; a bad shape is not a 400", async () => {
    // SERVER-7 C (D-WS9-336) — a bare "/" alone is no link either.
    for (const attribution of [undefined, null, "ref=maya", ["maya"], { ref: 5 }, { other: "x" }, { ref: "   " }, { landingPath: "/" }]) {
      const res = await signup(attribution === undefined ? {} : { attribution });
      assert.equal(res.status, 201, `attribution ${JSON.stringify(attribution)}`);
      assert.equal("signupAttribution" in prisma._created()!, false);
    }
  });

  it("howHeard is set once: the first answer lands, a second is a 200 that changes nothing", async () => {
    await signup({});
    const first = await patch({ howHeard: "creator", howHeardDetail: "  Maya Cooks  " });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { user: Record<string, unknown> };
    assert.equal(firstBody.user.howHeard, "creator");
    assert.equal(firstBody.user.howHeardDetail, "Maya Cooks");

    const second = await patch({ howHeard: "google", firstName: "Renamed" });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { user: Record<string, unknown> };
    assert.equal(secondBody.user.howHeard, "creator", "the first answer stands");
    assert.equal(secondBody.user.howHeardDetail, "Maya Cooks");
    assert.equal(secondBody.user.firstName, "Renamed", "the rest of the body still lands");
  });

  it("refuses a value off the list, a detail over 80, and a detail without howHeard; a blank detail is null", async () => {
    await signup({});
    assert.equal((await patch({ howHeard: "billboard" })).status, 400);
    assert.equal((await patch({ howHeard: "other", howHeardDetail: "d".repeat(81) })).status, 400);
    const orphan = await patch({ howHeardDetail: "Maya" });
    assert.equal(orphan.status, 400);
    assert.deepEqual(await orphan.json(), { error: "howHeardDetail requires howHeard" });
    assert.equal(prisma._row()!.howHeard, null, "nothing was written by a refusal");
    const blank = await patch({ howHeard: "friend", howHeardDetail: "   " });
    assert.equal(blank.status, 200);
    assert.equal(prisma._row()!.howHeard, "friend");
    assert.equal(prisma._row()!.howHeardDetail, null);
  });
});
