// Resubmission G1 (Part B) — POST /api/guest/plan-from-picks.
//
// The Test Kitchen's "Meals to choose from" commit: a guest's picks become a
// synthetic all-store-slot candidate, expandCandidate({ catalogOnly: true })
// composes it from the catalog, and the blob lands on GuestSession.draft in the
// drafts-GET shape.
//
// 🔴 THE CLAIM UNDER TEST IS "runAICall WAS NOT CALLED", asserted on the DI
// seam's call count — the same posture as lib/__tests__/guestCatalogOnly.test.ts.
// The REAL expandCandidate runs here (no expandCandidate dep is injected), so a
// slot that ever became live would reach the counting stub and fail loudly.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { WizardExpandedPlanDetailsSchema } from "../../lib/ai/schemas/wizard";
import {
  createWizardRouter,
  GUEST_PICKS_WHY_BULLET,
  guestPicksExpandContext,
  picksDailyMacros,
} from "../wizard";
import { expandCandidate as productionExpandCandidate } from "../../lib/wizardExpansion";
import { withSessionUser } from "./fixtures/sessionUserStub";

const HOUR = 60 * 60 * 1000;
const G = "gs-picks-guest";

// ── fixtures ────────────────────────────────────────────────────────────

interface MealFixture {
  id: string;
  title: string;
  isPublic: boolean;
  isArchived: boolean;
  userId: string | null;
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  /** false → composeStoreMealDetails finds no dishLinks ("unusable"). */
  composable: boolean;
}

function meal(id: string, over: Partial<MealFixture> = {}): MealFixture {
  return {
    id,
    title: `Catalog ${id}`,
    isPublic: true,
    isArchived: false,
    userId: null,
    caloriesPerServing: 600,
    proteinGPerServing: 30,
    carbsGPerServing: 60,
    fatGPerServing: 20,
    composable: true,
    ...over,
  };
}

/** The row composeStoreMealDetails selects — one dish, one ingredient. */
function composedRow(m: MealFixture) {
  return {
    id: m.id,
    title: m.title,
    description: `About ${m.id}`,
    cuisineType: "italian",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    servingsDefault: 2,
    dishLinks: m.composable
      ? [
          {
            positionIndex: 0,
            roleLabel: "main",
            dish: {
              title: `Dish for ${m.id}`,
              caloriesPerServing: m.caloriesPerServing,
              proteinGPerServing: m.proteinGPerServing,
              carbsGPerServing: m.carbsGPerServing,
              fatGPerServing: m.fatGPerServing,
              dishIngredients: [
                {
                  quantity: 1,
                  unit: "cup",
                  preparationNote: null,
                  isOptional: false,
                  ingredient: { displayName: "tomato" },
                },
              ],
            },
          },
        ]
      : [],
  };
}

interface SessionRow {
  id: string;
  expiresAt: Date;
  claimedAt: Date | null;
  generationCount: number;
  draft: unknown;
  preferences: unknown;
  lastEvent: string | null;
}

function makePrisma(
  meals: MealFixture[],
  session: Partial<SessionRow> = {},
) {
  const byId = new Map(meals.map((m) => [m.id, m]));
  const row: SessionRow = {
    id: G,
    expiresAt: new Date(Date.now() + HOUR),
    claimedAt: null,
    generationCount: 0,
    draft: null,
    preferences: {},
    lastEvent: "session_created",
    ...session,
  };
  const guestEvents: Record<string, unknown>[] = [];
  return {
    userPreferences: { findUnique: async () => null },
    playlistMeal: { count: async () => 0 },
    meal: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => byId.get(id)).filter((m): m is MealFixture => !!m),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const m = byId.get(where.id);
        return m ? composedRow(m) : null;
      },
    },
    guestSession: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === row.id ? { ...row } : null,
      // Models the conditional claim generically off the where's keys, so the
      // one-plan test is not asserting against a stub shaped to agree with it.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; generationCount?: number };
        data: Record<string, any>;
      }) => {
        if (where.id !== row.id) return { count: 0 };
        if (
          where.generationCount !== undefined &&
          row.generationCount !== where.generationCount
        ) {
          return { count: 0 };
        }
        applyUpdate(row, data);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        if (where.id !== row.id) throw new Error("no such session");
        applyUpdate(row, data);
        return row;
      },
    },
    guestEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        guestEvents.push(data);
        return data;
      },
    },
    _session: () => row,
    _guestEvents: () => guestEvents,
  };
}

function applyUpdate(row: SessionRow, data: Record<string, any>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) {
      (row as any)[k] += v.increment;
    } else {
      (row as any)[k] = v;
    }
  }
}

function countingAI() {
  const calls: string[] = [];
  const fn = async (promptKey: string) => {
    calls.push(promptKey);
    throw new Error(`a picks plan reached the model: ${promptKey}`);
  };
  return { fn, calls };
}

async function spinUp(prisma: unknown, runAICall: unknown, expandCandidate?: unknown) {
  __clearRateLimitStoreForTests();
  const app: Express = express();
  app.use(express.json());
  app.use(
    "/api",
    createWizardRouter({
      prisma: withSessionUser(prisma) as never,
      runAICall: runAICall as never,
      subscriptionService: {
        can: async () => ({ allowed: true }),
      } as never,
      rateLimiterOpts: { capacity: 1000, refillPerSec: 1000 },
      // Unset = the REAL expandCandidate; a wrapper only observes it.
      ...(expandCandidate ? { expandCandidate: expandCandidate as never } : {}),
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  const post = async (path: string, body: unknown, token: string | null) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return {
    post,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const GUEST_TOKEN = () => signToken(G, { purpose: "guest", expiresIn: "24h" });

// G1b — the guest's WHOLE wizard answers, the body build-plans accepts. The
// form hides sauce and both dials (R3), so a real guest body omits them.
const ANSWERS = {
  planDurationDays: 5,
  householdSize: 3,
  cuisines: ["thai", "mexican"],
  eatingStyles: ["vegetarian"],
  allergiesAndAvoidances: ["peanut"],
  difficulty: "easy",
  weeklyPacing: "mostly_easy",
  dietaryNotes: "no cilantro",
  maxCookTimeMinutes: 45,
  maxCookTimeCoverage: "most",
};

const BODY = { preferences: ANSWERS, localDate: "2026-10-07" };

const CATALOG = [meal("m-1"), meal("m-2"), meal("m-3")];

// ── the route ──────────────────────────────────────────────────────────

describe("POST /api/guest/plan-from-picks — the happy path", () => {
  it("composes the picks in order, makes ZERO AI calls, and writes the drafts-GET blob", async () => {
    const prisma = makePrisma(CATALOG);
    const ai = countingAI();
    const h = await spinUp(prisma, ai.fn);
    try {
      const { status, json } = await h.post(
        "/guest/plan-from-picks",
        { ...BODY, mealIds: ["m-3", "m-1", "m-2"] },
        GUEST_TOKEN(),
      );
      // 🔴 THE ASSERTION THAT MATTERS — first, so a slot that became live and
      // reached the model fails HERE, not on whatever status that produced.
      assert.deepEqual(ai.calls, [], "a picks plan makes no AI call");
      assert.equal(status, 200, JSON.stringify(json));

      // The drafts-GET shape — the client's GuestDraftSchema reads exactly this.
      assert.equal(json.draft.id, G, "the draft id is the session id, as on expand");
      assert.ok(!Number.isNaN(Date.parse(json.draft.createdAt)));
      const expanded = WizardExpandedPlanDetailsSchema.parse(json.expanded);
      assert.match(expanded.candidateId, /^picks-[0-9a-f-]{36}$/);
      assert.equal(expanded.title, "Meals for the week of Oct 7");
      assert.deepEqual(expanded.tags, []);
      assert.deepEqual(expanded.whyBullets, [GUEST_PICKS_WHY_BULLET]);
      assert.equal(expanded.householdSize, 3, "the per-run household rides to the claim");
      assert.deepEqual(
        expanded.meals.map((m) => m.sourceStoreMealId),
        ["m-3", "m-1", "m-2"],
        "every slot is the picked catalog meal, in pick order",
      );
      assert.deepEqual(
        expanded.meals.map((m) => m.title),
        ["Catalog m-3", "Catalog m-1", "Catalog m-2"],
      );

      // The session row: the blob, the preferences the claim copies, and the
      // session's one plan spent.
      const row = prisma._session();
      assert.deepEqual(row.draft, json, "the stored blob IS the response");
      assert.equal(row.generationCount, 1);
      assert.equal(row.lastEvent, "plan_opened");
      // G1b — the WHOLE answers, as persistGuestGeneration stores them: the
      // wizard schema's parse (wantsLeftovers' own default included), and NOT
      // a hidden default the guest never answered (R3: no sauce, no dials).
      assert.deepEqual(row.preferences, { ...ANSWERS, wantsLeftovers: false });

      // The funnel.
      const events = prisma._guestEvents();
      assert.deepEqual(
        events.map((e) => e.event),
        ["picks_submitted", "expanded"],
      );
      assert.deepEqual(events[0].meta, { count: 3 });
      assert.deepEqual(events[1].meta, {
        candidateId: expanded.candidateId,
        mealCount: 3,
      });
    } finally {
      await h.close();
    }
  });
});

describe("POST /api/guest/plan-from-picks — one plan per session", () => {
  it("a second picks plan → 409, AND the three-plan path is closed too (the increment is what closes it)", async () => {
    const prisma = makePrisma(CATALOG);
    const h = await spinUp(prisma, countingAI().fn);
    try {
      const first = await h.post(
        "/guest/plan-from-picks",
        { ...BODY, mealIds: ["m-1"] },
        GUEST_TOKEN(),
      );
      assert.equal(first.status, 200);
      assert.equal(prisma._session().generationCount, 1, "the plan spends the generation");

      const again = await h.post(
        "/guest/plan-from-picks",
        { ...BODY, mealIds: ["m-2"] },
        GUEST_TOKEN(),
      );
      assert.equal(again.status, 409);
      assert.equal(again.json.code, "guest_generation_used");

      // build-plans gates on generationCount ALONE — so this is the assertion
      // that the picks plan really used the session's one plan.
      const generate = await h.post("/wizard/build-plans", {}, GUEST_TOKEN());
      assert.equal(generate.status, 409);
      assert.equal(generate.json.code, "guest_generation_used");
    } finally {
      await h.close();
    }
  });

  it("a session that already generated (three-plan path), or already holds a draft → 409 before anything runs", async () => {
    for (const session of [{ generationCount: 1 }, { draft: { draft: {}, expanded: {} } }]) {
      const prisma = makePrisma(CATALOG, session);
      const ai = countingAI();
      const h = await spinUp(prisma, ai.fn);
      try {
        const res = await h.post(
          "/guest/plan-from-picks",
          { ...BODY, mealIds: ["m-1"] },
          GUEST_TOKEN(),
        );
        assert.equal(res.status, 409, JSON.stringify(session));
        assert.equal(res.json.code, "guest_generation_used");
        assert.deepEqual(prisma._guestEvents(), []);
        assert.deepEqual(ai.calls, []);
      } finally {
        await h.close();
      }
    }
  });

  it("a lost race on the conditional write → 409, not a second plan", async () => {
    const prisma = makePrisma(CATALOG);
    // Another request spent the generation between the read and the write.
    const realFind = prisma.guestSession.findUnique;
    let reads = 0;
    prisma.guestSession.findUnique = async (a) => {
      const r = await realFind(a);
      if (++reads === 2) prisma._session().generationCount = 1; // after the route's own read
      return r;
    };
    const h = await spinUp(prisma, countingAI().fn);
    try {
      const res = await h.post(
        "/guest/plan-from-picks",
        { ...BODY, mealIds: ["m-1"] },
        GUEST_TOKEN(),
      );
      assert.equal(res.status, 409);
      assert.equal(res.json.code, "guest_generation_used");
      assert.equal(prisma._session().draft, null, "the loser writes no draft");
    } finally {
      await h.close();
    }
  });
});

describe("POST /api/guest/plan-from-picks — the picks are validated", () => {
  it("a PRIVATE meal id → 403 meal_not_public, even though the shelf never returns one", async () => {
    const prisma = makePrisma([...CATALOG, meal("own-1", { isPublic: false, userId: "u-x" })]);
    const ai = countingAI();
    const h = await spinUp(prisma, ai.fn);
    try {
      const res = await h.post(
        "/guest/plan-from-picks",
        { ...BODY, mealIds: ["m-1", "own-1"] },
        GUEST_TOKEN(),
      );
      assert.equal(res.status, 403);
      assert.equal(res.json.code, "meal_not_public");
      assert.equal(res.json.mealId, "own-1");
      assert.equal(prisma._session().draft, null);
      assert.equal(prisma._session().generationCount, 0, "a refusal spends nothing");
      assert.deepEqual(ai.calls, []);
    } finally {
      await h.close();
    }
  });

  it("a missing or archived meal → 404 meal_not_found", async () => {
    const prisma = makePrisma([...CATALOG, meal("gone", { isArchived: true })]);
    const h = await spinUp(prisma, countingAI().fn);
    try {
      for (const id of ["nope", "gone"]) {
        const res = await h.post(
          "/guest/plan-from-picks",
          { ...BODY, mealIds: [id] },
          GUEST_TOKEN(),
        );
        assert.equal(res.status, 404, id);
        assert.equal(res.json.code, "meal_not_found");
        assert.equal(res.json.mealId, id);
      }
    } finally {
      await h.close();
    }
  });

  it("a pick the catalog cannot compose → 409 catalog_only_gap, zero AI calls, nothing spent", async () => {
    const prisma = makePrisma([...CATALOG, meal("bare", { composable: false })]);
    const ai = countingAI();
    const h = await spinUp(prisma, ai.fn);
    try {
      const res = await h.post(
        "/guest/plan-from-picks",
        { ...BODY, mealIds: ["m-1", "bare"] },
        GUEST_TOKEN(),
      );
      assert.equal(res.status, 409);
      assert.equal(res.json.code, "catalog_only_gap");
      assert.deepEqual(res.json.liveSlotTitles, ["Catalog bare"]);
      assert.equal(res.json.storeSlotCount, 1);
      assert.deepEqual(ai.calls, [], "the gap is found before any AI call");
      assert.equal(prisma._session().draft, null);
      assert.equal(prisma._session().generationCount, 0);
      assert.deepEqual(
        prisma._guestEvents().map((e) => e.event),
        ["picks_submitted", "catalog_only_gap"],
      );
    } finally {
      await h.close();
    }
  });

  it("the body: no preferences, duplicates, more than 7, none, a bad answer, one the claim could not read → 400", async () => {
    const prisma = makePrisma(CATALOG);
    const h = await spinUp(prisma, countingAI().fn);
    try {
      for (const body of [
        // G1b — the answers are required: the bare context fields are gone.
        { mealIds: ["m-1"], localDate: "2026-10-07" },
        { ...ANSWERS, mealIds: ["m-1"] },
        { ...BODY, mealIds: ["m-1", "m-1"] },
        { ...BODY, mealIds: ["a", "b", "c", "d", "e", "f", "g", "h"] },
        { ...BODY, mealIds: [] },
        { ...BODY, mealIds: ["m-1"], preferences: { ...ANSWERS, saucePreference: "from_a_jar" } },
        { ...BODY, mealIds: ["m-1"], preferences: { ...ANSWERS, difficulty: undefined } },
        { ...BODY, mealIds: ["m-1"], preferences: { ...ANSWERS, weeklyPacing: "whenever" } },
        // Passes the wizard schema, fails the claim's (cuisines max 60).
        {
          ...BODY,
          mealIds: ["m-1"],
          preferences: { ...ANSWERS, cuisines: Array.from({ length: 61 }, (_, i) => `c${i}`) },
        },
      ]) {
        const res = await h.post("/guest/plan-from-picks", body, GUEST_TOKEN());
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.equal(prisma._session().generationCount, 0);
    } finally {
      await h.close();
    }
  });
});

describe("POST /api/guest/plan-from-picks — guest only", () => {
  it("a signed-in user → 403 guest_only; no token → 401; an expired or claimed guest → 401", async () => {
    const h = await spinUp(makePrisma(CATALOG), countingAI().fn);
    try {
      const member = await h.post(
        "/guest/plan-from-picks",
        { ...BODY, mealIds: ["m-1"] },
        signToken("u-member"),
      );
      assert.equal(member.status, 403);
      assert.equal(member.json.code, "guest_only");
      const anon = await h.post("/guest/plan-from-picks", { ...BODY, mealIds: ["m-1"] }, null);
      assert.equal(anon.status, 401);
    } finally {
      await h.close();
    }
    for (const session of [{ expiresAt: new Date(Date.now() - 1) }, { claimedAt: new Date() }]) {
      const h2 = await spinUp(makePrisma(CATALOG, session), countingAI().fn);
      try {
        const res = await h2.post(
          "/guest/plan-from-picks",
          { ...BODY, mealIds: ["m-1"] },
          GUEST_TOKEN(),
        );
        assert.equal(res.status, 401, JSON.stringify(session));
      } finally {
        await h2.close();
      }
    }
  });
});

// ── G1b — the expand context, derived from the answers ─────────────────

describe("guestPicksExpandContext — one source for the plan and the claim", () => {
  it("maps the answers to the expand context (literal)", () => {
    assert.deepEqual(
      guestPicksExpandContext({
        ...ANSWERS,
        wantsLeftovers: true, // sent anyway — stamped false (D-WS7-190)
        additionalNotes: "surprise me",
        saucePreference: "homemade",
        discoveryLevel: "some",
        playlistLevel: "all",
      } as never),
      {
        planDurationDays: 5,
        householdSize: 3,
        wantsLeftovers: false,
        eatingStyles: ["vegetarian"],
        difficulty: "easy",
        allergiesAndAvoidances: ["peanut"],
        saucePreference: "homemade",
        maxCookTimeMinutes: 45,
        maxCookTimeCoverage: "most",
      },
    );
  });

  it("an UNANSWERED optional stays absent — the shared resolver, not this function, supplies balanced / no cap / most / []", () => {
    assert.deepEqual(
      guestPicksExpandContext({
        planDurationDays: 3,
        householdSize: 2,
        wantsLeftovers: false,
        cuisines: [],
        eatingStyles: [],
        difficulty: "medium",
        weeklyPacing: "mixed",
      }),
      {
        planDurationDays: 3,
        householdSize: 2,
        wantsLeftovers: false,
        eatingStyles: [],
        difficulty: "medium",
      },
    );
    // A chosen "no cap" (null) and a chosen "no allergies" ([]) are answers,
    // and survive as answers.
    const chosen = guestPicksExpandContext({
      planDurationDays: 3,
      householdSize: 2,
      wantsLeftovers: false,
      cuisines: [],
      eatingStyles: [],
      difficulty: "medium",
      weeklyPacing: "mixed",
      allergiesAndAvoidances: [],
      maxCookTimeMinutes: null,
    });
    assert.deepEqual(chosen.allergiesAndAvoidances, []);
    assert.equal(chosen.maxCookTimeMinutes, null);
  });

  it("through the route: the answered allergies are what expandCandidate receives", async () => {
    const prisma = makePrisma(CATALOG);
    const seen: { context?: Record<string, unknown> } = {};
    const h = await spinUp(prisma, countingAI().fn, (async (opts: any) => {
      seen.context = opts.request.candidateContext;
      return productionExpandCandidate(opts);
    }) as never);
    try {
      const res = await h.post(
        "/guest/plan-from-picks",
        { ...BODY, mealIds: ["m-1"] },
        GUEST_TOKEN(),
      );
      assert.equal(res.status, 200);
      assert.deepEqual(seen.context?.allergiesAndAvoidances, ["peanut"]);
      assert.equal(seen.context?.wantsLeftovers, false);
      assert.ok(!("saucePreference" in (seen.context ?? {})), "a hidden sauce is not invented");
    } finally {
      await h.close();
    }
  });
});

// ── the macros arithmetic ──────────────────────────────────────────────

describe("picksDailyMacros — the member read path's rule", () => {
  const m = (calories: number, proteinG = 0) => ({
    caloriesPerServing: calories,
    proteinGPerServing: proteinG,
    carbsGPerServing: 0,
    fatGPerServing: 0,
  });

  it("fewer picks than days: the assigned meals ÷ the assigned days (not the plan length)", () => {
    assert.deepEqual(picksDailyMacros([m(500, 20), m(700, 31)], 7), {
      calories: 600,
      proteinG: 25.5,
      carbsG: 0,
      fatG: 0,
    });
  });

  it("more picks than days: only the first planDurationDays are assigned, so only they count", () => {
    assert.equal(picksDailyMacros([m(300), m(600), m(900), m(10_000)], 3).calories, 600);
  });

  it("a meal with no macros contributes zeros, and no picks is all zeros", () => {
    assert.equal(picksDailyMacros([m(0), m(800)], 7).calories, 400);
    assert.deepEqual(picksDailyMacros([], 7), { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 });
  });
});
