// WS7-2 Block A — /me/preferences endpoint tests.
// 7 tests: GET (existing-row, default-row creation), PATCH (full, partial,
// invalid enum 400, unauthorized 401, creates row if missing).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createMeRouter } from "../me";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

interface PrefsRow {
  id: string;
  userId: string;
  householdSize: number;
  wantsLeftovers: boolean;
  cuisines: string[];
  eatingStyles: string[];
  allergiesAndAvoidances: string[];
  cookingSkill: string | null;
  stovetopType: string | null;
  kidsCount: number;
  pickyEaterCount: number;
  pickyAvoidances: string[];
  spiceTolerance: string;
  healthGoals: string[];
  budgetLevel: string;
  cookingEquipment: string[];
  recurringGroceryItems: string[];
  planLengthDefault: number;
  defaultRetailer: string | null;
  dietaryNotes: string | null;
  // Cookbook Phase B Block 1 — new stored prefs.
  discoveryMealsPerWeek: number;
  saucePreference: string;
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: string;
  updatedAt: Date;
}

function defaultsFor(userId: string): PrefsRow {
  return {
    id: `prefs-${userId}`,
    userId,
    householdSize: 2,
    wantsLeftovers: true,
    cuisines: [],
    eatingStyles: [],
    allergiesAndAvoidances: [],
    cookingSkill: null,
    stovetopType: null,
    kidsCount: 0,
    pickyEaterCount: 0,
    pickyAvoidances: [],
    spiceTolerance: "medium",
    healthGoals: [],
    budgetLevel: "mid_range",
    cookingEquipment: [],
    recurringGroceryItems: [],
    planLengthDefault: 7,
    defaultRetailer: null,
    dietaryNotes: null,
    // Cookbook Phase B Block 1 — models a row after the additive migration:
    // Postgres backfills these column defaults, so a pre-existing row reads
    // back with them already applied (the server serializer just spreads).
    discoveryMealsPerWeek: 0,
    saucePreference: "balanced",
    maxCookTimeMinutes: null,
    maxCookTimeCoverage: "most",
    updatedAt: new Date("2026-05-19T12:00:00Z"),
  };
}

function makeStubPrisma(initial: PrefsRow | null = null) {
  let row: PrefsRow | null = initial;
  return {
    userPreferences: {
      findUnique: async ({
        where,
      }: {
        where: { userId: string };
      }): Promise<PrefsRow | null> => {
        return row && row.userId === where.userId ? row : null;
      },
      create: async ({
        data,
      }: {
        data: { userId: string } & Partial<PrefsRow>;
      }): Promise<PrefsRow> => {
        const next = { ...defaultsFor(data.userId), ...data } as PrefsRow;
        next.updatedAt = new Date();
        row = next;
        return next;
      },
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { userId: string };
        update: Partial<PrefsRow>;
        create: { userId: string } & Partial<PrefsRow>;
      }): Promise<PrefsRow> => {
        if (row && row.userId === where.userId) {
          row = { ...row, ...update, updatedAt: new Date() };
        } else {
          row = { ...defaultsFor(create.userId), ...create, updatedAt: new Date() } as PrefsRow;
        }
        return row;
      },
    },
    _row: () => row,
  };
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma: prisma as never }));
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

const USER_ID = "test-user-preferences";

describe("GET /me/preferences", () => {
  it("returns the existing preferences row", async () => {
    const seed = defaultsFor(USER_ID);
    seed.cuisines = ["italian", "thai"];
    seed.spiceTolerance = "hot";
    const prisma = makeStubPrisma(seed);
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/preferences`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { preferences: PrefsRow };
      assert.deepEqual(body.preferences.cuisines, ["italian", "thai"]);
      assert.equal(body.preferences.spiceTolerance, "hot");
    } finally {
      await harness.close();
    }
  });

  it("creates a default preferences row on first fetch", async () => {
    const prisma = makeStubPrisma(null);
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/preferences`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { preferences: PrefsRow };
      assert.equal(body.preferences.userId, USER_ID);
      assert.equal(body.preferences.spiceTolerance, "medium");
      assert.equal(body.preferences.planLengthDefault, 7);
      // Cookbook Phase B Block 1 — new fields surface with their DB defaults.
      assert.equal(body.preferences.discoveryMealsPerWeek, 0);
      assert.equal(body.preferences.saucePreference, "balanced");
      assert.equal(body.preferences.maxCookTimeMinutes, null);
      assert.equal(body.preferences.maxCookTimeCoverage, "most");
      assert.ok(prisma._row(), "row should be persisted");
    } finally {
      await harness.close();
    }
  });
});

describe("PATCH /me/preferences", () => {
  it("happy: applies a full update and returns the merged row", async () => {
    const prisma = makeStubPrisma(defaultsFor(USER_ID));
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const body = {
        householdSize: 4,
        cuisines: ["italian", "mexican"],
        eatingStyles: ["mediterranean"],
        allergiesAndAvoidances: ["peanuts"],
        cookingSkill: "intermediate",
        spiceTolerance: "very_hot",
        budgetLevel: "premium",
        cookingEquipment: ["instant_pot", "wok"],
        stovetopType: "induction",
        kidsCount: 2,
        pickyEaterCount: 1,
        pickyAvoidances: ["mushrooms"],
        healthGoals: ["high_protein"],
        recurringGroceryItems: ["eggs", "milk"],
        planLengthDefault: 5,
        defaultRetailer: "instacart",
        dietaryNotes: "lower sodium please",
      };
      const res = await fetch(`${harness.baseUrl}/me/preferences`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200);
      const out = (await res.json()) as { preferences: PrefsRow };
      assert.equal(out.preferences.spiceTolerance, "very_hot");
      assert.equal(out.preferences.budgetLevel, "premium");
      assert.equal(out.preferences.householdSize, 4);
      assert.deepEqual(out.preferences.cuisines, ["italian", "mexican"]);
      assert.equal(out.preferences.cookingSkill, "intermediate");
    } finally {
      await harness.close();
    }
  });

  it("happy: applies a partial update, leaves other fields untouched", async () => {
    const seed = defaultsFor(USER_ID);
    seed.cuisines = ["thai"];
    seed.spiceTolerance = "mild";
    const prisma = makeStubPrisma(seed);
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/preferences`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ spiceTolerance: "hot" }),
      });
      assert.equal(res.status, 200);
      const out = (await res.json()) as { preferences: PrefsRow };
      assert.equal(out.preferences.spiceTolerance, "hot");
      assert.deepEqual(out.preferences.cuisines, ["thai"]);
    } finally {
      await harness.close();
    }
  });

  // ── Cookbook Phase B Block 1 — new preference fields round-trip ──────────
  it("Phase B: sets and reads back all four new preference fields", async () => {
    const prisma = makeStubPrisma(defaultsFor(USER_ID));
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/preferences`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          discoveryMealsPerWeek: 2,
          saucePreference: "homemade",
          maxCookTimeMinutes: 45,
          maxCookTimeCoverage: "all",
        }),
      });
      assert.equal(res.status, 200);
      const out = (await res.json()) as { preferences: PrefsRow };
      assert.equal(out.preferences.discoveryMealsPerWeek, 2);
      assert.equal(out.preferences.saucePreference, "homemade");
      assert.equal(out.preferences.maxCookTimeMinutes, 45);
      assert.equal(out.preferences.maxCookTimeCoverage, "all");
    } finally {
      await harness.close();
    }
  });

  it("Phase B: accepts an explicit null for maxCookTimeMinutes (uncapped)", async () => {
    const seed = defaultsFor(USER_ID);
    seed.maxCookTimeMinutes = 30;
    const prisma = makeStubPrisma(seed);
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/preferences`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ maxCookTimeMinutes: null }),
      });
      assert.equal(res.status, 200);
      const out = (await res.json()) as { preferences: PrefsRow };
      assert.equal(out.preferences.maxCookTimeMinutes, null);
    } finally {
      await harness.close();
    }
  });

  it("Phase B: rejects out-of-range discoveryMealsPerWeek and bad saucePreference", async () => {
    const harness = await spinUp(makeStubPrisma(defaultsFor(USER_ID)));
    try {
      const token = signToken(USER_ID);
      const bad = async (payload: Record<string, unknown>) => {
        const res = await fetch(`${harness.baseUrl}/me/preferences`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });
        return res.status;
      };
      assert.equal(await bad({ discoveryMealsPerWeek: 3 }), 400);
      assert.equal(await bad({ saucePreference: "instant" }), 400);
      assert.equal(await bad({ maxCookTimeCoverage: "half" }), 400);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 on invalid enum value", async () => {
    const prisma = makeStubPrisma(defaultsFor(USER_ID));
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/preferences`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ spiceTolerance: "extra_spicy" }),
      });
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when no auth header is present", async () => {
    const prisma = makeStubPrisma(defaultsFor(USER_ID));
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/preferences`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ householdSize: 3 }),
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });

  it("creates the preferences row if it does not exist (upsert path)", async () => {
    const prisma = makeStubPrisma(null);
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/preferences`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ cuisines: ["japanese"] }),
      });
      assert.equal(res.status, 200);
      const out = (await res.json()) as { preferences: PrefsRow };
      assert.deepEqual(out.preferences.cuisines, ["japanese"]);
      assert.equal(out.preferences.userId, USER_ID);
      assert.ok(prisma._row());
    } finally {
      await harness.close();
    }
  });
});
