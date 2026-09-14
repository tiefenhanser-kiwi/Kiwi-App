// D-WS9-241 A (BUG-261) — phone + marketing consents on the signup wire.
//
//   phone + both consents            → persisted in the ONE user.create
//   marketingConsentSms without phone → 400 (a consent that cannot be
//                                        honoured is not a consent)
//   neither                           → consent keys ABSENT from the create
//                                        (Prisma defaults, like onboardingComplete)
//   bad phone                         → the SAME verdict PATCH /me/profile gives,
//                                        checked by running both routers on the
//                                        same inputs (they share phoneSchema)

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createAuthRouter } from "../auth";
import { createMeRouter } from "../me";
import { withSessionUser } from "./fixtures/sessionUserStub";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(build: (app: Express) => void): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  build(app);
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
          new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

const USER_ID = "u-bug261";

function baseRow(data: Record<string, unknown>) {
  return {
    id: USER_ID,
    email: data.email ?? "c@example.com",
    firstName: data.firstName ?? "Con",
    lastName: data.lastName ?? "Sent",
    phone: (data.phone as string | null | undefined) ?? null,
    zipCode: null,
    timezone: data.timezone ?? "America/New_York",
    accountStatus: "active",
    subscriptionStatus: "trialing",
    defaultHouseholdSize: 2,
    lastPlanDiscoveryFilters: [],
    lastPlansFilters: [],
    lastMealsFilters: [],
    // What Prisma would do: the column default unless the create wrote it.
    marketingConsentEmail: (data.marketingConsentEmail as boolean | undefined) ?? false,
    marketingConsentSms: (data.marketingConsentSms as boolean | undefined) ?? false,
    onboardingComplete: false,
    firstRunChoiceMade: false,
    passwordHash: null,
    createdAt: new Date("2026-09-13T00:00:00Z"),
  };
}

/** Stub prisma serving BOTH routers: signup creates `row`, PATCH edits it. */
function makePrisma() {
  let row: ReturnType<typeof baseRow> | null = null;
  let createdUserData: Record<string, unknown> | null = null;
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.email !== undefined) return null; // signup: email free
        return row && where.id === row.id ? row : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdUserData = data;
        row = baseRow(data);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (!row || where.id !== row.id) throw new Error("user not found");
        row = { ...row, ...data };
        return row;
      },
    },
    subscription: {
      create: async () => ({
        status: "trialing",
        planCode: "free",
        trialEndsAt: new Date("2026-09-27T00:00:00Z"),
        currentPeriodEnd: null,
      }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    _created: () => createdUserData,
    _row: () => row,
    _reset: () => {
      row = null;
      createdUserData = null;
    },
  };
  return prisma;
}

const SIGNUP_BASE = {
  email: "c@example.com",
  password: "password123",
  firstName: "Con",
  lastName: "Sent",
};

describe("POST /auth/signup — consents + phone on the wire (D-WS9-241 A, BUG-261)", () => {
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
    // The signup limiter is 10 burst per IP; the probe table below alone is
    // more than that, and it is not what this file tests.
    __clearRateLimitStoreForTests();
    return fetch(`${harness.baseUrl}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...SIGNUP_BASE, ...body }),
    });
  }

  async function patchProfile(body: Record<string, unknown>) {
    // Ensure a row exists to PATCH against.
    if (!prisma._row()) await signup({});
    return fetch(`${harness.baseUrl}/me/profile`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken(USER_ID)}`,
      },
      body: JSON.stringify(body),
    });
  }

  it("phone + both consents → 201, all three persisted in the one create, echoed on the user", async () => {
    const res = await signup({
      phone: "(555) 123-4567",
      marketingConsentEmail: true,
      marketingConsentSms: true,
    });
    assert.equal(res.status, 201);
    const created = prisma._created();
    assert.ok(created);
    assert.equal(created.phone, "(555) 123-4567");
    assert.equal(created.marketingConsentEmail, true);
    assert.equal(created.marketingConsentSms, true);
    const body = (await res.json()) as {
      user: { phone: string | null; marketingConsentEmail: boolean; marketingConsentSms: boolean };
    };
    assert.equal(body.user.phone, "(555) 123-4567");
    assert.equal(body.user.marketingConsentEmail, true);
    assert.equal(body.user.marketingConsentSms, true);
  });

  it("marketingConsentSms without a phone → 400, nothing created", async () => {
    for (const phone of [undefined, null, ""]) {
      const res = await signup({ marketingConsentSms: true, phone });
      assert.equal(res.status, 400, `phone=${JSON.stringify(phone)}`);
      assert.equal(prisma._created(), null, "no user.create on a refused consent");
    }
    const res = await signup({ marketingConsentSms: true });
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "SMS consent requires a phone number");
  });

  it("marketingConsentSms: false without a phone is fine (nothing to honour)", async () => {
    const res = await signup({ marketingConsentSms: false, marketingConsentEmail: true });
    assert.equal(res.status, 201);
    assert.equal(prisma._created()!.marketingConsentSms, false);
    assert.equal(prisma._created()!.marketingConsentEmail, true);
  });

  it("neither consent, no phone → create carries phone null and NO consent keys (Prisma defaults)", async () => {
    const res = await signup({});
    assert.equal(res.status, 201);
    const created = prisma._created()!;
    assert.equal(created.phone, null);
    assert.equal("marketingConsentEmail" in created, false);
    assert.equal("marketingConsentSms" in created, false);
    const body = (await res.json()) as {
      user: { phone: string | null; marketingConsentEmail: boolean; marketingConsentSms: boolean };
    };
    assert.equal(body.user.phone, null);
    assert.equal(body.user.marketingConsentEmail, false);
    assert.equal(body.user.marketingConsentSms, false);
  });

  it("the phone rule is PATCH /me/profile's rule — same verdict on every probe", async () => {
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
      const s = await signup({ phone });
      const p = await patchProfile({ phone });
      const expect = ok ? [201, 200] : [400, 400];
      assert.deepEqual(
        [s.status, p.status],
        expect,
        `phone=${JSON.stringify(phone.length > 12 ? `${phone.slice(0, 8)}…(${phone.length})` : phone)} signup=${s.status} patch=${p.status}`,
      );
    }
  });

  it("phone: null at signup is accepted (mirrors PATCH's nullable) and stores null", async () => {
    const res = await signup({ phone: null });
    assert.equal(res.status, 201);
    assert.equal(prisma._created()!.phone, null);
  });
});
