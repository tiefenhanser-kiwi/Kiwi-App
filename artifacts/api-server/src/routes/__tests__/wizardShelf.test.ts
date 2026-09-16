// WS9 Redesign Arc Block 1 (D-WS9-237) — POST /api/wizard/shelf.
//
// The shelf is stubbed the way wizard.test.ts stubs it (rows handed back from
// meal.findMany), but this stub DISPATCHES on `where` because the route runs
// four distinct meal reads (the shelf pool, the named-meal pins, the card
// details, the served-lineage read). No AI call except the parse_intent stub
// for the `text` case. Every id on the wire must be a REAL id — never an
// `m1` alias.
//
// Shelf order is deterministic here: every catalog row lacks a dishFamilyKey
// (rank ties at NON_CATALOG_RANK), so the final sort is id ascending. When the
// catalog does not exceed the fetch (the discovery cases over-fetch ×2) the
// seeded sampler selects everything; otherwise it selects a seeded subset and
// the tests assert only what the contract promises.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createWizardRouter } from "../wizard";
import { persistWizardLastBatch } from "../../lib/wizardLastBatch";
import type { AICallResult } from "../../lib/ai/runAICall";
import type { ParsedIntent } from "../../lib/ai/schemas/tellKiwi";
import { withSessionUser } from "./fixtures/sessionUserStub";
import type {
  EntitlementResult,
  SubscriptionService,
} from "../../lib/subscriptionService";

// ── fixtures ────────────────────────────────────────────────────────────

interface MealRow {
  id: string;
  userId: string | null;
  title: string;
  description: string | null;
  cuisineType: string | null;
  difficulty: "easy" | "medium" | "fancy";
  mealType: "dinner";
  estimatedTimeMinutes: number;
  activeTimeMinutes: number | null;
  tags: string[];
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  dishFamilyKey: string | null;
  allergens: string[];
  isPublic: boolean;
  isArchived: boolean;
  sourceStoreMealId: string | null;
  /** Test-only: this own meal has been in a plan (planItems some). */
  served: boolean;
  dishCount: number;
}

function catalogRow(id: string, over: Partial<MealRow> = {}): MealRow {
  return {
    id,
    userId: null,
    title: `Catalog ${id}`,
    description: `Desc ${id}`,
    cuisineType: "italian",
    difficulty: "easy",
    mealType: "dinner",
    estimatedTimeMinutes: 35,
    activeTimeMinutes: 20,
    tags: ["quick"],
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
    dishFamilyKey: null,
    allergens: [],
    isPublic: true,
    isArchived: false,
    sourceStoreMealId: null,
    served: false,
    dishCount: 2,
    ...over,
  };
}

function ownRow(id: string, userId: string, over: Partial<MealRow> = {}): MealRow {
  return catalogRow(id, { userId, isPublic: false, title: `Own ${id}`, ...over });
}

interface StubOpts {
  meals: MealRow[];
  playlist?: Array<{ userId: string; mealId: string; createdAt: Date }>;
  preferences?: Record<string, unknown> | null;
}

function makeStubPrisma(opts: StubOpts) {
  const byId = new Map(opts.meals.map((m) => [m.id, m]));
  const mealWheres: Record<string, unknown>[] = [];
  const toCard = (m: MealRow) => ({ ...m, _count: { dishLinks: m.dishCount } });
  const lastBatch = new Map<string, LastBatchRow>();
  return {
    aIPrompt: { findUnique: async () => null },
    systemSetting: { findUnique: async () => null },
    userPreferences: {
      findUnique: async () =>
        opts.preferences === undefined ? { discoveryLevel: "none" } : opts.preferences,
    },
    pantryStaple: { findMany: async () => [] },
    userActivity: { findMany: async () => [], create: async (a: unknown) => a },
    mealPlanInstance: { count: async () => 0, findMany: async () => [] },
    lLMCallLog: { create: async (a: unknown) => a },
    playlistMeal: {
      // Block 2 — the resolver's zero-playlist guard counts the rows.
      count: async ({ where }: { where: { userId: string } }) =>
        (opts.playlist ?? []).filter((p) => p.userId === where.userId).length,
      findMany: async ({
        where,
      }: {
        where: {
          userId: string;
          meal: { difficulty: { in: string[] }; AND?: unknown[] };
        };
      }) =>
        (opts.playlist ?? [])
          .filter((p) => p.userId === where.userId)
          .filter((p) => {
            const m = byId.get(p.mealId);
            return (
              !!m && !m.isArchived && where.meal.difficulty.in.includes(m.difficulty)
            );
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((p) => ({
            mealId: p.mealId,
            meal: { sourceStoreMealId: byId.get(p.mealId)?.sourceStoreMealId ?? null },
          })),
    },
    meal: {
      findMany: async (args: {
        where: Record<string, any>;
        select?: Record<string, unknown>;
        take?: number;
      }) => {
        const w = args.where;
        mealWheres.push(w);
        // (d) served-lineage read: own meals that have been in a plan.
        if (w.userId && w.planItems) {
          const ids: string[] = w.OR?.[0]?.sourceStoreMealId?.in ?? [];
          const titles: string[] = (w.OR?.[1]?.title?.in ?? []).map((t: string) =>
            t.toLowerCase(),
          );
          return opts.meals
            .filter((m) => m.userId === w.userId && m.served)
            .filter(
              (m) =>
                (m.sourceStoreMealId && ids.includes(m.sourceStoreMealId)) ||
                titles.includes(m.title.toLowerCase()),
            )
            .map((m) => ({ sourceStoreMealId: m.sourceStoreMealId, title: m.title }));
        }
        // (c) card details / playlist-source families: by id. The last-batch
        // re-resolve (post-pass Part A) adds isArchived:false + a public-OR-
        // owner OR; honoured only when sent so the other by-id reads are as
        // before.
        if (w.id?.in) {
          const visibleTo: string | undefined = Array.isArray(w.OR)
            ? w.OR.find((o: Record<string, unknown>) => "userId" in o)?.userId
            : undefined;
          const rows = (w.id.in as string[])
            .map((id) => byId.get(id))
            .filter((m): m is MealRow => !!m)
            .filter((m) => (w.isArchived === false ? !m.isArchived : true))
            .filter((m) =>
              visibleTo === undefined ? true : m.isPublic || m.userId === visibleTo,
            );
          return args.select && "_count" in args.select ? rows.map(toCard) : rows;
        }
        // (b) named-meal pins: public dinner meals whose title contains a name.
        if (Array.isArray(w.OR) && w.OR[0]?.title?.contains !== undefined) {
          const names = (w.OR as Array<{ title: { contains: string } }>).map((o) =>
            o.title.contains.toLowerCase(),
          );
          return opts.meals.filter(
            (m) =>
              m.isPublic &&
              !m.isArchived &&
              names.some((n) => m.title.toLowerCase().includes(n)),
          );
        }
        // (a) the shelf pool: public dinners under the ceiling, minus exclusions.
        const notIn: string[] = w.id?.notIn ?? [];
        const allowed: string[] = w.difficulty?.in ?? ["easy", "medium", "fancy"];
        return opts.meals
          .filter((m) => m.isPublic && !m.isArchived && m.mealType === "dinner")
          .filter((m) => !notIn.includes(m.id) && allowed.includes(m.difficulty))
          .filter((m) => {
            const cap = w.estimatedTimeMinutes;
            if (!cap) return true;
            if (cap.lte !== undefined && m.estimatedTimeMinutes > cap.lte) return false;
            if (cap.gt !== undefined && m.estimatedTimeMinutes <= cap.gt) return false;
            return true;
          })
          .sort((a, b) => (a.id < b.id ? -1 : 1));
      },
    },
    _mealWheres: () => mealWheres,
    // Post-pass Part A — the single last-batch slot, Map-backed like the lib
    // test's store (one row per user; upsert = overwrite).
    wizardLastBatch: {
      upsert: async (a: {
        where: { userId: string };
        create: { userId: string; payload: unknown; source: string };
        update: { payload: unknown; source: string; createdAt: Date };
      }) => {
        const row = lastBatch.get(a.where.userId)
          ? { ...lastBatch.get(a.where.userId)!, ...a.update }
          : { ...a.create, createdAt: new Date("2026-09-16T00:00:00.000Z") };
        lastBatch.set(a.where.userId, row);
        return row;
      },
      findUnique: async (a: { where: { userId: string } }) =>
        lastBatch.get(a.where.userId) ?? null,
    },
    _lastBatch: () => lastBatch,
    _deleteMeal: (id: string) => byId.delete(id),
    _archiveMeal: (id: string) => {
      const m = byId.get(id);
      if (m) m.isArchived = true;
    },
  };
}
type LastBatchRow = { userId: string; payload: any; source: string; createdAt: Date };

function makeSubscriptionService(allowed: boolean): SubscriptionService {
  return {
    async can(): Promise<EntitlementResult> {
      return allowed ? { allowed: true } : { allowed: false, reason: "nope" };
    },
  };
}

function makeParseIntent(result: () => AICallResult<ParsedIntent>) {
  const calls: string[] = [];
  const fn = (async (promptKey: string) => {
    calls.push(promptKey);
    return result();
  }) as unknown as Parameters<typeof createWizardRouter>[0] extends
    | { runAICall?: infer R }
    | undefined
    ? R
    : never;
  return { fn, calls };
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(prisma: unknown, runAICall?: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(
    "/api",
    createWizardRouter({
      prisma: withSessionUser(prisma) as never,
      runAICall: (runAICall ??
        (async () => {
          throw new Error("no AI call expected");
        })) as never,
      subscriptionService: makeSubscriptionService(true),
      rateLimiterOpts: { capacity: 1000, refillPerSec: 1000 },
    }),
  );
  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) return reject(new Error("no bind"));
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

const BASE_BODY = {
  planDurationDays: 5,
  householdSize: 2,
  cuisines: [],
  eatingStyles: [],
  allergiesAndAvoidances: [],
  difficulty: "easy" as const,
  weeklyPacing: "mixed" as const,
};

interface ShelfMeal {
  id: string;
  title: string;
  description: string | null;
  estimatedTimeMinutes: number;
  activeTimeMinutes: number | null;
  macrosPerServing: { calories: number; protein: number; carbs: number; fat: number };
  tags: string[];
  dishCount: number;
  isNewToYou: boolean;
  isPlaylist: boolean;
  isPinned: boolean;
  source: "playlist" | "shelf";
}
interface ShelfResponse {
  meals: ShelfMeal[];
  totalEligible: number;
  hasMore: boolean;
  unmatchedNames: string[];
  textParsed?: boolean;
  metadata: { playlistCount: number; shelfRemainder: number; discoveryLevel: string | null };
}

async function shelf(
  h: Harness,
  userId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: ShelfResponse }> {
  const res = await fetch(`${h.baseUrl}/wizard/shelf`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signToken(userId)}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as ShelfResponse };
}

const U = "shelf-user";
const catalog20 = Array.from({ length: 20 }, (_, i) =>
  catalogRow(`c${String(i + 1).padStart(2, "0")}`),
);

// ── tests ────────────────────────────────────────────────────────────────

describe("POST /api/wizard/shelf — default size, real ids, thin-shelf signal", () => {
  let h: Harness;
  before(async () => {
    h = await spinUp(makeStubPrisma({ meals: catalog20 }));
  });
  after(async () => h.close());

  it("defaults to 15 cards with the card fields and REAL ids (never m1)", async () => {
    const { status, json } = await shelf(h, U, BASE_BODY);
    assert.equal(status, 200);
    assert.equal(json.meals.length, 15);
    for (const m of json.meals) {
      assert.doesNotMatch(m.id, /^m\d+$/, "alias id leaked to the wire");
      assert.match(m.id, /^c\d\d$/);
      assert.equal(m.description, `Desc ${m.id}`);
      assert.equal(m.estimatedTimeMinutes, 35);
      assert.equal(m.activeTimeMinutes, 20);
      assert.deepEqual(m.macrosPerServing, { calories: 500, protein: 30, carbs: 40, fat: 20 });
      assert.deepEqual(m.tags, ["quick"]);
      assert.equal(m.dishCount, 2);
      assert.equal(m.source, "shelf");
      assert.equal(m.isPlaylist, false);
      assert.equal(m.isNewToYou, true);
    }
    assert.equal(json.totalEligible, 20);
    assert.equal(json.hasMore, true);
    assert.deepEqual(json.unmatchedNames, []);
    assert.equal(json.metadata.discoveryLevel, null);
  });

  it("honours excludeMealIds and reports hasMore false when the pool is drained", async () => {
    const shown = catalog20.slice(0, 10).map((m) => m.id);
    const { json } = await shelf(h, U, { ...BASE_BODY, excludeMealIds: shown });
    assert.equal(json.meals.length, 10);
    for (const m of json.meals) assert.equal(shown.includes(m.id), false);
    assert.equal(json.totalEligible, 10);
    assert.equal(json.hasMore, false);
  });

  it("caps size at 20 (400 above) and honours a smaller size", async () => {
    assert.equal((await shelf(h, U, { ...BASE_BODY, size: 25 })).status, 400);
    const { json } = await shelf(h, U, { ...BASE_BODY, size: 4 });
    assert.equal(json.meals.length, 4);
    assert.equal(json.hasMore, true);
  });

  it("requires auth", async () => {
    const res = await fetch(`${h.baseUrl}/wizard/shelf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BASE_BODY),
    });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/wizard/shelf — playlist dial", () => {
  // Six eligible own playlist meals (two forked from catalog rows), one fancy
  // one the easy ceiling drops, plus a 20-row catalog.
  const own = [
    ownRow("p1", U, { sourceStoreMealId: "c01" }),
    ownRow("p2", U, { sourceStoreMealId: "c02" }),
    ownRow("p3", U),
    ownRow("p4", U),
    ownRow("p5", U),
    ownRow("p6", U, { estimatedTimeMinutes: 120, activeTimeMinutes: 90 }),
    ownRow("p7", U, { difficulty: "fancy" }),
  ];
  const playlist = own.map((m, i) => ({
    userId: U,
    mealId: m.id,
    createdAt: new Date(2026, 0, 10 - i),
  }));
  let h: Harness;
  before(async () => {
    h = await spinUp(makeStubPrisma({ meals: [...catalog20, ...own], playlist }));
  });
  after(async () => h.close());

  const playlistIds = (r: ShelfResponse) =>
    r.meals.filter((m) => m.source === "playlist").map((m) => m.id);
  const shelfIds = (r: ShelfResponse) =>
    r.meals.filter((m) => m.source === "shelf").map((m) => m.id);

  it("omitted / none → no playlist meals; the shelf excludes the playlist forks' sources", async () => {
    const { json } = await shelf(h, U, { ...BASE_BODY, size: 10 });
    assert.deepEqual(playlistIds(json), []);
    assert.equal(shelfIds(json).length, 10);
    assert.equal(shelfIds(json).includes("c01"), false, "c01 is a playlist fork's source");
    assert.equal(shelfIds(json).includes("c02"), false);
    const none = await shelf(h, U, { ...BASE_BODY, size: 10, playlistLevel: "none" });
    assert.deepEqual(playlistIds(none.json), []);
  });

  it("some = ceil(10 × 0.3) = 3 playlist + 7 shelf; the fancy meal is dropped by the easy ceiling", async () => {
    const { json } = await shelf(h, U, { ...BASE_BODY, size: 10, playlistLevel: "some" });
    assert.equal(playlistIds(json).length, 3);
    assert.equal(shelfIds(json).length, 7);
    assert.equal(json.metadata.playlistCount, 3);
    assert.equal(json.meals.slice(0, 3).every((m) => m.isPlaylist), true, "playlist first");
    for (const m of json.meals) assert.notEqual(m.id, "p7");
  });

  it("mostly = ceil(10 × 0.7) = 7 wanted, 6 eligible → 6 playlist + 4 shelf, the over-cap favourite included with its honest time", async () => {
    const { json } = await shelf(h, U, {
      ...BASE_BODY,
      size: 10,
      playlistLevel: "mostly",
      maxCookTimeMinutes: 45,
      maxCookTimeCoverage: "all",
    });
    assert.equal(playlistIds(json).length, 6);
    assert.equal(shelfIds(json).length, 4);
    const p6 = json.meals.find((m) => m.id === "p6");
    assert.ok(p6, "the 120-minute playlist meal must still be shown (BUG-245 ruling)");
    assert.equal(p6.estimatedTimeMinutes, 120);
    assert.equal(p6.activeTimeMinutes, 90);
  });

  it("all → every eligible playlist meal and NOTHING from the shelf", async () => {
    const { json } = await shelf(h, U, { ...BASE_BODY, size: 10, playlistLevel: "all" });
    assert.equal(playlistIds(json).length, 6);
    assert.deepEqual(shelfIds(json), []);
    assert.equal(json.metadata.shelfRemainder, 0);
    assert.equal(json.totalEligible, 0);
    assert.equal(json.hasMore, false);
  });

  it("playlistOnly ≡ all", async () => {
    const { json } = await shelf(h, U, { ...BASE_BODY, size: 10, playlistOnly: true });
    assert.equal(playlistIds(json).length, 6);
    assert.deepEqual(shelfIds(json), []);
  });

  // WS9 Redesign Arc Block 2 (Part E) — `source: "playlist"`: every eligible
  // playlist meal, no catalog fill, no size cap, hasMore false — "Plan a week
  // from these". Unlike playlistOnly it ignores `size` and never falls back
  // to the shelf.
  it("source: playlist → ONLY the user's playlist meals, uncapped, hasMore false", async () => {
    const { status, json } = await shelf(h, U, { ...BASE_BODY, size: 2, source: "playlist" });
    assert.equal(status, 200);
    assert.equal(json.meals.length, 6, "not capped by size: 2");
    assert.deepEqual(shelfIds(json), []);
    assert.ok(json.meals.every((m) => m.isPlaylist && m.source === "playlist"));
    assert.equal(json.meals.some((m) => m.id === "p7"), false, "the fancy one is dropped by the easy ceiling");
    assert.equal(json.hasMore, false);
    assert.equal(json.totalEligible, 6);
    assert.equal(json.metadata.shelfRemainder, 0);
    // The over-cap favourite (p6) is shown with its honest time — no cook-time cap here.
    assert.ok(json.meals.some((m) => m.id === "p6"));
    // A user with no playlist gets an empty list — not the shelf.
    const empty = await shelf(h, "shelf-user-no-playlist", { ...BASE_BODY, source: "playlist" });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.meals, []);
    assert.equal(empty.json.hasMore, false);
  });

  it("All-forces-None: playlist all + discovery all → all playlist; discovery all + playlist mostly → no playlist", async () => {
    const a = await shelf(h, U, {
      ...BASE_BODY,
      size: 10,
      playlistLevel: "all",
      discoveryLevel: "all",
    });
    assert.equal(playlistIds(a.json).length, 6);
    assert.deepEqual(shelfIds(a.json), []);
    const b = await shelf(h, U, {
      ...BASE_BODY,
      size: 10,
      playlistLevel: "mostly",
      discoveryLevel: "all",
    });
    assert.deepEqual(playlistIds(b.json), []);
    assert.equal(shelfIds(b.json).length, 10);
    assert.equal(b.json.metadata.discoveryLevel, "all");
  });
});

describe("POST /api/wizard/shelf — discovery dial ordering", () => {
  // Eight catalog rows; the user has been served c01..c05 (three via lineage,
  // two via a title match on a lineage-less live meal). c06..c08 are new.
  const catalog8 = Array.from({ length: 8 }, (_, i) =>
    catalogRow(`c${String(i + 1).padStart(2, "0")}`),
  );
  const servedOwn = [
    ownRow("o1", U, { sourceStoreMealId: "c01", served: true }),
    ownRow("o2", U, { sourceStoreMealId: "c02", served: true }),
    ownRow("o3", U, { sourceStoreMealId: "c03", served: true }),
    ownRow("o4", U, { title: "catalog C04", served: true }),
    ownRow("o5", U, { title: "Catalog c05", served: true }),
    // In a plan? No — never served, so c06 stays new-to-you.
    ownRow("o6", U, { sourceStoreMealId: "c06", served: false }),
  ];
  let h: Harness;
  before(async () => {
    h = await spinUp(makeStubPrisma({ meals: [...catalog8, ...servedOwn] }));
  });
  after(async () => h.close());

  const ids = (r: ShelfResponse) => r.meals.map((m) => m.id);
  const fresh = (r: ShelfResponse) => r.meals.filter((m) => m.isNewToYou).map((m) => m.id);

  it("omitted (stored none) = the shelf's own order (a seeded sample of 5 of 8, rank-sorted), flags still computed", async () => {
    const { json } = await shelf(h, U, { ...BASE_BODY, size: 5 });
    assert.equal(json.meals.length, 5);
    // No over-fetch and no reorder: the shelf sampled 5 of the 8 and sorted
    // them by rank (a tie here → id ascending), new-to-you NOT promoted.
    assert.deepEqual(ids(json), [...ids(json)].sort());
    assert.deepEqual(
      fresh(json),
      ids(json).filter((id) => ["c06", "c07", "c08"].includes(id)),
    );
    assert.equal(json.metadata.discoveryLevel, null);
  });

  it("none = familiar first, new fills", async () => {
    const { json } = await shelf(h, U, { ...BASE_BODY, size: 5, discoveryLevel: "none" });
    assert.deepEqual(ids(json), ["c01", "c02", "c03", "c04", "c05"]);
    const six = await shelf(h, U, { ...BASE_BODY, size: 7, discoveryLevel: "none" });
    assert.deepEqual(ids(six.json), ["c01", "c02", "c03", "c04", "c05", "c06", "c07"]);
    assert.deepEqual(fresh(six.json), ["c06", "c07"]);
  });

  it("some = ceil(5 × 0.3) = 2 new-to-you first, then the rest by rank", async () => {
    const { json } = await shelf(h, U, { ...BASE_BODY, size: 5, discoveryLevel: "some" });
    assert.deepEqual(ids(json), ["c06", "c07", "c01", "c02", "c03"]);
    assert.deepEqual(fresh(json), ["c06", "c07"]);
  });

  it("mostly = ceil(5 × 0.7) = 4 wanted, 3 available → all three new lead", async () => {
    const { json } = await shelf(h, U, { ...BASE_BODY, size: 5, discoveryLevel: "mostly" });
    assert.deepEqual(ids(json), ["c06", "c07", "c08", "c01", "c02"]);
  });

  it("all = every new-to-you first; the Block 1 legacy int key is now IGNORED (not an override)", async () => {
    const { json } = await shelf(h, U, { ...BASE_BODY, size: 5, discoveryLevel: "all" });
    assert.deepEqual(ids(json), ["c06", "c07", "c08", "c01", "c02"]);
    // Block 2 removed the shim: the schema is not .strict(), so the legacy key
    // is stripped — no per-run override, stored none → today's order.
    const legacy = await shelf(h, U, { ...BASE_BODY, size: 5, discoveryMealsPerWeek: 2 });
    assert.equal(legacy.json.metadata.discoveryLevel, null);
    assert.deepEqual(ids(legacy.json), [...ids(legacy.json)].sort(), "no reorder: the shelf's own order");
  });

  it("a STORED level with no per-run override also reorders (override ?? stored)", async () => {
    const stored = await spinUp(
      makeStubPrisma({
        meals: [...catalog8, ...servedOwn],
        preferences: { discoveryLevel: "some" },
      }),
    );
    try {
      const { json } = await shelf(stored, U, { ...BASE_BODY, size: 5 });
      assert.equal(json.metadata.discoveryLevel, "some");
      assert.deepEqual(ids(json), ["c06", "c07", "c01", "c02", "c03"]);
    } finally {
      await stored.close();
    }
  });
});

describe("POST /api/wizard/shelf — Tell Kiwi text: pins + unmatched names", () => {
  const catalog = [
    catalogRow("c01", { title: "Chicken Tikka Masala" }),
    catalogRow("c02", { title: "Butter Chicken" }),
    catalogRow("c03", { title: "Beef Tacos" }),
    catalogRow("c04"),
    catalogRow("c05"),
  ];

  it("pins title-matched named meals to the top and surfaces the rest as unmatchedNames", async () => {
    const parse = makeParseIntent(() => ({
      success: true,
      data: {
        scenario: "partial",
        explicitMeals: ["chicken tikka", "Unicorn Stew", "tacos"],
        intentDescriptors: [],
      },
      metadata: {
        promptKey: "wizard.directed.parse_intent",
        promptVersion: 1,
        model: "claude-haiku-4-5-20251001",
        mode: "tool",
        latencyMs: 10,
        inputTokens: 1,
        outputTokens: 1,
        costEstimateUsd: 0,
        retryCount: 0,
      },
    }));
    const h = await spinUp(makeStubPrisma({ meals: catalog }), parse.fn);
    try {
      const { status, json } = await shelf(h, U, {
        ...BASE_BODY,
        size: 4,
        text: "I want chicken tikka and tacos this week",
      });
      assert.equal(status, 200);
      assert.deepEqual(parse.calls, ["wizard.directed.parse_intent"]);
      assert.equal(json.textParsed, true);
      assert.deepEqual(json.unmatchedNames, ["Unicorn Stew"]);
      // Pins first (in the order named), then 2 sampled shelf rows from the
      // rest — never a pinned id twice.
      assert.deepEqual(
        json.meals.slice(0, 2).map((m) => [m.id, m.isPinned]),
        [
          ["c01", true],
          ["c03", true],
        ],
      );
      const rest = json.meals.slice(2);
      assert.equal(rest.length, 2);
      for (const m of rest) {
        assert.equal(m.isPinned, false);
        assert.ok(["c02", "c04", "c05"].includes(m.id), m.id);
      }
    } finally {
      await h.close();
    }
  });

  it("a failed parse is not a failed shelf — unpinned, textParsed false", async () => {
    const parse = makeParseIntent(() => ({
      success: false,
      reason: "validation_failed",
      userFacingMessage: "Kiwi got distracted.",
      metadata: {
        promptKey: "wizard.directed.parse_intent",
        promptVersion: 1,
        model: "claude-haiku-4-5-20251001",
        mode: "tool",
        latencyMs: 10,
        inputTokens: 1,
        outputTokens: 1,
        costEstimateUsd: 0,
        retryCount: 0,
      },
    }));
    const h = await spinUp(makeStubPrisma({ meals: catalog }), parse.fn);
    try {
      const { status, json } = await shelf(h, U, {
        ...BASE_BODY,
        size: 4,
        text: "something for the week please",
      });
      assert.equal(status, 200);
      assert.equal(json.textParsed, false);
      assert.equal(json.meals.length, 4);
      assert.equal(json.meals.some((m) => m.isPinned), false);
    } finally {
      await h.close();
    }
  });

  it("no text → no AI call at all", async () => {
    const parse = makeParseIntent(() => {
      throw new Error("must not be called");
    });
    const h = await spinUp(makeStubPrisma({ meals: catalog }), parse.fn);
    try {
      const { status, json } = await shelf(h, U, { ...BASE_BODY, size: 3 });
      assert.equal(status, 200);
      assert.deepEqual(parse.calls, []);
      assert.equal("textParsed" in json, false);
    } finally {
      await h.close();
    }
  });
});

// ── post-pass Part A ([WS9-arc-PS-A]) — "See previous options" for meals ──
// One slot, either kind, last one wins: a shelf presentation overwrites the
// last-batch row with its ORDERED refs; a plans batch overwrites it back. The
// read side re-resolves the refs to CURRENT cards and drops what is gone.

async function lastBatch(
  h: Harness,
  userId: string,
): Promise<{ status: number; json: { batch: any } }> {
  const res = await fetch(`${h.baseUrl}/wizard/last-batch`, {
    headers: { Authorization: `Bearer ${signToken(userId)}` },
  });
  return { status: res.status, json: (await res.json()) as { batch: any } };
}

describe("POST /api/wizard/shelf → last-batch slot (post-pass Part A)", () => {
  it("a shelf run writes the slot: source shelf, the on-screen ids in order, candidates []; GET re-resolves them to cards", async () => {
    const stub = makeStubPrisma({ meals: catalog20 });
    const h = await spinUp(stub);
    try {
      const { json } = await shelf(h, U, { ...BASE_BODY, size: 5 });
      const shownIds = json.meals.map((m) => m.id);
      const row = stub._lastBatch().get(U);
      assert.ok(row, "slot written");
      assert.equal(row.source, "shelf");
      assert.equal(row.payload.source, "shelf");
      assert.deepEqual(row.payload.candidates, []);
      assert.deepEqual(
        row.payload.shelf.meals.map((r: { id: string }) => r.id),
        shownIds,
      );
      assert.equal(row.payload.shelf.hasMore, true);
      assert.equal(row.payload.shelf.totalEligible, 20);
      // The stored input is the request slice (a rehydrated Pick pages from it).
      assert.equal(row.payload.input.planDurationDays, 5);

      const read = await lastBatch(h, U);
      assert.equal(read.status, 200);
      assert.equal(read.json.batch.source, "shelf");
      assert.deepEqual(read.json.batch.candidates, []);
      assert.deepEqual(
        read.json.batch.shelf.meals.map((m: { id: string }) => m.id),
        shownIds,
      );
      const first = read.json.batch.shelf.meals[0];
      // The shelf's own card serialiser — same fields as the live shelf.
      assert.equal(first.description, `Desc ${first.id}`);
      assert.deepEqual(first.macrosPerServing, { calories: 500, protein: 30, carbs: 40, fat: 20 });
      assert.equal(first.dishCount, 2);
      assert.equal(first.source, "shelf");
      assert.equal(first.isNewToYou, true);
      assert.equal(read.json.batch.shelf.hasMore, true);
      assert.equal(read.json.batch.shelf.totalEligible, 20);
    } finally {
      await h.close();
    }
  });

  it("a 'Get more options' round stores WHAT IS ON SCREEN: excludeMealIds (prior flags kept) + the fresh page, first-page input retained", async () => {
    const stub = makeStubPrisma({ meals: catalog20 });
    const h = await spinUp(stub);
    try {
      const first = await shelf(h, U, { ...BASE_BODY, size: 4, cuisines: ["italian"] });
      const firstIds = first.json.meals.map((m) => m.id);
      const more = await shelf(h, U, { ...BASE_BODY, size: 3, excludeMealIds: firstIds });
      const moreIds = more.json.meals.map((m) => m.id);
      assert.equal(moreIds.length, 3);
      const row = stub._lastBatch().get(U)!;
      assert.deepEqual(
        row.payload.shelf.meals.map((r: { id: string }) => r.id),
        [...firstIds, ...moreIds],
      );
      // The first page's request slice survives the paging round.
      assert.deepEqual(row.payload.input.cuisines, ["italian"]);
      assert.equal(row.payload.input.size, 4);
      assert.equal("excludeMealIds" in row.payload.input, false);
    } finally {
      await h.close();
    }
  });

  it("a plans batch OVERWRITES a shelf batch (and vice versa) — one slot, last one wins", async () => {
    const stub = makeStubPrisma({ meals: catalog20 });
    const h = await spinUp(stub);
    try {
      await shelf(h, U, { ...BASE_BODY, size: 3 });
      assert.equal(stub._lastBatch().get(U)!.source, "shelf");
      // The plans write path is unchanged (wizard.test.ts pins it); the
      // overwrite is the same upsert, driven here through the lib.
      await persistWizardLastBatch({
        prisma: stub as never,
        userId: U,
        source: "wizard",
        candidates: [
          {
            id: "c1",
            title: "Cozy Week",
            tags: [],
            whyBullets: ["x"],
            mealTitles: ["Soup"],
            dailyMacros: { calories: 1, proteinG: 1, carbsG: 1, fatG: 1 },
            meals: [{ title: "Soup", description: null }],
          },
        ],
        input: { planDurationDays: 5 },
      });
      const afterPlans = await lastBatch(h, U);
      assert.equal(afterPlans.json.batch.source, "wizard");
      assert.equal(afterPlans.json.batch.candidates.length, 1);
      assert.equal("shelf" in afterPlans.json.batch, false);

      await shelf(h, U, { ...BASE_BODY, size: 3 });
      const afterShelf = await lastBatch(h, U);
      assert.equal(afterShelf.json.batch.source, "shelf");
      assert.equal(afterShelf.json.batch.shelf.meals.length, 3);
    } finally {
      await h.close();
    }
  });

  it("a meal deleted or archived since simply drops out of the re-resolved cards, order kept", async () => {
    const stub = makeStubPrisma({ meals: catalog20 });
    const h = await spinUp(stub);
    try {
      const { json } = await shelf(h, U, { ...BASE_BODY, size: 5 });
      const ids = json.meals.map((m) => m.id);
      stub._deleteMeal(ids[1]);
      stub._archiveMeal(ids[3]);
      const read = await lastBatch(h, U);
      assert.equal(read.status, 200);
      assert.deepEqual(
        read.json.batch.shelf.meals.map((m: { id: string }) => m.id),
        [ids[0], ids[2], ids[4]],
      );
    } finally {
      await h.close();
    }
  });

  it("an emptied batch is NOT an error — { batch: null }", async () => {
    const stub = makeStubPrisma({ meals: catalog20 });
    const h = await spinUp(stub);
    try {
      const { json } = await shelf(h, U, { ...BASE_BODY, size: 2 });
      for (const m of json.meals) stub._deleteMeal(m.id);
      const read = await lastBatch(h, U);
      assert.equal(read.status, 200);
      assert.equal(read.json.batch, null);
    } finally {
      await h.close();
    }
  });

  it("source: playlist (the user's own list) and an empty shelf do NOT touch the slot", async () => {
    const stub = makeStubPrisma({
      meals: [...catalog20, ownRow("own1", U)],
      playlist: [{ userId: U, mealId: "own1", createdAt: new Date() }],
    });
    const h = await spinUp(stub);
    try {
      await shelf(h, U, { ...BASE_BODY, size: 3 });
      const before = stub._lastBatch().get(U)!;
      const pl = await shelf(h, U, { ...BASE_BODY, source: "playlist" });
      assert.equal(pl.json.meals.length, 1);
      assert.equal(stub._lastBatch().get(U), before, "playlist run left the slot alone");
      // Every catalog id excluded → nothing shown → no write.
      const empty = await shelf(h, U, {
        ...BASE_BODY,
        playlistLevel: "none",
        excludeMealIds: catalog20.map((m) => m.id),
      });
      assert.equal(empty.json.meals.length, 0);
      assert.equal(stub._lastBatch().get(U), before, "empty shelf left the slot alone");
    } finally {
      await h.close();
    }
  });
});
