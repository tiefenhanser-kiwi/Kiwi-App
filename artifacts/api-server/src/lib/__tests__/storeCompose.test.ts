// Plan-Gen Arc · Block 2 / Block 4b-1 (D-WS9-037 / D-WS9-075) — store compose unit
// tests. Covers the tunable config, the shortlist retrieval + selection pipeline
// (hard filters, diversity cap, cuisine quota, seeded rank-weighted sampling), and
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
import { allergenWhereConditions } from "../store/allergenFilter";
import type { WizardPlanCandidate } from "../ai/schemas/wizard";

// ── config (D-WS9-037 / D-WS9-075) ────────────────────────────────────────

describe("resolveStoreComposeConfig", () => {
  afterEach(() => {
    delete process.env.KIWI_STORE_SHORTLIST_SIZE;
    delete process.env.KIWI_STORE_CUISINE_QUOTA_FRACTION;
  });

  it("returns the defaults with no env set", () => {
    const cfg = resolveStoreComposeConfig();
    assert.equal(cfg.shortlistSize, STORE_COMPOSE_DEFAULTS.shortlistSize);
    assert.equal(
      cfg.cuisineQuotaFraction,
      STORE_COMPOSE_DEFAULTS.cuisineQuotaFraction,
    );
  });

  it("applies env overrides", () => {
    process.env.KIWI_STORE_SHORTLIST_SIZE = "12";
    process.env.KIWI_STORE_CUISINE_QUOTA_FRACTION = "0.5";
    const cfg = resolveStoreComposeConfig();
    assert.equal(cfg.shortlistSize, 12);
    assert.equal(cfg.cuisineQuotaFraction, 0.5);
  });

  it("clamps cuisineQuotaFraction to [0,1] and shortlistSize to a non-negative int", () => {
    process.env.KIWI_STORE_SHORTLIST_SIZE = "-5";
    process.env.KIWI_STORE_CUISINE_QUOTA_FRACTION = "9";
    const cfg = resolveStoreComposeConfig();
    assert.equal(cfg.shortlistSize, 0);
    assert.equal(cfg.cuisineQuotaFraction, 1);
  });

  it("ignores non-numeric env values (falls back to default)", () => {
    process.env.KIWI_STORE_SHORTLIST_SIZE = "not-a-number";
    const cfg = resolveStoreComposeConfig();
    assert.equal(cfg.shortlistSize, STORE_COMPOSE_DEFAULTS.shortlistSize);
  });
});

// ── shortlist selection (D-WS9-075) ───────────────────────────────────────

let ROW_SEQ = 0;
function mealRow(over: Record<string, unknown> = {}) {
  ROW_SEQ += 1;
  return {
    id: `id-${ROW_SEQ}`,
    title: "A meal",
    cuisineType: "American",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    tags: [] as string[],
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
    dishFamilyKey: null as string | null,
    allergens: [] as string[],
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

const BASE = {
  cuisines: [] as string[],
  allergiesAndAvoidances: [] as string[],
  difficulty: "fancy", // most permissive ceiling — no difficulty exclusion
  userId: "user-a",
  rotationSalt: 0,
  config: { shortlistSize: 40, cuisineQuotaFraction: 0.7 },
};

describe("buildStoreShortlist", () => {
  it("returns an empty shelf and skips the query when shortlistSize is 0", async () => {
    const { prisma, whereArgs } = stubPrisma([mealRow()]);
    const out = await buildStoreShortlist(prisma, {
      ...BASE,
      config: { shortlistSize: 0, cuisineQuotaFraction: 0.7 },
    });
    assert.deepEqual(out.forPrompt, []);
    assert.equal(out.aliasToId.size, 0);
    assert.equal(whereArgs.length, 0, "no query should run for size 0");
  });

  it("returns an empty shelf when the pool is empty (graceful degrade)", async () => {
    const { prisma } = stubPrisma([]);
    const out = await buildStoreShortlist(prisma, BASE);
    assert.deepEqual(out.forPrompt, []);
    assert.equal(out.aliasToId.size, 0);
  });

  it("filters on isPublic + dinner + not-archived and excludes recent ids", async () => {
    const { prisma, whereArgs } = stubPrisma([mealRow()]);
    await buildStoreShortlist(prisma, {
      ...BASE,
      excludeMealIds: ["recent-1"],
    });
    const where = whereArgs[0] as Record<string, unknown>;
    assert.equal(where.isPublic, true);
    assert.equal(where.isArchived, false);
    assert.equal(where.mealType, "dinner");
    assert.deepEqual(where.id, { notIn: ["recent-1"] });
    // fancy user → ceiling admits all three tiers
    assert.deepEqual(where.difficulty, { in: ["easy", "medium", "fancy"] });
  });

  it("applies the tiered difficulty ceiling (beginner → easy+medium, never fancy)", async () => {
    const { prisma, whereArgs } = stubPrisma([mealRow()]);
    await buildStoreShortlist(prisma, { ...BASE, difficulty: "easy" });
    const where = whereArgs[0] as Record<string, unknown>;
    assert.deepEqual(
      where.difficulty,
      { in: ["easy", "medium"] },
      "a beginner is served easy+medium but never fancy",
    );

    const { prisma: p2, whereArgs: w2 } = stubPrisma([mealRow()]);
    await buildStoreShortlist(p2, { ...BASE, difficulty: "medium" });
    assert.deepEqual((w2[0] as Record<string, unknown>).difficulty, {
      in: ["easy", "medium", "fancy"],
    });
  });

  it("weights the shelf toward the user's actual skill level within the band", async () => {
    // Beginner, 10 easy + 10 medium distinct-parent meals, small shelf. The
    // easy-leaning weight should surface more easy than medium meals.
    const rows = [
      ...Array.from({ length: 10 }, (_, i) =>
        mealRow({ id: `easy-${i}`, difficulty: "easy", dishFamilyKey: null }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        mealRow({ id: `med-${i}`, difficulty: "medium", dishFamilyKey: null }),
      ),
    ];
    const { prisma } = stubPrisma(rows);
    const out = await buildStoreShortlist(prisma, {
      ...BASE,
      difficulty: "easy",
      config: { shortlistSize: 8, cuisineQuotaFraction: 0.7 },
    });
    const ids = [...out.aliasToId.values()];
    const easy = ids.filter((i) => i.startsWith("easy-")).length;
    assert.ok(easy >= 5, `expected easy-leaning shelf, got ${easy}/8 easy`);
  });

  it("adds the conservative allergen filter to the WHERE only when the user has an allergy", async () => {
    const { prisma, whereArgs } = stubPrisma([mealRow()]);
    await buildStoreShortlist(prisma, {
      ...BASE,
      allergiesAndAvoidances: ["Dairy-free"],
    });
    const where = whereArgs[0] as Record<string, unknown>;
    // ⚠️ Compared against the LIVE output of allergenWhereConditions, not a
    // copy of it. This test's job is that buildStoreShortlist actually applies
    // the filter; WHAT the filter says is allergenFilter's own contract, and it
    // is pinned behaviourally in storeShortlistHelpers.test.ts. Restating the
    // clause here (as this did before D-WS9-214) made the same rule editable in
    // two places and turned a real semantic change into a spelling mismatch.
    assert.deepEqual(where.AND, allergenWhereConditions(["dairy"]));

    const { prisma: p2, whereArgs: w2 } = stubPrisma([mealRow()]);
    await buildStoreShortlist(p2, BASE);
    assert.equal(
      (w2[0] as Record<string, unknown>).AND,
      undefined,
      "no allergen AND when the user has no allergy",
    );
  });

  it("caps to one version per parent dish (diversity)", async () => {
    // Two versions of "Baked Chicken Breast" (same parent), one taco, one burger.
    const { prisma } = stubPrisma([
      mealRow({ id: "chick-a", dishFamilyKey: "lemon-herb-baked-chicken-breast" }),
      mealRow({ id: "chick-b", dishFamilyKey: "honey-garlic-glazed-baked-chicken-breast" }),
      mealRow({ id: "taco", dishFamilyKey: "classic-tex-mex-ground-beef-tacos" }),
      mealRow({ id: "burger", dishFamilyKey: "smash-burger-with-american-cheese-and-special-sauce" }),
    ]);
    const out = await buildStoreShortlist(prisma, {
      ...BASE,
      config: { shortlistSize: 10, cuisineQuotaFraction: 0.7 },
    });
    const ids = [...out.aliasToId.values()];
    assert.equal(ids.length, 3, "three distinct parents → three shelf meals");
    const chickenPicked = ids.filter((i) => i === "chick-a" || i === "chick-b");
    assert.equal(chickenPicked.length, 1, "only one baked-chicken version survives the cap");
  });

  it("treats non-catalog meals (null dishFamilyKey) as singleton parents (not capped)", async () => {
    const { prisma } = stubPrisma([
      mealRow({ id: "a", dishFamilyKey: null }),
      mealRow({ id: "b", dishFamilyKey: null }),
    ]);
    const out = await buildStoreShortlist(prisma, {
      ...BASE,
      config: { shortlistSize: 10, cuisineQuotaFraction: 0.7 },
    });
    assert.deepEqual([...out.aliasToId.values()].sort(), ["a", "b"]);
  });

  it("selects from the full eligible set, capped at shortlistSize (reach — no 160 window)", async () => {
    // 50 distinct-parent rows; a size-40 shelf must draw 40 of them.
    const rows = Array.from({ length: 50 }, (_, i) =>
      mealRow({ id: `m-${i}`, dishFamilyKey: null }),
    );
    const { prisma } = stubPrisma(rows);
    const out = await buildStoreShortlist(prisma, {
      ...BASE,
      config: { shortlistSize: 40, cuisineQuotaFraction: 0.7 },
    });
    assert.equal(out.forPrompt.length, 40);
  });

  it("is deterministic for a fixed (userId, rotationSalt)", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      mealRow({ id: `m-${i}`, dishFamilyKey: null }),
    );
    const cfg = { shortlistSize: 20, cuisineQuotaFraction: 0.7 };
    const a = await buildStoreShortlist(stubPrisma(rows).prisma, { ...BASE, config: cfg });
    const b = await buildStoreShortlist(stubPrisma(rows).prisma, { ...BASE, config: cfg });
    assert.deepEqual([...a.aliasToId.values()], [...b.aliasToId.values()]);
  });

  it("varies the shelf across users with identical prefs", async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      mealRow({ id: `m-${i}`, dishFamilyKey: null }),
    );
    const cfg = { shortlistSize: 20, cuisineQuotaFraction: 0.7 };
    const a = await buildStoreShortlist(stubPrisma(rows).prisma, {
      ...BASE,
      userId: "user-a",
      config: cfg,
    });
    const b = await buildStoreShortlist(stubPrisma(rows).prisma, {
      ...BASE,
      userId: "user-b",
      config: cfg,
    });
    assert.notDeepEqual(
      new Set([...a.aliasToId.values()]),
      new Set([...b.aliasToId.values()]),
    );
  });

  it("reserves the shelf majority for cuisine matches, backfilling the rest", async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        mealRow({ id: `it-${i}`, cuisineType: "Italian", dishFamilyKey: null }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        mealRow({ id: `ko-${i}`, cuisineType: "Korean", dishFamilyKey: null }),
      ),
    ];
    const { prisma } = stubPrisma(rows);
    const out = await buildStoreShortlist(prisma, {
      ...BASE,
      cuisines: ["Italian"],
      config: { shortlistSize: 6, cuisineQuotaFraction: 0.7 },
    });
    const ids = [...out.aliasToId.values()];
    const italian = ids.filter((i) => i.startsWith("it-")).length;
    const korean = ids.filter((i) => i.startsWith("ko-")).length;
    // ceil(6*0.7)=5 reserved for Italian; the remaining 1 backfills from Korean.
    assert.equal(italian, 5);
    assert.equal(korean, 1);
  });

  it("projects the lean per-meal shape the AI reasons over", async () => {
    const { prisma } = stubPrisma([
      mealRow({ id: "a", title: "Ragu", cuisineType: "Italian", tags: ["cozy"] }),
    ]);
    const out = await buildStoreShortlist(prisma, {
      ...BASE,
      config: { shortlistSize: 5, cuisineQuotaFraction: 0.7 },
    });
    assert.deepEqual(out.forPrompt[0], {
      id: "m1",
      title: "Ragu",
      cuisineType: "Italian",
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

// ── reconcile guard (D-WS9-038) — unchanged by Block 4b-1 ──────────────────

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
