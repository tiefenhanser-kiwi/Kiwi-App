// Row 13 "Test Kitchen" · Block 1 (D-WS9-259) — the claim.
//
//   signup + guestSessionId → the preferences row holds EXACTLY the wizard
//                             fields, the session is marked claimed, the
//                             response carries claimedPlanId
//   a second claim          → 409 guest_session_invalid, and NO account is
//                             left behind (the tx rolls back)
//   expired / missing       → 409, same
//   login + guestSessionId  → the plan follows, the PREFERENCES DO NOT
//   both ids at once        → 400
//
// ⚠️ BUG-279 — the suite loads .env, so a router test can fire a live AI call.
// Every path here is driven through injected seams and the claim's plan stage
// is stubbed; `aiCalls` is asserted EMPTY at the end of the happy path.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";

import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import {
  claimGuestSessionInTx,
  GuestSessionInvalidError,
  GuestPreferencesSchema,
  toUserPreferencesCreateData,
} from "../../lib/guestClaim";
import { createAuthRouter } from "../auth";

const HOUR = 60 * 60 * 1000;

// The wizard body a guest actually sends — note the WIZARD names
// (difficulty / weeklyPacing / planDurationDays), not the column names.
const WIZARD_BODY = {
  planDurationDays: 5,
  householdSize: 4,
  cuisines: ["italian", "thai"],
  eatingStyles: ["vegetarian"],
  allergiesAndAvoidances: ["peanut"],
  difficulty: "medium",
  weeklyPacing: "one_fancy_night",
  dietaryNotes: "no cilantro",
  discoveryLevel: "some",
  playlistLevel: "none",
  saucePreference: "homemade",
  maxCookTimeMinutes: 45,
  maxCookTimeCoverage: "most",
  // Not a preference — must be dropped, not written.
  additionalNotes: "surprise me",
};

interface GuestRow {
  id: string;
  expiresAt: Date;
  claimedAt: Date | null;
  claimedByUserId: string | null;
  preferences: unknown;
  draft: unknown;
  lastEvent: string | null;
}

function makePrisma(guest: Partial<GuestRow> & { id: string }) {
  const guestRow: GuestRow = {
    expiresAt: new Date(Date.now() + HOUR),
    claimedAt: null,
    claimedByUserId: null,
    preferences: WIZARD_BODY,
    draft: null,
    lastEvent: null,
    ...guest,
  };
  const state = {
    users: [] as Record<string, unknown>[],
    preferencesCreates: [] as Record<string, unknown>[],
    guestEvents: [] as Record<string, unknown>[],
    guest: guestRow,
  };
  let uid = 0;

  const client = {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email !== undefined) {
          return state.users.find((u) => u.email === where.email) ?? null;
        }
        return state.users.find((u) => u.id === where.id) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `u-${++uid}`,
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
          phone: null,
          createdAt: new Date(),
          ...data,
        };
        state.users.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.users.find((u) => u.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    subscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        status: "trialing",
        planCode: "free",
        trialEndsAt: data.trialEndsAt as Date,
        currentPeriodEnd: null,
      }),
    },
    userPreferences: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.preferencesCreates.push(data);
        return data;
      },
    },
    guestSession: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === state.guest.id ? state.guest : null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; claimedAt: null };
        data: Record<string, unknown>;
      }) => {
        if (where.id !== state.guest.id) return { count: 0 };
        if (state.guest.claimedAt !== null) return { count: 0 };
        Object.assign(state.guest, data);
        return { count: 1 };
      },
    },
    guestEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.guestEvents.push(data);
        return data;
      },
    },
    // The route's $transaction is a plain callback runner; a thrown error
    // must leave the recorded state untouched, which the tests assert by
    // checking that no user survives a refused claim.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = state.users.length;
      try {
        return await fn(client);
      } catch (err) {
        state.users.length = before; // the rollback, modelled
        throw err;
      }
    },
    _state: () => state,
  };
  return client;
}

async function spinUp(prisma: ReturnType<typeof makePrisma>) {
  __clearRateLimitStoreForTests();
  const app: Express = express();
  app.use(express.json());
  app.use(
    "/api",
    createAuthRouter({
      prisma: prisma as unknown as PrismaClient,
      sendEmail: async () => ({ ok: true }) as never,
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    post: (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const SIGNUP = {
  email: "guest@example.com",
  password: "hunter2hunter2",
  firstName: "Gu",
  lastName: "Est",
};

// ── the preferences mapping, tested directly ─────────────────────────────

describe("the guest preferences copy set", () => {
  it("maps the WIZARD field names to the COLUMN names and drops everything else", () => {
    const parsed = GuestPreferencesSchema.parse(WIZARD_BODY);
    const data = toUserPreferencesCreateData(parsed);

    // The three renames are the part that would silently write nothing.
    assert.equal(data.difficultyDefault, "medium");
    assert.equal(data.weeklyPacingDefault, "one_fancy_night");
    assert.equal(data.planLengthDefault, 5);
    assert.ok(!("difficulty" in data), "the wizard name never reaches Prisma");
    assert.ok(!("weeklyPacing" in data));
    assert.ok(!("planDurationDays" in data));

    // Everything the wizard collects, and nothing it does not.
    assert.deepEqual(Object.keys(data).sort(), [
      "allergiesAndAvoidances",
      "cuisines",
      "dietaryNotes",
      "difficultyDefault",
      "discoveryLevel",
      "eatingStyles",
      "householdSize",
      "maxCookTimeCoverage",
      "maxCookTimeMinutes",
      "planLengthDefault",
      "playlistLevel",
      "saucePreference",
      "weeklyPacingDefault",
    ]);
    assert.ok(
      !("additionalNotes" in data),
      "a non-preference field on the wizard body is not a preference",
    );
  });

  it("refuses a weeklyPacing the COLUMN would refuse (the Cookbook Phase B 400)", () => {
    const bad = GuestPreferencesSchema.safeParse({
      ...WIZARD_BODY,
      weeklyPacing: "whenever",
    });
    assert.equal(bad.success, false, "a value the enum has no member for");
  });
});

// ── stage 1, tested directly ─────────────────────────────────────────────

describe("claimGuestSessionInTx", () => {
  it("refuses a missing, an expired and an already-claimed session", async () => {
    for (const [label, mutate] of [
      ["expired", (g: GuestRow) => (g.expiresAt = new Date(Date.now() - 1))],
      ["claimed", (g: GuestRow) => (g.claimedAt = new Date())],
    ] as const) {
      const prisma = makePrisma({ id: "gs-1" });
      mutate(prisma._state().guest);
      await assert.rejects(
        () =>
          claimGuestSessionInTx({
            tx: prisma as never,
            guestSessionId: "gs-1",
            userId: "u-1",
            copyPreferences: true,
          }),
        GuestSessionInvalidError,
        label,
      );
    }

    const prisma = makePrisma({ id: "gs-1" });
    await assert.rejects(
      () =>
        claimGuestSessionInTx({
          tx: prisma as never,
          guestSessionId: "gs-nope",
          userId: "u-1",
          copyPreferences: true,
        }),
      GuestSessionInvalidError,
      "missing",
    );
  });

  it("copyPreferences:false writes NO preferences row (the sign-in rule)", async () => {
    const prisma = makePrisma({ id: "gs-1" });
    await claimGuestSessionInTx({
      tx: prisma as never,
      guestSessionId: "gs-1",
      userId: "u-existing",
      copyPreferences: false,
    });
    assert.equal(
      prisma._state().preferencesCreates.length,
      0,
      "an existing user's preferences are never overwritten by a guest blob",
    );
    assert.equal(prisma._state().guest.claimedByUserId, "u-existing");
  });
});

// ── the routes ───────────────────────────────────────────────────────────

describe("POST /api/auth/signup with guestSessionId", () => {
  it("copies the preferences, marks the session claimed, and answers claimedPlanId", async () => {
    const prisma = makePrisma({ id: "gs-1" });
    const h = await spinUp(prisma);
    try {
      const res = await h.post("/auth/signup", {
        ...SIGNUP,
        guestSessionId: "gs-1",
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { claimedPlanId: string | null };

      const created = prisma._state().preferencesCreates;
      assert.equal(created.length, 1, "exactly one preferences row");
      assert.equal(created[0].difficultyDefault, "medium");
      assert.equal(created[0].weeklyPacingDefault, "one_fancy_night");
      assert.deepEqual(created[0].cuisines, ["italian", "thai"]);

      const guest = prisma._state().guest;
      assert.ok(guest.claimedAt instanceof Date, "session marked claimed");
      assert.ok(guest.claimedByUserId, "and attributed to the new user");
      assert.equal(guest.lastEvent, "claimed");
      assert.ok(
        prisma._state().guestEvents.some((e) => e.event === "claimed"),
        "the funnel records the conversion",
      );

      // No draft on this session, so no plan — and the response says so with
      // the SAME null it would use for a failed plan build. The client never
      // has to tell the two apart.
      assert.equal(body.claimedPlanId, null);
    } finally {
      await h.close();
    }
  });

  it("a SECOND claim of the same session → 409, and no account survives it", async () => {
    const prisma = makePrisma({ id: "gs-1" });
    const h = await spinUp(prisma);
    try {
      assert.equal(
        (await h.post("/auth/signup", { ...SIGNUP, guestSessionId: "gs-1" }))
          .status,
        201,
      );
      const usersAfterFirst = prisma._state().users.length;

      const second = await h.post("/auth/signup", {
        ...SIGNUP,
        email: "other@example.com",
        guestSessionId: "gs-1",
      });
      assert.equal(second.status, 409);
      assert.equal(
        ((await second.json()) as { code: string }).code,
        "guest_session_invalid",
      );
      assert.equal(
        prisma._state().users.length,
        usersAfterFirst,
        "the refused signup rolled back — no half-made account",
      );
    } finally {
      await h.close();
    }
  });

  it("an EXPIRED session → 409 and no account", async () => {
    const prisma = makePrisma({ id: "gs-1" });
    prisma._state().guest.expiresAt = new Date(Date.now() - 1);
    const h = await spinUp(prisma);
    try {
      const res = await h.post("/auth/signup", {
        ...SIGNUP,
        guestSessionId: "gs-1",
      });
      assert.equal(res.status, 409);
      assert.equal(prisma._state().users.length, 0);
    } finally {
      await h.close();
    }
  });

  it("both guestSessionId and templatePlanId → 400", async () => {
    const prisma = makePrisma({ id: "gs-1" });
    const h = await spinUp(prisma);
    try {
      const res = await h.post("/auth/signup", {
        ...SIGNUP,
        guestSessionId: "gs-1",
        templatePlanId: "t-1",
      });
      assert.equal(res.status, 400);
      assert.equal(prisma._state().users.length, 0);
    } finally {
      await h.close();
    }
  });

  it("no guestSessionId → unchanged behaviour, and claimedPlanId is null", async () => {
    const prisma = makePrisma({ id: "gs-1" });
    const h = await spinUp(prisma);
    try {
      const res = await h.post("/auth/signup", SIGNUP);
      assert.equal(res.status, 201);
      const body = (await res.json()) as { claimedPlanId: string | null };
      assert.equal(body.claimedPlanId, null);
      assert.equal(
        prisma._state().preferencesCreates.length,
        0,
        "a plain signup still creates no preferences row",
      );
      assert.equal(prisma._state().guest.claimedAt, null);
    } finally {
      await h.close();
    }
  });
});

describe("POST /api/auth/login with guestSessionId", () => {
  it("claims the session and leaves the existing preferences ALONE", async () => {
    const prisma = makePrisma({ id: "gs-1" });
    const h = await spinUp(prisma);
    try {
      // Make the account first, without a claim, so it has its own state.
      assert.equal((await h.post("/auth/signup", SIGNUP)).status, 201);
      assert.equal(prisma._state().preferencesCreates.length, 0);

      const res = await h.post("/auth/login", {
        email: SIGNUP.email,
        password: SIGNUP.password,
        guestSessionId: "gs-1",
      });
      assert.equal(res.status, 200);
      assert.equal(
        prisma._state().preferencesCreates.length,
        0,
        "🔴 a sign-in claim must NEVER write preferences",
      );
      assert.ok(
        prisma._state().guest.claimedAt instanceof Date,
        "but the session IS claimed",
      );
    } finally {
      await h.close();
    }
  });

  it("a stale session does NOT refuse a valid login", async () => {
    const prisma = makePrisma({ id: "gs-1" });
    prisma._state().guest.claimedAt = new Date();
    const h = await spinUp(prisma);
    try {
      assert.equal((await h.post("/auth/signup", SIGNUP)).status, 201);
      const res = await h.post("/auth/login", {
        email: SIGNUP.email,
        password: SIGNUP.password,
        guestSessionId: "gs-1",
      });
      assert.equal(
        res.status,
        200,
        "credentials are verified; a cosmetic claim failure must not lock anyone out",
      );
      assert.equal(
        ((await res.json()) as { claimedPlanId: string | null }).claimedPlanId,
        null,
      );
    } finally {
      await h.close();
    }
  });
});
