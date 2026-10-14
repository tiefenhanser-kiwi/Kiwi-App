// BOOK-1S (D-WS9-312) — GET /api/cookbook/meals.
//
// The stub evaluates every `where` the route builds with the strict evaluator
// (fixtures/mealWhere.ts): the allergen filter, the time cap and the text
// match are database-side, so a stub that ignored the `where` would pass a
// route that filtered nothing. The evaluator throws on any clause it does not
// model, so a new clause cannot slip through as "no constraint" either.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { CUISINE_TOKENS } from "../../lib/cookbook/query";
import { normalizeCuisineTokens } from "../../lib/store/cuisineNormalize";
import { createCookbookRouter } from "../cookbook";
import { matchesWhere } from "./fixtures/mealWhere";
import { withSessionUser } from "./fixtures/sessionUserStub";

/* eslint-disable @typescript-eslint/no-explicit-any */

const USER = "cook-user";
const STAMPED = new Date("2026-09-04T00:00:00Z");

interface Row {
  id: string;
  userId: string | null;
  title: string;
  displayTitle: string | null;
  description: string | null;
  imageUrl: string | null;
  cuisineType: string | null;
  difficulty: string;
  mealType: string;
  estimatedTimeMinutes: number;
  activeTimeMinutes: number | null;
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  tags: string[];
  dishFamilyKey: string | null;
  allergens: string[];
  allergensStampedAt: Date | null;
  sourceStoreMealId: string | null;
  isPublic: boolean;
  isArchived: boolean;
  ingredients: string[];
}

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    userId: null,
    title: `Meal ${id}`,
    displayTitle: null,
    description: null,
    imageUrl: null,
    cuisineType: "Italian",
    difficulty: "medium",
    mealType: "dinner",
    estimatedTimeMinutes: 40,
    activeTimeMinutes: 25,
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
    tags: [],
    dishFamilyKey: null,
    allergens: [],
    allergensStampedAt: STAMPED,
    sourceStoreMealId: null,
    isPublic: true,
    isArchived: false,
    ingredients: ["olive oil"],
    ...over,
  };
}

/** Prisma's view of a row: the dish → ingredient join and the card count. */
function asPrisma(r: Row): Record<string, any> {
  return {
    ...r,
    dishLinks: [
      {
        dish: {
          dishIngredients: r.ingredients.map((name) => ({
            ingredient: { displayName: name, canonicalName: name.toLowerCase() },
          })),
        },
      },
    ],
    _count: { dishLinks: 1 },
  };
}

function project(obj: Record<string, any>, select: Record<string, any> | undefined) {
  if (!select) return obj;
  return Object.fromEntries(Object.keys(select).map((k) => [k, obj[k]]));
}

interface StubOpts {
  rows: Row[];
  allergies?: string[];
  playlist?: Array<{ userId: string; mealId: string }>;
}

function makeStub(opts: StubOpts) {
  const meals = new Map(opts.rows.map((r) => [r.id, r]));
  const lightReads: number[] = [];
  const prisma = {
    userPreferences: {
      findUnique: async () =>
        opts.allergies === undefined ? null : { allergiesAndAvoidances: opts.allergies },
    },
    meal: {
      findMany: async (args: { where: Record<string, unknown>; select?: Record<string, any> }) => {
        if (args.select && "dishFamilyKey" in args.select) lightReads.push(1);
        return [...meals.values()]
          .map(asPrisma)
          .filter((m) => matchesWhere(m, args.where))
          .map((m) => project(m, args.select));
      },
    },
    playlistMeal: {
      findMany: async (args: { where: Record<string, unknown> }) =>
        (opts.playlist ?? [])
          .map((p) => ({ ...p, meal: asPrisma(meals.get(p.mealId)!) }))
          .filter((p) => matchesWhere(p, args.where))
          .map((p) => ({ mealId: p.mealId, meal: { sourceStoreMealId: p.meal.sourceStoreMealId } })),
    },
  };
  return { prisma, meals, lightReads };
}

interface Harness {
  get: (query: string, token?: string | null) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(
    "/api",
    createCookbookRouter({
      prisma: withSessionUser(prisma) as never,
      rateLimiterOpts: { capacity: 10_000, refillPerSec: 10_000 },
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s: Server = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no bind");
  const base = `http://127.0.0.1:${addr.port}/api/cookbook/meals`;
  return {
    get: async (query, token = signToken(USER)) => {
      const res = await fetch(`${base}${query}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      return { status: res.status, body: await res.json() };
    },
    close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
  };
}

async function withHarness(opts: StubOpts, fn: (h: Harness, stub: ReturnType<typeof makeStub>) => Promise<void>) {
  const stub = makeStub(opts);
  const h = await spinUp(stub.prisma);
  try {
    await fn(h, stub);
  } finally {
    await h.close();
  }
}

const ids = (body: any): string[] => body.meals.map((m: { id: string }) => m.id);

// ── vocabulary ───────────────────────────────────────────────────────────

describe("cookbook — the cuisine vocabulary", () => {
  it("every accepted token is one cuisineNormalize actually emits for itself", () => {
    for (const t of CUISINE_TOKENS) {
      assert.ok(normalizeCuisineTokens(t).has(t), `${t} does not normalize to itself`);
    }
  });
});

// ── access ───────────────────────────────────────────────────────────────

describe("GET /cookbook/meals — members only", () => {
  it("no token → 401; a guest token → 401", async () => {
    await withHarness({ rows: [row("a")] }, async (h) => {
      assert.equal((await h.get("", null)).status, 401);
      assert.equal((await h.get("", signToken("guest-1", { purpose: "guest" }))).status, 401);
    });
  });
});

// ── the allergen filter ──────────────────────────────────────────────────

describe("GET /cookbook/meals — the allergen hard filter", () => {
  const rows = [
    row("clean", { allergens: [], allergensStampedAt: STAMPED }),
    row("soy-only", { allergens: ["soy"], allergensStampedAt: STAMPED }),
    row("has-dairy", { allergens: ["dairy", "wheat"], allergensStampedAt: STAMPED }),
    row("never-stamped", { allergens: [], allergensStampedAt: null }),
  ];

  it("a dairy-free user never sees a dairy meal or an unstamped one", async () => {
    await withHarness({ rows, allergies: ["Dairy-free"] }, async (h) => {
      const r = await h.get("?sort=az");
      assert.equal(r.status, 200);
      assert.deepEqual(ids(r.body).sort(), ["clean", "soy-only"]);
      assert.equal(r.body.total, 2);
    });
  });

  it("…and the filter holds under a text query that names the dairy meal", async () => {
    await withHarness({ rows, allergies: ["Dairy-free"] }, async (h) => {
      const r = await h.get("?q=has-dairy");
      assert.deepEqual(ids(r.body), []);
    });
  });

  it("a user with no allergies sees every public meal, unstamped included", async () => {
    await withHarness({ rows, allergies: [] }, async (h) => {
      const r = await h.get("?sort=az");
      assert.deepEqual(ids(r.body).sort(), ["clean", "has-dairy", "never-stamped", "soy-only"]);
    });
  });

  it("private and archived meals, and non-dinners, never appear", async () => {
    await withHarness(
      {
        rows: [
          row("pub"),
          row("private", { isPublic: false, userId: USER }),
          row("archived", { isArchived: true }),
          row("lunch", { mealType: "lunch" }),
        ],
      },
      async (h) => {
        assert.deepEqual(ids((await h.get("")).body), ["pub"]);
      },
    );
  });
});

// ── the time cap ─────────────────────────────────────────────────────────

describe("GET /cookbook/meals — maxMinutes", () => {
  it("admits derived times at or under the cap only; an underived 'quick' claim is out", async () => {
    await withHarness(
      {
        rows: [
          row("derived-25", { estimatedTimeMinutes: 25, activeTimeMinutes: 15 }),
          row("derived-30", { estimatedTimeMinutes: 30, activeTimeMinutes: 20 }),
          row("claimed-20", { estimatedTimeMinutes: 20, activeTimeMinutes: null }),
          row("derived-40", { estimatedTimeMinutes: 40, activeTimeMinutes: 20 }),
        ],
      },
      async (h) => {
        const r = await h.get("?maxMinutes=30&sort=quickest");
        assert.equal(r.status, 200);
        assert.deepEqual(ids(r.body), ["derived-25", "derived-30"]);
        // Without a cap the underived meal is browsable, last under quickest.
        assert.deepEqual(ids((await h.get("?sort=quickest")).body), [
          "derived-25",
          "derived-30",
          "derived-40",
          "claimed-20",
        ]);
      },
    );
  });
});

// ── the text query ───────────────────────────────────────────────────────

describe("GET /cookbook/meals — q", () => {
  const rows = [
    row("by-title", { title: "Turkey Chili" }),
    row("by-display", { title: "Slow-cooker bird stew", displayTitle: "TURKEY Stew" }),
    row("by-ingredient", { title: "Club Sandwich", ingredients: ["sliced turkey breast"] }),
    row("unrelated", { title: "Pad Thai", ingredients: ["rice noodles"] }),
  ];

  it("matches title, display title or any ingredient name, case-insensitive and trimmed", async () => {
    await withHarness({ rows }, async (h) => {
      const r = await h.get(`?q=${encodeURIComponent("  turkey ")}&sort=az`);
      assert.equal(r.status, 200);
      assert.deepEqual(ids(r.body).sort(), ["by-display", "by-ingredient", "by-title"]);
    });
  });

  it("an empty q is no query; one character is a 400", async () => {
    await withHarness({ rows }, async (h) => {
      assert.equal((await h.get("?q=")).body.total, 4);
      assert.equal((await h.get("?q=t")).status, 400);
      assert.equal((await h.get("?q=%20t%20")).status, 400);
    });
  });
});

// ── validation ───────────────────────────────────────────────────────────

describe("GET /cookbook/meals — a bad value is a 400", () => {
  for (const [label, qs] of [
    ["unknown sort", "?sort=newest"],
    ["time cap off the list", "?maxMinutes=20"],
    ["non-numeric time cap", "?maxMinutes=soon"],
    ["raw cuisine string", "?cuisine=Italian-American"],
    ["unknown cuisine token", "?cuisine=klingon"],
    ["limit over 50", "?limit=51"],
    ["limit zero", "?limit=0"],
    ["unknown parameter", "?maxMinute=30"],
    ["malformed cursor", "?cursor=not-a-cursor"],
  ] as const) {
    it(label, async () => {
      await withHarness({ rows: [row("a")] }, async (h) => {
        assert.equal((await h.get(qs)).status, 400);
      });
    });
  }

  it("a cursor minted under one sort is refused under another", async () => {
    await withHarness({ rows: [row("a"), row("b"), row("c")] }, async (h) => {
      const first = await h.get("?sort=az&limit=1");
      assert.ok(first.body.nextCursor);
      assert.equal((await h.get(`?sort=popular&cursor=${first.body.nextCursor}`)).status, 400);
    });
  });
});

// ── cuisine, tag, facets ─────────────────────────────────────────────────

describe("GET /cookbook/meals — cuisine, tag and facets", () => {
  const rows = [
    row("it-1", { cuisineType: "Italian", tags: ["thanksgiving"] }),
    row("it-am", { cuisineType: "Italian-American", tags: [] }),
    row("thai", { cuisineType: "Thai", tags: ["Thanksgiving"] }),
    row("mex", { cuisineType: "Tex-Mex", tags: [] }),
    row("brit", { cuisineType: "British", tags: ["thanksgiving"] }),
  ];

  it("cuisine filters by canonical token (any of several), repeated or comma-separated", async () => {
    await withHarness({ rows }, async (h) => {
      assert.deepEqual(ids((await h.get("?cuisine=italian&sort=az")).body).sort(), ["it-1", "it-am"]);
      assert.deepEqual(ids((await h.get("?cuisine=american")).body), ["it-am"]);
      assert.deepEqual(ids((await h.get("?cuisine=thai,mexican")).body).sort(), ["mex", "thai"]);
      assert.deepEqual(ids((await h.get("?cuisine=thai&cuisine=mexican")).body).sort(), ["mex", "thai"]);
    });
  });

  it("tag filters case-insensitively", async () => {
    await withHarness({ rows }, async (h) => {
      assert.deepEqual(ids((await h.get("?tag=thanksgiving")).body).sort(), ["brit", "it-1", "thai"]);
    });
  });

  it("each facet counts under every filter but its own", async () => {
    await withHarness({ rows }, async (h) => {
      const r = await h.get("?cuisine=italian&tag=thanksgiving");
      assert.deepEqual(ids(r.body), ["it-1"]);
      // Cuisine facet: under the tag filter, not the cuisine one.
      const cuisines = Object.fromEntries(r.body.facets.cuisines.map((c: any) => [c.token, c.count]));
      assert.deepEqual(cuisines, { italian: 1, thai: 1, asian: 1 });
      // Thanksgiving: under the cuisine filter, not the tag one.
      assert.equal(r.body.facets.thanksgiving, 1);

      const open = await h.get("");
      assert.equal(open.body.facets.thanksgiving, 3);
      const all = Object.fromEntries(open.body.facets.cuisines.map((c: any) => [c.token, c.count]));
      assert.deepEqual(all, { italian: 2, american: 1, thai: 1, asian: 1, "tex-mex": 1, mexican: 1 });
    });
  });
});

// ── isSaved and the card ─────────────────────────────────────────────────

describe("GET /cookbook/meals — the card and isSaved", () => {
  it("isSaved is true when the user's Playlist holds a copy of the meal (by sourceStoreMealId)", async () => {
    const rows = [
      row("cat-a"),
      row("cat-b"),
      row("my-copy-of-a", { userId: USER, isPublic: false, sourceStoreMealId: "cat-a" }),
      row("their-copy-of-b", { userId: "someone", isPublic: false, sourceStoreMealId: "cat-b" }),
    ];
    await withHarness(
      {
        rows,
        playlist: [
          { userId: USER, mealId: "my-copy-of-a" },
          { userId: "someone", mealId: "their-copy-of-b" },
        ],
      },
      async (h) => {
        const r = await h.get("?sort=az");
        const saved = Object.fromEntries(r.body.meals.map((m: any) => [m.id, m.isSaved]));
        assert.deepEqual(saved, { "cat-a": true, "cat-b": false });
        const card = r.body.meals[0];
        for (const k of [
          "id",
          "title",
          "displayTitle",
          "description",
          "imageUrl",
          "cuisineType",
          "difficulty",
          "estimatedTimeMinutes",
          "activeTimeMinutes",
          "macrosPerServing",
          "tags",
          "dishCount",
          "isSaved",
        ]) {
          assert.ok(k in card, `card has ${k}`);
        }
      },
    );
  });

  it("no difficulty ceiling: easy, medium and fancy all browse", async () => {
    await withHarness(
      { rows: [row("e", { difficulty: "easy" }), row("m"), row("f", { difficulty: "fancy" })] },
      async (h) => {
        assert.equal((await h.get("")).body.total, 3);
      },
    );
  });
});

// ── sorts ────────────────────────────────────────────────────────────────

// Real spine keys (storeFillDishes.ts): three versions of rank-1 "Spaghetti
// with Meat Sauce" and one of rank-39 "Chicken Pot Pie".
const SORT_ROWS = [
  row("z-pot-pie", { title: "Pot Pie", dishFamilyKey: "chicken-pot-pie-with-biscuit-topping", estimatedTimeMinutes: 70 }),
  row("y-bolognese", { title: "Bolognese", dishFamilyKey: "classic-slow-simmered-beef-bolognese", estimatedTimeMinutes: 90 }),
  row("x-orphan", { title: "Apple Salad", displayTitle: "apple salad", dishFamilyKey: null, estimatedTimeMinutes: 15 }),
  row("w-sausage", { title: "Sausage Sauce", dishFamilyKey: "spicy-italian-sausage-meat-sauce", estimatedTimeMinutes: 45 }),
  row("v-gravy", { title: "Sunday Gravy", displayTitle: "Gravy", dishFamilyKey: "sunday-gravy-with-pork-and-beef", estimatedTimeMinutes: 45 }),
  row("u-claimed", { title: "Banana Bread", activeTimeMinutes: null, estimatedTimeMinutes: 5 }),
  row("t-quick", { title: "Toast", estimatedTimeMinutes: 10 }),
  row("s-twin", { title: "Toast", estimatedTimeMinutes: 10 }),
  row("r-slow", { title: "Cassoulet", estimatedTimeMinutes: 240 }),
];

describe("GET /cookbook/meals — sorts", () => {
  it("popular: the family rank, every version of a family together, then the non-catalog meals", async () => {
    await withHarness({ rows: SORT_ROWS }, async (h) => {
      const order = ids((await h.get("?limit=50")).body);
      assert.deepEqual(order.slice(0, 3).sort(), ["v-gravy", "w-sausage", "y-bolognese"]);
      assert.equal(order[3], "z-pot-pie");
      assert.equal(order.length, SORT_ROWS.length);
    });
  });

  it("quickest: derived total ascending, ties on id, underived last", async () => {
    await withHarness({ rows: SORT_ROWS }, async (h) => {
      assert.deepEqual(ids((await h.get("?sort=quickest&limit=50")).body), [
        "s-twin",
        "t-quick",
        "x-orphan",
        "v-gravy",
        "w-sausage",
        "z-pot-pie",
        "y-bolognese",
        "r-slow",
        "u-claimed",
      ]);
    });
  });

  it("az: by display title (falling back to title), case-insensitive, ties on id", async () => {
    await withHarness({ rows: SORT_ROWS }, async (h) => {
      assert.deepEqual(ids((await h.get("?sort=az&limit=50")).body), [
        "x-orphan",
        "u-claimed",
        "y-bolognese",
        "r-slow",
        "v-gravy",
        "z-pot-pie",
        "w-sausage",
        "s-twin",
        "t-quick",
      ]);
    });
  });
});

// ── the cursor ───────────────────────────────────────────────────────────

describe("GET /cookbook/meals — the cursor: pages never overlap or skip", () => {
  for (const sort of ["popular", "quickest", "az"] as const) {
    it(`${sort}: paging by 2 yields exactly the one-page order`, async () => {
      await withHarness({ rows: SORT_ROWS }, async (h) => {
        const whole = ids((await h.get(`?sort=${sort}&limit=50`)).body);
        const paged: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const r: { status: number; body: any } = await h.get(
            `?sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
          );
          assert.equal(r.status, 200);
          assert.equal(r.body.total, SORT_ROWS.length);
          paged.push(...ids(r.body));
          cursor = r.body.nextCursor;
          pages += 1;
        } while (cursor && pages < 20);
        assert.deepEqual(paged, whole);
        assert.equal(new Set(paged).size, paged.length, "no meal appears twice");
        assert.equal(pages, Math.ceil(SORT_ROWS.length / 2));
      });
    });

    it(`${sort}: a meal added before the cursor between page reads shifts nothing`, async () => {
      await withHarness({ rows: SORT_ROWS }, async (h, stub) => {
        const first = await h.get(`?sort=${sort}&limit=3`);
        const firstIds = ids(first.body);
        // A newcomer that sorts at the very front under every sort.
        stub.meals.set(
          "0-new",
          row("0-new", { title: "AAA", dishFamilyKey: "classic-slow-simmered-beef-bolognese", estimatedTimeMinutes: 1 }),
        );
        const second = await h.get(`?sort=${sort}&limit=3&cursor=${first.body.nextCursor}`);
        const whole = ids((await h.get(`?sort=${sort}&limit=50`)).body).filter((id) => id !== "0-new");
        assert.deepEqual([...firstIds, ...ids(second.body)], whole.slice(0, 6));
      });
    });
  }

  it("the last page has no nextCursor", async () => {
    await withHarness({ rows: SORT_ROWS }, async (h) => {
      const r = await h.get("?limit=9");
      assert.equal(r.body.meals.length, 9);
      assert.equal(r.body.nextCursor, null);
    });
  });
});
