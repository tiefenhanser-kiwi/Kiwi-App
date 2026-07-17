// Plan-Gen Arc · Block 2 · D-WS9-037 / D-WS9-038 — store compose unit tests.
// Covers the tunable threshold config, the shortlist retrieval + ranking, and
// the post-AI storeSlots reconciliation guard.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  resolveStoreComposeConfig,
  STORE_COMPOSE_DEFAULTS,
} from "../store/storeComposeConfig";
import {
  buildStoreShortlist,
  reconcileStoreSlots,
} from "../store/storeShortlist";
import type { WizardPlanCandidate } from "../ai/schemas/wizard";

// ── config (D-WS9-037) ────────────────────────────────────────────────────

describe("resolveStoreComposeConfig", () => {
  afterEach(() => {
    delete process.env.KIWI_STORE_SHORTLIST_SIZE;
    delete process.env.KIWI_STORE_MIN_MATCH_SCORE;
  });

  it("returns the aggressive defaults with no env set", () => {
    const cfg = resolveStoreComposeConfig();
    assert.equal(cfg.shortlistSize, STORE_COMPOSE_DEFAULTS.shortlistSize);
    assert.equal(cfg.minMatchScore, STORE_COMPOSE_DEFAULTS.minMatchScore);
  });

  it("applies env overrides", () => {
    process.env.KIWI_STORE_SHORTLIST_SIZE = "12";
    process.env.KIWI_STORE_MIN_MATCH_SCORE = "0.5";
    const cfg = resolveStoreComposeConfig();
    assert.equal(cfg.shortlistSize, 12);
    assert.equal(cfg.minMatchScore, 0.5);
  });

  it("clamps minMatchScore to [0,1] and shortlistSize to a non-negative int", () => {
    process.env.KIWI_STORE_SHORTLIST_SIZE = "-5";
    process.env.KIWI_STORE_MIN_MATCH_SCORE = "9";
    const cfg = resolveStoreComposeConfig();
    assert.equal(cfg.shortlistSize, 0);
    assert.equal(cfg.minMatchScore, 1);
  });

  it("ignores non-numeric env values (falls back to default)", () => {
    process.env.KIWI_STORE_SHORTLIST_SIZE = "not-a-number";
    const cfg = resolveStoreComposeConfig();
    assert.equal(cfg.shortlistSize, STORE_COMPOSE_DEFAULTS.shortlistSize);
  });
});

// ── shortlist retrieval (D-WS9-038) ───────────────────────────────────────

function mealRow(over: Record<string, unknown>) {
  return {
    id: "m",
    title: "A meal",
    cuisineType: "italian",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    tags: [] as string[],
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
    useCount: 0,
    likeCount: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function stubPrisma(rows: Array<Record<string, unknown>>): {
  prisma: PrismaClient;
  whereArgs: unknown[];
} {
  const whereArgs: unknown[] = [];
  const prisma = {
    meal: {
      findMany: async (args: { where?: unknown }) => {
        whereArgs.push(args.where);
        return rows;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, whereArgs };
}

describe("buildStoreShortlist", () => {
  it("returns an empty shelf and skips the query when shortlistSize is 0", async () => {
    const { prisma, whereArgs } = stubPrisma([mealRow({ id: "a" })]);
    const out = await buildStoreShortlist(prisma, {
      cuisines: [],
      difficulty: "medium",
      config: { shortlistSize: 0, minMatchScore: 0 },
    });
    assert.deepEqual(out.forPrompt, []);
    assert.equal(out.aliasToId.size, 0);
    assert.equal(whereArgs.length, 0, "no query should run for size 0");
  });

  it("returns an empty shelf when the pool is empty (graceful degrade)", async () => {
    const { prisma } = stubPrisma([]);
    const out = await buildStoreShortlist(prisma, {
      cuisines: ["Italian"],
      difficulty: "medium",
      config: { shortlistSize: 10, minMatchScore: 0 },
    });
    assert.deepEqual(out.forPrompt, []);
    assert.equal(out.aliasToId.size, 0);
  });

  it("filters the pool on isPublic + dinner + not-archived and excludes recent ids", async () => {
    const { prisma, whereArgs } = stubPrisma([mealRow({ id: "a" })]);
    await buildStoreShortlist(prisma, {
      cuisines: [],
      difficulty: "medium",
      excludeMealIds: ["recent-1"],
      config: { shortlistSize: 10, minMatchScore: 0 },
    });
    const where = whereArgs[0] as Record<string, unknown>;
    assert.equal(where.isPublic, true);
    assert.equal(where.isArchived, false);
    assert.equal(where.mealType, "dinner");
    assert.deepEqual(where.id, { notIn: ["recent-1"] });
  });

  it("ranks a cuisine match above a non-match and caps at shortlistSize", async () => {
    const { prisma } = stubPrisma([
      mealRow({ id: "match", cuisineType: "italian" }),
      mealRow({ id: "nomatch", cuisineType: "korean" }),
    ]);
    const out = await buildStoreShortlist(prisma, {
      cuisines: ["Italian"],
      difficulty: "medium",
      config: { shortlistSize: 1, minMatchScore: 0 },
    });
    assert.equal(out.forPrompt.length, 1);
    // forPrompt.id is a per-shortlist alias (m1); it maps to the real id "match".
    assert.equal(out.forPrompt[0].id, "m1");
    assert.equal(out.aliasToId.get("m1"), "match");
  });

  it("minMatchScore floor trims low-scoring meals off the shelf", async () => {
    // A non-cuisine-match, over-ceiling meal scores 0.4 (base only). A floor of
    // 0.7 trims it; the cuisine+within-ceiling meal (0.4+0.35+0.15=0.9) stays.
    const { prisma } = stubPrisma([
      mealRow({ id: "weak", cuisineType: "korean", difficulty: "fancy" }),
      mealRow({ id: "strong", cuisineType: "italian", difficulty: "easy" }),
    ]);
    const out = await buildStoreShortlist(prisma, {
      cuisines: ["Italian"],
      difficulty: "medium",
      config: { shortlistSize: 10, minMatchScore: 0.7 },
    });
    assert.deepEqual(
      out.forPrompt.map((m) => out.aliasToId.get(m.id)),
      ["strong"],
    );
  });

  it("projects the lean per-meal shape the AI reasons over", async () => {
    const { prisma } = stubPrisma([
      mealRow({ id: "a", title: "Ragu", tags: ["cozy"] }),
    ]);
    const out = await buildStoreShortlist(prisma, {
      cuisines: [],
      difficulty: "fancy",
      config: { shortlistSize: 5, minMatchScore: 0 },
    });
    assert.deepEqual(out.forPrompt[0], {
      id: "m1",
      title: "Ragu",
      cuisineType: "italian",
      difficulty: "easy",
      estimatedTimeMinutes: 30,
      tags: ["cozy"],
      macros: {
        caloriesPerServing: 500,
        proteinGPerServing: 30,
        carbsGPerServing: 40,
        fatGPerServing: 20,
      },
    });
  });
});

// ── reconcile guard (D-WS9-038) ───────────────────────────────────────────

function candidate(
  over: Partial<WizardPlanCandidate> = {},
): WizardPlanCandidate {
  return {
    id: "c1",
    title: "Plan",
    tags: [],
    whyBullets: ["b"],
    mealTitles: ["s0", "s1", "s2"],
    dailyMacros: { calories: 1, proteinG: 1, carbsG: 1, fatG: 1 },
    ...over,
  };
}

describe("reconcileStoreSlots", () => {
  // alias → real Meal.id. The AI cites the alias; reconcile keeps in-range
  // known-alias marks AND rewrites storeMealId to the real id.
  const aliasToId = new Map([
    ["a1", "store-1"],
    ["a2", "store-2"],
  ]);

  it("keeps a known-alias in-range mark and translates it to the real id", () => {
    const out = reconcileStoreSlots(
      [candidate({ storeSlots: [{ slotIndex: 1, storeMealId: "a2" }] })],
      aliasToId,
    );
    assert.deepEqual(out[0].storeSlots, [
      { slotIndex: 1, storeMealId: "store-2" },
    ]);
  });

  it("drops a mark whose alias was never offered", () => {
    const out = reconcileStoreSlots(
      [candidate({ storeSlots: [{ slotIndex: 0, storeMealId: "ghost" }] })],
      aliasToId,
    );
    assert.equal(out[0].storeSlots, undefined);
  });

  it("drops an out-of-range slotIndex", () => {
    const out = reconcileStoreSlots(
      [candidate({ storeSlots: [{ slotIndex: 9, storeMealId: "a1" }] })],
      aliasToId,
    );
    assert.equal(out[0].storeSlots, undefined);
  });

  it("dedups a repeated slotIndex (first wins), translated to real id", () => {
    const out = reconcileStoreSlots(
      [
        candidate({
          storeSlots: [
            { slotIndex: 0, storeMealId: "a1" },
            { slotIndex: 0, storeMealId: "a2" },
          ],
        }),
      ],
      aliasToId,
    );
    assert.deepEqual(out[0].storeSlots, [
      { slotIndex: 0, storeMealId: "store-1" },
    ]);
  });

  it("removes an empty/absent storeSlots entirely", () => {
    const out = reconcileStoreSlots(
      [candidate({ storeSlots: [] }), candidate({})],
      aliasToId,
    );
    assert.equal(out[0].storeSlots, undefined);
    assert.equal(out[1].storeSlots, undefined);
  });

  it("keeps the valid subset when only some marks are bad", () => {
    const out = reconcileStoreSlots(
      [
        candidate({
          storeSlots: [
            { slotIndex: 0, storeMealId: "a1" },
            { slotIndex: 2, storeMealId: "ghost" },
          ],
        }),
      ],
      aliasToId,
    );
    assert.deepEqual(out[0].storeSlots, [
      { slotIndex: 0, storeMealId: "store-1" },
    ]);
  });

  it("scales: a 2000-alias shortlist round-trips aliases to real ids", () => {
    // Collision-free at thousands of meals — aliases are m1..mN, N === shelf size.
    const big = new Map<string, string>();
    for (let i = 1; i <= 2000; i++) big.set(`m${i}`, `real-${i}`);
    const out = reconcileStoreSlots(
      [
        candidate({
          mealTitles: ["s0", "s1", "s2"],
          storeSlots: [
            { slotIndex: 0, storeMealId: "m1" },
            { slotIndex: 2, storeMealId: "m2000" },
          ],
        }),
      ],
      big,
    );
    assert.deepEqual(out[0].storeSlots, [
      { slotIndex: 0, storeMealId: "real-1" },
      { slotIndex: 2, storeMealId: "real-2000" },
    ]);
  });
});
