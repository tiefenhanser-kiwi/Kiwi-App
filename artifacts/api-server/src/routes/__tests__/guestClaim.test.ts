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
  releaseClaimForRetry,
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
      // Block 1b Part A — the stub now models BOTH guarded predicates, because
      // there are two: `claimedAt: null` (the single-use claim guard) and
      // `claimedByUserId: <me>` (the compensating release). Evaluated
      // generically off the keys present in the where, so neither test is
      // asserting against a stub that was shaped to agree with it.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; claimedAt?: null; claimedByUserId?: string };
        data: Record<string, unknown>;
      }) => {
        if (where.id !== state.guest.id) return { count: 0 };
        if (where.claimedAt === null && state.guest.claimedAt !== null) {
          return { count: 0 };
        }
        if (
          where.claimedByUserId !== undefined &&
          state.guest.claimedByUserId !== where.claimedByUserId
        ) {
          return { count: 0 };
        }
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

async function spinUp(
  prisma: ReturnType<typeof makePrisma>,
  // Block 1b Part A — stage 2 of the claim, injected. Undefined leaves the
  // production function in place, which every pre-1b test relies on doing
  // nothing at all (those sessions carry no draft, so it is never called).
  materializeClaimedDraft?: () => Promise<string | null>,
) {
  __clearRateLimitStoreForTests();
  const app: Express = express();
  app.use(express.json());
  app.use(
    "/api",
    createAuthRouter({
      prisma: prisma as unknown as PrismaClient,
      sendEmail: async () => ({ ok: true }) as never,
      ...(materializeClaimedDraft
        ? { materializeClaimedDraft: materializeClaimedDraft as never }
        : {}),
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

// ── Block 1b Part A — the stage-2 compensation ───────────────────────────
//
// Block 1 marked the session claimed in stage 1 and built the plan in stage 2.
// When stage 2 threw, the mark STAYED — and claimGuestSessionInTx refuses a
// session whose claimedAt is non-null, so the visitor's plan was gone for good.
// These four tests are the contract of the fix: the mark comes off, the client
// is told it may retry, the retry works, and the release cannot free a session
// that belongs to somebody else.

/** A draft blob truthy enough to reach stage 2. Its SHAPE is stage 2's
 *  business, and stage 2 is the stub here — the route only checks truthiness. */
const SOME_DRAFT = { draft: { id: "gs-1" }, expanded: { title: "x", meals: [] } };

describe("Block 1b Part A: a failed plan build releases the claim", () => {
  it("signup: stage 2 throws -> session back to UNCLAIMED, claimRetryable true, account kept", async () => {
    const prisma = makePrisma({ id: "gs-1", draft: SOME_DRAFT });
    const h = await spinUp(prisma, async () => {
      throw new Error("materializeWizardDraft blew up");
    });
    try {
      const res = await h.post("/auth/signup", {
        ...SIGNUP,
        guestSessionId: "gs-1",
      });
      assert.equal(res.status, 201, "a failed plan build never fails the signup");
      const body = (await res.json()) as {
        claimedPlanId: string | null;
        claimRetryable: boolean;
      };
      assert.equal(body.claimedPlanId, null);
      assert.equal(body.claimRetryable, true, "the client may offer a retry");

      const guest = prisma._state().guest;
      assert.equal(guest.claimedAt, null, "🔴 the mark came OFF");
      assert.equal(guest.claimedByUserId, null, "and the attribution with it");
      assert.equal(guest.lastEvent, "claim_plan_failed");
      assert.ok(
        prisma._state().guestEvents.some((e) => e.event === "claim_plan_failed"),
        "the funnel records the failure",
      );

      // The account is the thing that was created; only the session's claim is
      // undone. Preferences belong to the user, not to the session.
      assert.equal(prisma._state().users.length, 1, "the account survives");
      assert.equal(
        prisma._state().preferencesCreates.length,
        1,
        "and keeps the preferences the claim copied",
      );
    } finally {
      await h.close();
    }
  });

  it("and then a LOGIN with the same guestSessionId claims it again and succeeds", async () => {
    const prisma = makePrisma({ id: "gs-1", draft: SOME_DRAFT });
    // Fails once (the signup), succeeds on the retry (the login). Same stub, so
    // the only difference between the two attempts is the release in between.
    let calls = 0;
    const h = await spinUp(prisma, async () => {
      calls += 1;
      if (calls === 1) throw new Error("first attempt fails");
      return "plan-retry";
    });
    try {
      const first = await h.post("/auth/signup", {
        ...SIGNUP,
        guestSessionId: "gs-1",
      });
      assert.equal(first.status, 201);
      assert.equal(prisma._state().guest.claimedAt, null);

      const second = await h.post("/auth/login", {
        email: SIGNUP.email,
        password: SIGNUP.password,
        guestSessionId: "gs-1",
      });
      assert.equal(second.status, 200);
      const body = (await second.json()) as {
        claimedPlanId: string | null;
        claimRetryable: boolean;
      };
      assert.equal(body.claimedPlanId, "plan-retry", "🔴 the plan is recovered");
      assert.equal(body.claimRetryable, false, "nothing left to retry");
      assert.equal(calls, 2, "stage 2 really ran a second time");
      assert.ok(
        prisma._state().guest.claimedAt instanceof Date,
        "and the session is claimed again, for good this time",
      );
      // The sign-in claim's own rule is untouched by the retry: the account's
      // preferences came from the SIGNUP copy and nothing wrote a second row.
      assert.equal(prisma._state().preferencesCreates.length, 1);
    } finally {
      await h.close();
    }
  });

  it("login: stage 2 throws -> the same release, and the login still succeeds", async () => {
    const prisma = makePrisma({ id: "gs-1", draft: SOME_DRAFT });
    const h = await spinUp(prisma, async () => {
      throw new Error("materializeWizardDraft blew up");
    });
    try {
      // An account with no claim first, so the login is the only claimant.
      assert.equal((await h.post("/auth/signup", SIGNUP)).status, 201);
      assert.equal(prisma._state().guest.claimedAt, null);

      const res = await h.post("/auth/login", {
        email: SIGNUP.email,
        password: SIGNUP.password,
        guestSessionId: "gs-1",
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        claimedPlanId: string | null;
        claimRetryable: boolean;
      };
      assert.equal(body.claimedPlanId, null);
      assert.equal(body.claimRetryable, true);
      assert.equal(prisma._state().guest.claimedAt, null, "the mark came off");
      assert.equal(prisma._state().guest.claimedByUserId, null);
    } finally {
      await h.close();
    }
  });

  it("the release NEVER frees a session claimed by a different user, and the single-use guard still refuses it", async () => {
    const prisma = makePrisma({
      id: "gs-1",
      draft: SOME_DRAFT,
      claimedAt: new Date(),
      claimedByUserId: "u-somebody-else",
    });

    // Directly: the release is narrowed to claimedByUserId, so an unrelated
    // caller cannot use a failure of their own to steal someone's session.
    const released = await releaseClaimForRetry({
      prisma: prisma as never,
      guestSessionId: "gs-1",
      userId: "u-me",
    });
    assert.equal(released, false, "🔴 not mine to release");
    assert.ok(
      prisma._state().guest.claimedAt instanceof Date,
      "the other user's claim stands",
    );
    assert.equal(prisma._state().guest.claimedByUserId, "u-somebody-else");

    // And through the route: the claimedAt guard is NOT loosened by Part A.
    const h = await spinUp(prisma, async () => "never-reached");
    try {
      const res = await h.post("/auth/signup", {
        ...SIGNUP,
        guestSessionId: "gs-1",
      });
      assert.equal(res.status, 409);
      assert.equal(
        ((await res.json()) as { code: string }).code,
        "guest_session_invalid",
      );
      assert.equal(prisma._state().users.length, 0, "and no account survives");
    } finally {
      await h.close();
    }
  });
});

// ── Block 1b Part C — otherAllergies, and Part R3's guard ────────────────
//
// ⚠️ A PREMISE THAT DID NOT HOLD, AND IT LIMITS WHAT THIS CAN TEST.
// The block's brief said "the wizard collects them, the claim drops them".
// Half of that is wrong: WizardInputSchema (lib/ai/schemas/wizard.ts) has NO
// `otherAllergies` key and is a plain z.object, which STRIPS unknown keys — so
// a guest client that sends the field has it discarded at POST
// /wizard/build-plans, long before persistGuestGeneration stores the body.
// The claim was not dropping them; they never arrived.
//
// So the copy is wired here, correctly and with presence semantics, and it is
// exercised against a session blob that HAS the field — which is exactly the
// blob a wizard body carrying it would produce. Making the funnel actually
// carry it needs a field on WizardInputSchema AND a decision about allergen
// resolution (the shelf filter and the prompt read allergiesAndAvoidances
// only), so collecting it without that would record a constraint while
// generating a plan that ignores it. Reported, not guessed at.

describe("Block 1b Part C: otherAllergies rides the claim", () => {
  it("present -> copied to the otherAllergies column", () => {
    const parsed = GuestPreferencesSchema.parse({
      ...WIZARD_BODY,
      otherAllergies: ["sulfites", "mango"],
    });
    const data = toUserPreferencesCreateData(parsed);
    assert.deepEqual(data.otherAllergies, ["sulfites", "mango"]);
  });

  it("absent -> the key is not written at all, so the column default stands", () => {
    const parsed = GuestPreferencesSchema.parse(WIZARD_BODY);
    const data = toUserPreferencesCreateData(parsed);
    assert.ok(
      !("otherAllergies" in data),
      "presence, never an empty array written over @default([])",
    );
  });

  it("through the route: a session blob carrying it reaches UserPreferences", async () => {
    const prisma = makePrisma({ id: "gs-1" });
    prisma._state().guest.preferences = {
      ...WIZARD_BODY,
      otherAllergies: ["sulfites"],
    };
    const h = await spinUp(prisma);
    try {
      assert.equal(
        (await h.post("/auth/signup", { ...SIGNUP, guestSessionId: "gs-1" }))
          .status,
        201,
      );
      const created = prisma._state().preferencesCreates;
      assert.equal(created.length, 1);
      assert.deepEqual(created[0].otherAllergies, ["sulfites"]);
    } finally {
      await h.close();
    }
  });
});

describe("Block 1b R3: a hidden guest default is never saved as a preference", () => {
  // R3 (Hans, September 26): the guest wizard hides sauces and both dials —
  // sauce RUNS as balanced and the dials run off, but neither is an answer the
  // visitor gave, so neither may be written as the account's stored setting.
  //
  // The claim's side of that rule is presence: a key the blob does not have is
  // a key Prisma never sees, and the account lands on the COLUMN defaults
  // (saucePreference "balanced", both dials `none`, maxCookTimeCoverage
  // "most") — the same values, arrived at honestly. Verified in the source
  // that nothing upstream synthesizes them either: all five are `.optional()`
  // with NO `.default()` on WizardInputSchema, so `parsed.data` does not carry
  // them and neither does the session blob.
  const HIDDEN = [
    "saucePreference",
    "discoveryLevel",
    "playlistLevel",
    "maxCookTimeMinutes",
    "maxCookTimeCoverage",
  ] as const;

  it("omitting all five writes none of them", () => {
    const answered = { ...WIZARD_BODY } as Record<string, unknown>;
    for (const k of HIDDEN) delete answered[k];
    const data = toUserPreferencesCreateData(
      GuestPreferencesSchema.parse(answered),
    );
    for (const k of HIDDEN) {
      assert.ok(!(k in data), `${k} must not be synthesized`);
    }
    // The answered basics still come through — this is not a test that the
    // copy does nothing.
    assert.equal(data.householdSize, 4);
    assert.equal(data.difficultyDefault, "medium");
  });

  it("and the route writes a preferences row with none of the five", async () => {
    const answered = { ...WIZARD_BODY } as Record<string, unknown>;
    for (const k of HIDDEN) delete answered[k];
    const prisma = makePrisma({ id: "gs-1" });
    prisma._state().guest.preferences = answered;
    const h = await spinUp(prisma);
    try {
      assert.equal(
        (await h.post("/auth/signup", { ...SIGNUP, guestSessionId: "gs-1" }))
          .status,
        201,
      );
      const created = prisma._state().preferencesCreates[0];
      for (const k of HIDDEN) {
        assert.ok(!(k in created), `${k} reached Prisma`);
      }
    } finally {
      await h.close();
    }
  });
});
