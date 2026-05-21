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
}

function mealRow(id: string, title: string, opts: MealOpts = {}) {
  return {
    id,
    title,
    cuisineType: "Testian",
    estimatedTimeMinutes: 30,
    servingsDefault: 4,
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
    tags: ["weeknight"],
    imageUrl: null,
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
  opts: { userId?: string | null; isArchived?: boolean } = {},
) {
  return {
    id,
    title,
    estimatedTimeMinutes: 25,
    servingsDefault: 4,
    difficulty: "easy",
    caloriesPerServing: 300,
    proteinGPerServing: 15,
    carbsGPerServing: 25,
    fatGPerServing: 10,
    tags: ["side"],
    imageUrl: null,
    userId: opts.userId ?? null,
    isArchived: opts.isArchived ?? false,
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
        orderBy?: { title?: "asc" | "desc" };
      }) => {
        let rows = meals.slice();
        const w = args.where;
        if (w.userId !== undefined) rows = rows.filter((m) => m.userId === w.userId);
        if (w.isPublic !== undefined) rows = rows.filter((m) => m.isPublic === w.isPublic);
        if (w.isArchived !== undefined)
          rows = rows.filter((m) => m.isArchived === w.isArchived);
        if (args.orderBy?.title === "asc")
          rows = rows.sort((a, b) => a.title.localeCompare(b.title));
        return rows;
      },
    },
    dish: {
      findMany: async (args: {
        where: { userId?: string; isArchived?: boolean };
        orderBy?: { title?: "asc" | "desc" };
      }) => {
        let rows = dishes.slice();
        const w = args.where;
        if (w.userId !== undefined) rows = rows.filter((d) => d.userId === w.userId);
        if (w.isArchived !== undefined)
          rows = rows.filter((d) => d.isArchived === w.isArchived);
        if (args.orderBy?.title === "asc")
          rows = rows.sort((a, b) => a.title.localeCompare(b.title));
        return rows;
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
      assert.equal(p1.nextCursor, "m-1");

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
      assert.equal(p2.nextCursor, "m-3");

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
