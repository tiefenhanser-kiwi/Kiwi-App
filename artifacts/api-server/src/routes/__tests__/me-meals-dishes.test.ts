// WS7-3 A2 — GET /me/meals + GET /me/dishes tests.
//
// Covers filter parsing, multi-select OR semantics + dedup, in-memory cursor
// pagination, the Meal/Dish featuring-gap empty-array path, and auth.
//
// Same lightweight harness as meals-catalog.test.ts / me-favorites.test.ts:
// node:test, real signed JWT, prisma stubbed at the factory deps boundary.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createMeRouter } from "../me";

const USER_ID = "test-user-me-catalog";

// ── fixtures ───────────────────────────────────────────────────────────

interface MealOpts {
  userId?: string | null;
  isPublic?: boolean;
  isArchived?: boolean;
  saveCount?: number;
  useCount?: number;
  // WS7-6 G2: estimatedTimeMinutes + createdAt are now selected for the
  // cook_time / date_created keyset sorts. Defaults fixed so existing
  // fixtures don't drift over time.
  estimatedTimeMinutes?: number;
  createdAt?: Date;
}

function mealRow(id: string, title: string, opts: MealOpts = {}) {
  return {
    id,
    title,
    cuisineType: "Testian",
    estimatedTimeMinutes: opts.estimatedTimeMinutes ?? 30,
    servingsDefault: 4,
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
    tags: ["weeknight"],
    imageUrl: null,
    createdAt: opts.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    userId: opts.userId ?? null,
    isPublic: opts.isPublic ?? false,
    isArchived: opts.isArchived ?? false,
    saveCount: opts.saveCount ?? 0,
    useCount: opts.useCount ?? 0,
  };
}

function dishRow(
  id: string,
  title: string,
  opts: {
    userId?: string | null;
    isArchived?: boolean;
    estimatedTimeMinutes?: number;
    createdAt?: Date;
    // WS7-6 B-fix Block 2: MealDishLink count surfaced as `mealUseCount` on
    // the wire and used by `sort=times_cooked`. Defaults to 0 so existing
    // fixtures don't have to opt in.
    // WS7-6 B-fix Block 3: `mealUseCount` is now the LIVE-meal link count (the
    // value the wire shows). `archivedLinkCount` adds links to ARCHIVED meals
    // that must NOT count toward the wire field or the times_cooked ranking.
    mealUseCount?: number;
    archivedLinkCount?: number;
  } = {},
) {
  const live = opts.mealUseCount ?? 0;
  const archived = opts.archivedLinkCount ?? 0;
  return {
    id,
    title,
    estimatedTimeMinutes: opts.estimatedTimeMinutes ?? 25,
    servingsDefault: 4,
    difficulty: "easy",
    caloriesPerServing: 300,
    proteinGPerServing: 15,
    carbsGPerServing: 25,
    fatGPerServing: 10,
    tags: ["side"],
    imageUrl: null,
    // WS7-6 B-fix Block 1: createdAt selected for the date_created sort
    // cursor. Default fixed so existing tests don't drift over time.
    createdAt: opts.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    userId: opts.userId ?? null,
    isArchived: opts.isArchived ?? false,
    // WS7-6 B-fix Block 3: link counts split by meal liveness so the stub can
    // honor the route's FILTERED `_count` select (live count) vs an
    // unfiltered one (live + archived). `_count` is recomputed per query in
    // dish.findMany below from these two fields.
    __liveLinks: live,
    __archivedLinks: archived,
    _count: { mealLinks: live },
  };
}

type MealRow = ReturnType<typeof mealRow>;
type DishRow = ReturnType<typeof dishRow>;

const TOP_RATED_SETTINGS = [
  { key: "top_rated.save_weight", value: 1 },
  { key: "top_rated.use_weight", value: 2 },
  { key: "top_rated.decay_half_life_days", value: 30 },
  { key: "top_rated.refresh_interval_hours", value: 6 },
  { key: "top_rated.display_count", value: 20 },
];

// ── prisma stub ────────────────────────────────────────────────────────

function makeStubPrisma(opts: {
  meals?: MealRow[];
  dishes?: DishRow[];
  settings?: { key: string; value: unknown }[];
}) {
  const meals = opts.meals ?? [];
  const dishes = opts.dishes ?? [];
  const settings = opts.settings ?? TOP_RATED_SETTINGS;

  return {
    meal: {
      findMany: async (args: {
        where: { userId?: string; isPublic?: boolean; isArchived?: boolean };
        // WS7-6 G2: the /me/meals route switched to the array orderBy form
        // ([{ title|createdAt|estimatedTimeMinutes }, { id }]) for keyset sort.
        // The single-object form is no longer emitted but handled for safety.
        orderBy?:
          | { title?: "asc" | "desc" }
          | Array<Record<string, "asc" | "desc">>;
      }) => {
        let rows = meals.slice();
        const w = args.where;
        if (w.userId !== undefined) rows = rows.filter((m) => m.userId === w.userId);
        if (w.isPublic !== undefined) rows = rows.filter((m) => m.isPublic === w.isPublic);
        if (w.isArchived !== undefined)
          rows = rows.filter((m) => m.isArchived === w.isArchived);
        // Multi-key orderBy: walk fields in order, first non-equal wins
        // (mirrors the dish stub). Handles Date (createdAt), number
        // (estimatedTimeMinutes), and string (title / id).
        const ob = args.orderBy;
        const keys = Array.isArray(ob)
          ? ob
          : ob && typeof ob === "object"
            ? [ob as Record<string, "asc" | "desc">]
            : [];
        if (keys.length > 0) {
          rows = rows.sort((a, b) => {
            for (const k of keys) {
              const [field, dir] = Object.entries(k)[0] as [
                string,
                "asc" | "desc",
              ];
              const av = a[field as keyof MealRow];
              const bv = b[field as keyof MealRow];
              let cmp = 0;
              if (av instanceof Date && bv instanceof Date) {
                cmp = av.getTime() - bv.getTime();
              } else if (typeof av === "number" && typeof bv === "number") {
                cmp = av - bv;
              } else {
                cmp = String(av).localeCompare(String(bv));
              }
              if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
            }
            return 0;
          });
        }
        return rows;
      },
    },
    dish: {
      findMany: async (args: {
        where: { userId?: string; isArchived?: boolean };
        orderBy?:
          | { title?: "asc" | "desc" }
          | Array<
              Record<string, "asc" | "desc" | { _count: "asc" | "desc" }>
            >;
        // WS7-6 B-fix Block 3: the route selects a FILTERED relation count;
        // model just enough of the select shape to read its where clause.
        select?: {
          _count?: {
            select?: {
              mealLinks?: boolean | { where?: { meal?: { isArchived?: boolean } } };
            };
          };
        };
      }) => {
        let rows = dishes.slice();
        const w = args.where;
        if (w.userId !== undefined) rows = rows.filter((d) => d.userId === w.userId);
        if (w.isArchived !== undefined)
          rows = rows.filter((d) => d.isArchived === w.isArchived);
        // Multi-key orderBy: walk fields in order, first non-equal wins.
        // Single-object orderBy ({ title: "asc" }) is the legacy form still
        // used by other meal tests; the dishes route switched to array form
        // in WS7-6 B-fix Block 1. WS7-6 B-fix Block 2 adds the relation-count
        // form `{ mealLinks: { _count: "desc" } }` for sort=times_cooked.
        const ob = args.orderBy;
        const keys = Array.isArray(ob)
          ? ob
          : ob && typeof ob === "object"
            ? [
                ob as Record<
                  string,
                  "asc" | "desc" | { _count: "asc" | "desc" }
                >,
              ]
            : [];
        if (keys.length > 0) {
          rows = rows.sort((a, b) => {
            for (const k of keys) {
              const [field, spec] = Object.entries(k)[0] as [
                string,
                "asc" | "desc" | { _count: "asc" | "desc" },
              ];
              let av: unknown;
              let bv: unknown;
              let dir: "asc" | "desc";
              if (typeof spec === "object" && spec !== null && "_count" in spec) {
                // Relation-count ordering: read from row._count[<relation>].
                av = a._count[field as keyof typeof a._count];
                bv = b._count[field as keyof typeof b._count];
                dir = spec._count;
              } else {
                av = a[field as keyof DishRow];
                bv = b[field as keyof DishRow];
                dir = spec;
              }
              let cmp = 0;
              if (av instanceof Date && bv instanceof Date) {
                cmp = av.getTime() - bv.getTime();
              } else if (typeof av === "number" && typeof bv === "number") {
                cmp = av - bv;
              } else {
                cmp = String(av).localeCompare(String(bv));
              }
              if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
            }
            return 0;
          });
        }
        // WS7-6 B-fix Block 3: project `_count.mealLinks` from the select.
        // A `where: { meal: { isArchived: false } }` clause → live-only count;
        // an unfiltered `mealLinks: true` → live + archived. This is what the
        // real filtered relation count does (probe 0.2a).
        const mlSel = args.select?._count?.select?.mealLinks;
        const filterLive =
          typeof mlSel === "object" &&
          mlSel.where?.meal?.isArchived === false;
        return rows.map((d) => ({
          ...d,
          _count: {
            mealLinks: filterLive
              ? d.__liveLinks
              : d.__liveLinks + d.__archivedLinks,
          },
        }));
      },
    },
    systemSetting: {
      findMany: async (args: { where: { key: { in: string[] } } }) =>
        settings.filter((s) => args.where.key.in.includes(s.key)),
    },
  };
}

// ── harness ────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
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

function authGet(harness: Harness, path: string, withAuth = true) {
  return fetch(`${harness.baseUrl}${path}`, {
    headers: withAuth ? { Authorization: `Bearer ${signToken(USER_ID)}` } : {},
  });
}

// ── GET /me/meals ──────────────────────────────────────────────────────

describe("GET /me/meals", () => {
  it("defaults to my_meals when ?filter is omitted; excludes other users + archived", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        meals: [
          mealRow("m-own-b", "Beta", { userId: USER_ID }),
          mealRow("m-own-a", "Alpha", { userId: USER_ID }),
          mealRow("m-own-arch", "Archived", { userId: USER_ID, isArchived: true }),
          mealRow("m-stranger", "Stranger Meal", { userId: "other-user" }),
        ],
      }),
    );
    try {
      const res = await authGet(harness, "/me/meals");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        meals: { id: string }[];
        nextCursor: string | null;
      };
      // Only the two owned, non-archived meals — title A-Z.
      assert.deepEqual(
        body.meals.map((m) => m.id),
        ["m-own-a", "m-own-b"],
      );
      assert.equal(body.nextCursor, null);
    } finally {
      await harness.close();
    }
  });

  it("uses the renamed flat list shape (cuisine/minutes/calories)", async () => {
    const harness = await spinUp(
      makeStubPrisma({ meals: [mealRow("m1", "One", { userId: USER_ID })] }),
    );
    try {
      const res = await authGet(harness, "/me/meals");
      const body = (await res.json()) as { meals: Record<string, unknown>[] };
      const m = body.meals[0];
      assert.equal(m.cuisine, "Testian");
      assert.equal(m.minutes, 30);
      assert.equal(m.calories, 500);
      assert.equal(m.image, null);
    } finally {
      await harness.close();
    }
  });

  it("featured + hosting resolve to an empty block (Meal featuring gap)", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        meals: [mealRow("m-pub", "Public", { isPublic: true })],
      }),
    );
    try {
      const res = await authGet(harness, "/me/meals?filter=featured,hosting");
      assert.equal(res.status, 200);
      const body = (await res.json()) as { meals: unknown[] };
      assert.deepEqual(body.meals, []);
    } finally {
      await harness.close();
    }
  });

  it("top_rated ranks public meals by weighted counters and caps at display_count", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        meals: [
          mealRow("m-low", "Low", { isPublic: true, saveCount: 1, useCount: 1 }),
          mealRow("m-mid", "Mid", { isPublic: true, saveCount: 5, useCount: 0 }),
          mealRow("m-high", "High", { isPublic: true, saveCount: 0, useCount: 10 }),
          mealRow("m-private", "Private", { saveCount: 99, useCount: 99 }),
        ],
        // display_count = 2 → only the top two enter the result.
        settings: [
          { key: "top_rated.save_weight", value: 1 },
          { key: "top_rated.use_weight", value: 2 },
          { key: "top_rated.decay_half_life_days", value: 30 },
          { key: "top_rated.refresh_interval_hours", value: 6 },
          { key: "top_rated.display_count", value: 2 },
        ],
      }),
    );
    try {
      const res = await authGet(harness, "/me/meals?filter=top_rated");
      const body = (await res.json()) as { meals: { id: string }[] };
      // scores: high=20, mid=5, low=3 → top 2 = [high, mid]. Private excluded.
      assert.deepEqual(
        body.meals.map((m) => m.id),
        ["m-high", "m-mid"],
      );
    } finally {
      await harness.close();
    }
  });

  it("OR semantics: my_meals,top_rated merges both facets and dedupes shared rows", async () => {
    const shared = mealRow("m-shared", "Shared", {
      userId: USER_ID,
      isPublic: true,
      saveCount: 4,
      useCount: 0,
    });
    const harness = await spinUp(
      makeStubPrisma({
        meals: [
          mealRow("m-own", "Owned Only", { userId: USER_ID }),
          shared,
          mealRow("m-pub", "Public Only", { isPublic: true, saveCount: 9, useCount: 0 }),
        ],
      }),
    );
    try {
      const res = await authGet(harness, "/me/meals?filter=my_meals,top_rated");
      assert.equal(res.status, 200);
      const body = (await res.json()) as { meals: { id: string }[] };
      const ids = body.meals.map((m) => m.id);
      // my_meals block first (owned + shared, A-Z), then top_rated block
      // (public: shared, pub) with shared deduped out.
      assert.deepEqual(ids, ["m-own", "m-shared", "m-pub"]);
      // each id appears exactly once
      assert.equal(new Set(ids).size, ids.length);
    } finally {
      await harness.close();
    }
  });

  it("rejects an unknown filter value with 400", async () => {
    const harness = await spinUp(makeStubPrisma({}));
    try {
      const res = await authGet(harness, "/me/meals?filter=my_meals,bogus");
      assert.equal(res.status, 400);
      const body = (await res.json()) as { unknown: string[] };
      assert.deepEqual(body.unknown, ["bogus"]);
    } finally {
      await harness.close();
    }
  });

  it("round-trips the cursor across pages", async () => {
    const meals = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((t, i) =>
      mealRow(`m-${i}`, t, { userId: USER_ID }),
    );
    const harness = await spinUp(makeStubPrisma({ meals }));
    try {
      const r1 = await authGet(harness, "/me/meals?limit=2");
      const p1 = (await r1.json()) as {
        meals: { id: string }[];
        nextCursor: string | null;
      };
      assert.deepEqual(
        p1.meals.map((m) => m.id),
        ["m-0", "m-1"],
      );
      // WS7-6 G2: nextCursor is now an opaque base64url keyset cursor (not the
      // raw last-row id). It's still URL-safe to pass straight back.
      assert.equal(typeof p1.nextCursor, "string");
      assert.notEqual(p1.nextCursor, "m-1");

      const r2 = await authGet(
        harness,
        `/me/meals?limit=2&cursor=${p1.nextCursor}`,
      );
      const p2 = (await r2.json()) as {
        meals: { id: string }[];
        nextCursor: string | null;
      };
      assert.deepEqual(
        p2.meals.map((m) => m.id),
        ["m-2", "m-3"],
      );
      assert.equal(typeof p2.nextCursor, "string");

      const r3 = await authGet(
        harness,
        `/me/meals?limit=2&cursor=${p2.nextCursor}`,
      );
      const p3 = (await r3.json()) as {
        meals: { id: string }[];
        nextCursor: string | null;
      };
      assert.deepEqual(
        p3.meals.map((m) => m.id),
        ["m-4"],
      );
      assert.equal(p3.nextCursor, null);
    } finally {
      await harness.close();
    }
  });

  // ── WS7-6 G2 scope (iii): sort param + keyset cursor ───────────────────

  it("sort=date_created orders by createdAt desc (newest first)", async () => {
    const meals = [
      mealRow("m-old", "Z-old", {
        userId: USER_ID,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      mealRow("m-new", "A-new", {
        userId: USER_ID,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
      mealRow("m-mid", "M-mid", {
        userId: USER_ID,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ];
    const harness = await spinUp(makeStubPrisma({ meals }));
    try {
      const res = await authGet(harness, "/me/meals?sort=date_created");
      const body = (await res.json()) as { meals: { id: string }[] };
      assert.deepEqual(
        body.meals.map((m) => m.id),
        ["m-new", "m-mid", "m-old"],
      );
    } finally {
      await harness.close();
    }
  });

  it("sort=cook_time orders by minutes asc", async () => {
    const meals = [
      mealRow("m-slow", "Slow", { userId: USER_ID, estimatedTimeMinutes: 90 }),
      mealRow("m-fast", "Fast", { userId: USER_ID, estimatedTimeMinutes: 10 }),
      mealRow("m-med", "Med", { userId: USER_ID, estimatedTimeMinutes: 45 }),
    ];
    const harness = await spinUp(makeStubPrisma({ meals }));
    try {
      const res = await authGet(harness, "/me/meals?sort=cook_time");
      const body = (await res.json()) as { meals: { id: string }[] };
      assert.deepEqual(
        body.meals.map((m) => m.id),
        ["m-fast", "m-med", "m-slow"],
      );
    } finally {
      await harness.close();
    }
  });

  it("unknown sort falls back to alpha (no 400)", async () => {
    const meals = [
      mealRow("m-b", "Bravo", { userId: USER_ID }),
      mealRow("m-a", "Alpha", { userId: USER_ID }),
    ];
    const harness = await spinUp(makeStubPrisma({ meals }));
    try {
      const res = await authGet(harness, "/me/meals?sort=bogus");
      assert.equal(res.status, 200);
      const body = (await res.json()) as { meals: { id: string }[] };
      assert.deepEqual(
        body.meals.map((m) => m.id),
        ["m-a", "m-b"],
      );
    } finally {
      await harness.close();
    }
  });

  it("id:asc tiebreak when titles are equal (stable page boundary)", async () => {
    const meals = [
      mealRow("m-3", "Same", { userId: USER_ID }),
      mealRow("m-1", "Same", { userId: USER_ID }),
      mealRow("m-2", "Same", { userId: USER_ID }),
    ];
    const harness = await spinUp(makeStubPrisma({ meals }));
    try {
      const res = await authGet(harness, "/me/meals");
      const body = (await res.json()) as { meals: { id: string }[] };
      assert.deepEqual(
        body.meals.map((m) => m.id),
        ["m-1", "m-2", "m-3"],
      );
    } finally {
      await harness.close();
    }
  });

  it("malformed cursor falls back to the first page", async () => {
    const meals = ["Alpha", "Bravo", "Charlie"].map((t, i) =>
      mealRow(`m-${i}`, t, { userId: USER_ID }),
    );
    const harness = await spinUp(makeStubPrisma({ meals }));
    try {
      const res = await authGet(
        harness,
        "/me/meals?limit=2&cursor=not-a-valid-cursor",
      );
      const body = (await res.json()) as {
        meals: { id: string }[];
        nextCursor: string | null;
      };
      assert.deepEqual(
        body.meals.map((m) => m.id),
        ["m-0", "m-1"],
      );
      assert.equal(typeof body.nextCursor, "string");
    } finally {
      await harness.close();
    }
  });

  it("a cursor minted under a different sort is treated as the first page", async () => {
    const meals = ["Alpha", "Bravo", "Charlie", "Delta"].map((t, i) =>
      mealRow(`m-${i}`, t, { userId: USER_ID }),
    );
    const harness = await spinUp(makeStubPrisma({ meals }));
    try {
      // page 1 under alpha → mints an alpha cursor.
      const r1 = await authGet(harness, "/me/meals?limit=2&sort=alpha");
      const p1 = (await r1.json()) as { nextCursor: string | null };
      // present the alpha cursor under cook_time → cross-sort → first page.
      // All minutes are equal (30) so cook_time falls to the id:asc tiebreak.
      const r2 = await authGet(
        harness,
        `/me/meals?limit=2&sort=cook_time&cursor=${p1.nextCursor}`,
      );
      const p2 = (await r2.json()) as { meals: { id: string }[] };
      assert.deepEqual(
        p2.meals.map((m) => m.id),
        ["m-0", "m-1"],
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects 401 when no auth header is present", async () => {
    const harness = await spinUp(makeStubPrisma({}));
    try {
      const res = await authGet(harness, "/me/meals", false);
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

// ── GET /me/dishes ─────────────────────────────────────────────────────

describe("GET /me/dishes", () => {
  it("defaults to my_dishes; excludes other users + archived; renamed shape", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        dishes: [
          dishRow("d-b", "Bravo", { userId: USER_ID }),
          dishRow("d-a", "Alpha", { userId: USER_ID }),
          dishRow("d-arch", "Archived", { userId: USER_ID, isArchived: true }),
          dishRow("d-stranger", "Stranger", { userId: "other-user" }),
        ],
      }),
    );
    try {
      const res = await authGet(harness, "/me/dishes");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        dishes: Record<string, unknown>[];
        nextCursor: string | null;
      };
      assert.deepEqual(
        body.dishes.map((d) => d.id),
        ["d-a", "d-b"],
      );
      // renamed flat shape, plus dish-intrinsic difficulty
      assert.equal(body.dishes[0].minutes, 25);
      assert.equal(body.dishes[0].servings, 4);
      assert.equal(body.dishes[0].difficulty, "easy");
      assert.equal(body.dishes[0].calories, 300);
    } finally {
      await harness.close();
    }
  });

  it("featured + top_rated resolve to an empty block (Dish featuring gap)", async () => {
    const harness = await spinUp(
      makeStubPrisma({ dishes: [dishRow("d-1", "One", { userId: USER_ID })] }),
    );
    try {
      const res = await authGet(harness, "/me/dishes?filter=featured,top_rated");
      assert.equal(res.status, 200);
      const body = (await res.json()) as { dishes: unknown[] };
      assert.deepEqual(body.dishes, []);
    } finally {
      await harness.close();
    }
  });

  it("rejects an unknown filter value with 400 (hosting is not a dish filter)", async () => {
    const harness = await spinUp(makeStubPrisma({}));
    try {
      const res = await authGet(harness, "/me/dishes?filter=hosting");
      assert.equal(res.status, 400);
      const body = (await res.json()) as { unknown: string[] };
      assert.deepEqual(body.unknown, ["hosting"]);
    } finally {
      await harness.close();
    }
  });

  it("rejects 401 when no auth header is present", async () => {
    const harness = await spinUp(makeStubPrisma({}));
    try {
      const res = await authGet(harness, "/me/dishes", false);
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

// ── GET /me/dishes — sort + keyset cursor (WS7-6 B-fix Block 1) ────────

describe("GET /me/dishes sort + keyset cursor", () => {
  // Five dishes with deliberately interleaved title / createdAt / cook-time
  // so each sort produces a distinct order — easy to assert against and
  // catches dimensions accidentally collapsing into one.
  const fixture = (): DishRow[] => [
    dishRow("d-1", "Alpha", {
      userId: USER_ID,
      estimatedTimeMinutes: 30,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    }),
    dishRow("d-2", "Bravo", {
      userId: USER_ID,
      estimatedTimeMinutes: 10,
      createdAt: new Date("2026-01-15T00:00:00.000Z"),
    }),
    dishRow("d-3", "Charlie", {
      userId: USER_ID,
      estimatedTimeMinutes: 45,
      createdAt: new Date("2026-05-10T00:00:00.000Z"),
    }),
    dishRow("d-4", "Delta", {
      userId: USER_ID,
      estimatedTimeMinutes: 20,
      createdAt: new Date("2026-02-20T00:00:00.000Z"),
    }),
    dishRow("d-5", "Echo", {
      userId: USER_ID,
      estimatedTimeMinutes: 15,
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
    }),
  ];

  it("default sort is alpha; explicit sort=alpha returns the same order", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: fixture() }));
    try {
      const a = await (await authGet(harness, "/me/dishes")).json() as {
        dishes: { id: string }[];
      };
      const b = await (await authGet(harness, "/me/dishes?sort=alpha")).json() as {
        dishes: { id: string }[];
      };
      assert.deepEqual(
        a.dishes.map((d) => d.id),
        ["d-1", "d-2", "d-3", "d-4", "d-5"],
      );
      assert.deepEqual(b.dishes.map((d) => d.id), a.dishes.map((d) => d.id));
    } finally {
      await harness.close();
    }
  });

  it("sort=date_created orders newest-first", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: fixture() }));
    try {
      const res = await authGet(harness, "/me/dishes?sort=date_created");
      const body = (await res.json()) as { dishes: { id: string }[] };
      // createdAt desc: d-3 (May) > d-5 (Apr) > d-1 (Mar) > d-4 (Feb) > d-2 (Jan)
      assert.deepEqual(
        body.dishes.map((d) => d.id),
        ["d-3", "d-5", "d-1", "d-4", "d-2"],
      );
    } finally {
      await harness.close();
    }
  });

  it("sort=cook_time orders ascending by estimatedTimeMinutes (non-nullable col)", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: fixture() }));
    try {
      const res = await authGet(harness, "/me/dishes?sort=cook_time");
      const body = (await res.json()) as {
        dishes: { id: string; minutes: number }[];
      };
      // minutes asc: d-2 (10) < d-5 (15) < d-4 (20) < d-1 (30) < d-3 (45)
      assert.deepEqual(
        body.dishes.map((d) => d.id),
        ["d-2", "d-5", "d-4", "d-1", "d-3"],
      );
      assert.deepEqual(
        body.dishes.map((d) => d.minutes),
        [10, 15, 20, 30, 45],
      );
    } finally {
      await harness.close();
    }
  });

  it("unknown sort value silently falls back to alpha (no 400)", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: fixture() }));
    try {
      const res = await authGet(harness, "/me/dishes?sort=last_cooked");
      assert.equal(res.status, 200);
      const body = (await res.json()) as { dishes: { id: string }[] };
      assert.deepEqual(
        body.dishes.map((d) => d.id),
        ["d-1", "d-2", "d-3", "d-4", "d-5"],
      );
    } finally {
      await harness.close();
    }
  });

  it("paginates 3 pages under sort=date_created with no skips or dupes", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: fixture() }));
    try {
      const p1 = (await (
        await authGet(harness, "/me/dishes?sort=date_created&limit=2")
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p1.dishes.map((d) => d.id),
        ["d-3", "d-5"],
      );
      assert.ok(p1.nextCursor, "page 1 should yield a cursor");

      const p2 = (await (
        await authGet(
          harness,
          `/me/dishes?sort=date_created&limit=2&cursor=${encodeURIComponent(
            p1.nextCursor!,
          )}`,
        )
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p2.dishes.map((d) => d.id),
        ["d-1", "d-4"],
      );
      assert.ok(p2.nextCursor, "page 2 should yield a cursor");

      const p3 = (await (
        await authGet(
          harness,
          `/me/dishes?sort=date_created&limit=2&cursor=${encodeURIComponent(
            p2.nextCursor!,
          )}`,
        )
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p3.dishes.map((d) => d.id),
        ["d-2"],
      );
      assert.equal(p3.nextCursor, null);

      // Concatenated pages match a single-page fetch — no skips, no dupes.
      const merged = [...p1.dishes, ...p2.dishes, ...p3.dishes].map((d) => d.id);
      assert.deepEqual(merged, ["d-3", "d-5", "d-1", "d-4", "d-2"]);
      assert.equal(new Set(merged).size, merged.length);
    } finally {
      await harness.close();
    }
  });

  it("paginates 3 pages under sort=cook_time with no skips or dupes", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: fixture() }));
    try {
      const p1 = (await (
        await authGet(harness, "/me/dishes?sort=cook_time&limit=2")
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      const p2 = (await (
        await authGet(
          harness,
          `/me/dishes?sort=cook_time&limit=2&cursor=${encodeURIComponent(
            p1.nextCursor!,
          )}`,
        )
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      const p3 = (await (
        await authGet(
          harness,
          `/me/dishes?sort=cook_time&limit=2&cursor=${encodeURIComponent(
            p2.nextCursor!,
          )}`,
        )
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      const merged = [...p1.dishes, ...p2.dishes, ...p3.dishes].map((d) => d.id);
      assert.deepEqual(merged, ["d-2", "d-5", "d-4", "d-1", "d-3"]);
      assert.equal(p3.nextCursor, null);
    } finally {
      await harness.close();
    }
  });

  it("ties on the primary sort value are stably broken by id (asc tiebreaker)", async () => {
    // Three dishes share estimatedTimeMinutes = 20 — id order must decide.
    const tied: DishRow[] = [
      dishRow("d-y", "Yankee", { userId: USER_ID, estimatedTimeMinutes: 20 }),
      dishRow("d-a", "Alpha", { userId: USER_ID, estimatedTimeMinutes: 20 }),
      dishRow("d-m", "Mike", { userId: USER_ID, estimatedTimeMinutes: 20 }),
      dishRow("d-z", "Zulu", { userId: USER_ID, estimatedTimeMinutes: 5 }),
    ];
    const harness = await spinUp(makeStubPrisma({ dishes: tied }));
    try {
      // Page 1: cook_time asc → d-z (5), then tied trio in id-asc order:
      //   d-a, d-m, d-y. limit=2 takes [d-z, d-a].
      const p1 = (await (
        await authGet(harness, "/me/dishes?sort=cook_time&limit=2")
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p1.dishes.map((d) => d.id),
        ["d-z", "d-a"],
      );
      // Page 2 starts after d-a — same tie bucket; id-asc puts d-m next, d-y last.
      const p2 = (await (
        await authGet(
          harness,
          `/me/dishes?sort=cook_time&limit=10&cursor=${encodeURIComponent(
            p1.nextCursor!,
          )}`,
        )
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p2.dishes.map((d) => d.id),
        ["d-m", "d-y"],
      );
      assert.equal(p2.nextCursor, null);
    } finally {
      await harness.close();
    }
  });

  it("cursor minted under a different sort is treated as no-cursor (first page)", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: fixture() }));
    try {
      // Mint a cursor under sort=date_created at limit=2.
      const minted = (await (
        await authGet(harness, "/me/dishes?sort=date_created&limit=2")
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      assert.ok(minted.nextCursor);
      // Present that cursor under sort=alpha — the request should ignore it
      // and return page 1 of alpha rather than slicing.
      const res = (await (
        await authGet(
          harness,
          `/me/dishes?sort=alpha&limit=2&cursor=${encodeURIComponent(
            minted.nextCursor!,
          )}`,
        )
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        res.dishes.map((d) => d.id),
        ["d-1", "d-2"],
      );
      assert.ok(res.nextCursor);
    } finally {
      await harness.close();
    }
  });

  it("limit clamp still honored under sort param (1..100)", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: fixture() }));
    try {
      const lo = (await (
        await authGet(harness, "/me/dishes?sort=alpha&limit=0")
      ).json()) as { dishes: { id: string }[] };
      // clampLimit promotes 0 to 1.
      assert.equal(lo.dishes.length, 1);

      const garbage = (await (
        await authGet(harness, "/me/dishes?sort=alpha&limit=not-a-number")
      ).json()) as { dishes: { id: string }[] };
      // NaN clamps back to the default 20 → 5 rows fit.
      assert.equal(garbage.dishes.length, 5);
    } finally {
      await harness.close();
    }
  });

  it("malformed cursor is ignored (treated as first page)", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: fixture() }));
    try {
      const res = (await (
        await authGet(
          harness,
          "/me/dishes?sort=alpha&limit=2&cursor=not-a-real-cursor",
        )
      ).json()) as { dishes: { id: string }[] };
      assert.deepEqual(
        res.dishes.map((d) => d.id),
        ["d-1", "d-2"],
      );
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-6 B-fix Block 2 — mealUseCount wire field + sort=times_cooked ──

describe("GET /me/dishes mealUseCount + sort=times_cooked", () => {
  it("emits mealUseCount on every row (0, 1, and N links)", async () => {
    const dishes: DishRow[] = [
      dishRow("d-zero", "Zero", { userId: USER_ID, mealUseCount: 0 }),
      dishRow("d-one", "One", { userId: USER_ID, mealUseCount: 1 }),
      dishRow("d-many", "Many", { userId: USER_ID, mealUseCount: 7 }),
    ];
    const harness = await spinUp(makeStubPrisma({ dishes }));
    try {
      const res = await authGet(harness, "/me/dishes?sort=alpha");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        dishes: { id: string; mealUseCount: number }[];
      };
      // alpha order: Many, One, Zero
      assert.deepEqual(
        body.dishes.map((d) => ({ id: d.id, n: d.mealUseCount })),
        [
          { id: "d-many", n: 7 },
          { id: "d-one", n: 1 },
          { id: "d-zero", n: 0 },
        ],
      );
    } finally {
      await harness.close();
    }
  });

  it("sort=times_cooked orders by link count desc; ties broken by id asc", async () => {
    // Two dishes share count=2 — id asc decides their order. d-z (count=0)
    // is the trailing zero bucket.
    const dishes: DishRow[] = [
      dishRow("d-y", "Yankee", { userId: USER_ID, mealUseCount: 2 }),
      dishRow("d-a", "Alpha", { userId: USER_ID, mealUseCount: 2 }),
      dishRow("d-top", "Top", { userId: USER_ID, mealUseCount: 5 }),
      dishRow("d-z", "Zulu", { userId: USER_ID, mealUseCount: 0 }),
    ];
    const harness = await spinUp(makeStubPrisma({ dishes }));
    try {
      const res = await authGet(harness, "/me/dishes?sort=times_cooked");
      const body = (await res.json()) as {
        dishes: { id: string; mealUseCount: number }[];
      };
      // count desc, then id asc within the count=2 tie bucket.
      assert.deepEqual(
        body.dishes.map((d) => d.id),
        ["d-top", "d-a", "d-y", "d-z"],
      );
      assert.deepEqual(
        body.dishes.map((d) => d.mealUseCount),
        [5, 2, 2, 0],
      );
    } finally {
      await harness.close();
    }
  });

  it("paginates 3 pages under sort=times_cooked with no skips or dupes — tie bucket spans a page boundary", async () => {
    // counts: d-top=5; tie bucket on count=3 = {d-c1, d-c2, d-c3}; d-low=1.
    // Page boundary at limit=2 lands inside the count=3 tie bucket.
    const dishes: DishRow[] = [
      dishRow("d-c2", "Charlie 2", { userId: USER_ID, mealUseCount: 3 }),
      dishRow("d-top", "Top", { userId: USER_ID, mealUseCount: 5 }),
      dishRow("d-c1", "Charlie 1", { userId: USER_ID, mealUseCount: 3 }),
      dishRow("d-low", "Low", { userId: USER_ID, mealUseCount: 1 }),
      dishRow("d-c3", "Charlie 3", { userId: USER_ID, mealUseCount: 3 }),
    ];
    const harness = await spinUp(makeStubPrisma({ dishes }));
    try {
      const p1 = (await (
        await authGet(harness, "/me/dishes?sort=times_cooked&limit=2")
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      // count desc + id asc: [d-top(5), d-c1(3), d-c2(3), d-c3(3), d-low(1)]
      assert.deepEqual(
        p1.dishes.map((d) => d.id),
        ["d-top", "d-c1"],
      );
      assert.ok(p1.nextCursor, "page 1 should yield a cursor");

      const p2 = (await (
        await authGet(
          harness,
          `/me/dishes?sort=times_cooked&limit=2&cursor=${encodeURIComponent(
            p1.nextCursor!,
          )}`,
        )
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      // Page 2 splits the count=3 tie bucket — must continue cleanly.
      assert.deepEqual(
        p2.dishes.map((d) => d.id),
        ["d-c2", "d-c3"],
      );
      assert.ok(p2.nextCursor);

      const p3 = (await (
        await authGet(
          harness,
          `/me/dishes?sort=times_cooked&limit=2&cursor=${encodeURIComponent(
            p2.nextCursor!,
          )}`,
        )
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p3.dishes.map((d) => d.id),
        ["d-low"],
      );
      assert.equal(p3.nextCursor, null);

      const merged = [...p1.dishes, ...p2.dishes, ...p3.dishes].map((d) => d.id);
      assert.deepEqual(merged, ["d-top", "d-c1", "d-c2", "d-c3", "d-low"]);
      assert.equal(new Set(merged).size, merged.length);
    } finally {
      await harness.close();
    }
  });

  it("cursor minted under sort=times_cooked is dropped when presented under sort=alpha (first page)", async () => {
    const dishes: DishRow[] = [
      dishRow("d-a", "Alpha", { userId: USER_ID, mealUseCount: 0 }),
      dishRow("d-b", "Bravo", { userId: USER_ID, mealUseCount: 3 }),
      dishRow("d-c", "Charlie", { userId: USER_ID, mealUseCount: 1 }),
    ];
    const harness = await spinUp(makeStubPrisma({ dishes }));
    try {
      const minted = (await (
        await authGet(harness, "/me/dishes?sort=times_cooked&limit=1")
      ).json()) as { dishes: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        minted.dishes.map((d) => d.id),
        ["d-b"],
      );
      assert.ok(minted.nextCursor);

      const res = (await (
        await authGet(
          harness,
          `/me/dishes?sort=alpha&limit=2&cursor=${encodeURIComponent(
            minted.nextCursor!,
          )}`,
        )
      ).json()) as { dishes: { id: string }[] };
      // Cross-sort cursor is ignored — alpha page 1 returns first two by title.
      assert.deepEqual(
        res.dishes.map((d) => d.id),
        ["d-a", "d-b"],
      );
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-6 B-fix Block 3 — mealUseCount counts LIVE meals only ─────────
// Hans's June 9 ruling: links to archived meals keep their MealDishLink rows
// but must NOT count toward the "Used in N meals" label or times_cooked.

describe("GET /me/dishes mealUseCount excludes archived-meal links", () => {
  it("wire mealUseCount counts live-meal links only, not archived ones", async () => {
    const dishes: DishRow[] = [
      // 2 live links + 5 archived → wire should show 2.
      dishRow("d-mixed", "Mixed", {
        userId: USER_ID,
        mealUseCount: 2,
        archivedLinkCount: 5,
      }),
      // 0 live + 3 archived → wire should show 0.
      dishRow("d-archived-only", "ArchivedOnly", {
        userId: USER_ID,
        mealUseCount: 0,
        archivedLinkCount: 3,
      }),
      // 4 live + 0 archived → wire should show 4.
      dishRow("d-live-only", "LiveOnly", {
        userId: USER_ID,
        mealUseCount: 4,
        archivedLinkCount: 0,
      }),
    ];
    const harness = await spinUp(makeStubPrisma({ dishes }));
    try {
      const res = await authGet(harness, "/me/dishes?sort=alpha");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        dishes: { id: string; mealUseCount: number }[];
      };
      const byId = new Map(body.dishes.map((d) => [d.id, d.mealUseCount]));
      assert.equal(byId.get("d-mixed"), 2, "mixed: 2 live (5 archived ignored)");
      assert.equal(byId.get("d-archived-only"), 0, "archived-only: 0 live");
      assert.equal(byId.get("d-live-only"), 4, "live-only: 4 live");
    } finally {
      await harness.close();
    }
  });

  it("sort=times_cooked ranks by the FILTERED count — archived links can't outrank live ones", async () => {
    // d-archived-heavy has 11 total links but only 1 live; d-live-heavy has
    // 3 live and 0 archived. Filtered ranking must put d-live-heavy first.
    const dishes: DishRow[] = [
      dishRow("d-archived-heavy", "ArchivedHeavy", {
        userId: USER_ID,
        mealUseCount: 1,
        archivedLinkCount: 10,
      }),
      dishRow("d-live-heavy", "LiveHeavy", {
        userId: USER_ID,
        mealUseCount: 3,
        archivedLinkCount: 0,
      }),
      dishRow("d-none", "None", {
        userId: USER_ID,
        mealUseCount: 0,
        archivedLinkCount: 4,
      }),
    ];
    const harness = await spinUp(makeStubPrisma({ dishes }));
    try {
      const res = await authGet(harness, "/me/dishes?sort=times_cooked");
      const body = (await res.json()) as {
        dishes: { id: string; mealUseCount: number }[];
      };
      // Filtered counts: live-heavy=3, archived-heavy=1, none=0.
      // If ranking used TOTAL links (11, 3, 4) the order would be wrong.
      assert.deepEqual(
        body.dishes.map((d) => d.id),
        ["d-live-heavy", "d-archived-heavy", "d-none"],
      );
      assert.deepEqual(
        body.dishes.map((d) => d.mealUseCount),
        [3, 1, 0],
      );
    } finally {
      await harness.close();
    }
  });
});
