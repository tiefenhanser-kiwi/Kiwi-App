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
import { isSeasonActive, seasonClock, SEASONS, seasonWindow, zonedMidnight } from "../../lib/cookbook/seasons";
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
  /** BOOK-1C1 — Favorite rows (the heart). */
  favorites?: Array<{ userId: string; mealId: string }>;
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
    favorite: {
      findMany: async (args: { where: Record<string, unknown> }) =>
        (opts.favorites ?? [])
          .map((f) => ({ ...f, meal: asPrisma(meals.get(f.mealId)!) }))
          .filter((f) => matchesWhere(f, args.where))
          .map((f) => ({ mealId: f.mealId, meal: { sourceStoreMealId: f.meal.sourceStoreMealId } })),
    },
  };
  return { prisma, meals, lightReads };
}

interface Harness {
  get: (query: string, token?: string | null) => Promise<{ status: number; body: any }>;
  /** Any /api/cookbook path (BOOK-1C1: /seasons). */
  path: (path: string, token?: string | null) => Promise<{ status: number; body: any }>;
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
  const root = `http://127.0.0.1:${addr.port}/api/cookbook`;
  const fetchJson = async (url: string, token: string | null) => {
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };
  return {
    get: async (query, token = signToken(USER)) => fetchJson(`${root}/meals${query}`, token),
    path: async (path, token = signToken(USER)) => fetchJson(`${root}${path}`, token),
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

describe("GET /cookbook/meals — the card, isSaved and isInPlaylist", () => {
  it("isInPlaylist is true when the user's Playlist holds a copy of the meal (by sourceStoreMealId)", async () => {
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
        const inPlaylist = Object.fromEntries(r.body.meals.map((m: any) => [m.id, m.isInPlaylist]));
        assert.deepEqual(inPlaylist, { "cat-a": true, "cat-b": false });
        // A Playlist row is not a heart.
        const saved = Object.fromEntries(r.body.meals.map((m: any) => [m.id, m.isSaved]));
        assert.deepEqual(saved, { "cat-a": false, "cat-b": false });
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
          "isInPlaylist",
        ]) {
          assert.ok(k in card, `card has ${k}`);
        }
      },
    );
  });

  it("isSaved is a heart on the meal or on the user's OWN live copy — never another user's, never an archived copy", async () => {
    const rows = [
      row("hearted"),
      row("via-copy"),
      row("via-their-copy"),
      row("via-archived-copy"),
      row("plain"),
      row("my-copy", { userId: USER, isPublic: false, sourceStoreMealId: "via-copy" }),
      // Another user's PUBLIC fork: a heart on it is not this user's copy.
      row("their-fork", { userId: "someone", isPublic: true, sourceStoreMealId: "via-their-copy", mealType: "lunch" }),
      row("my-dead-copy", { userId: USER, isPublic: false, isArchived: true, sourceStoreMealId: "via-archived-copy" }),
    ];
    await withHarness(
      {
        rows,
        favorites: [
          { userId: USER, mealId: "hearted" },
          { userId: USER, mealId: "my-copy" },
          { userId: USER, mealId: "their-fork" },
          { userId: USER, mealId: "my-dead-copy" },
          { userId: "someone", mealId: "plain" },
        ],
      },
      async (h) => {
        const r = await h.get("?sort=az");
        const saved = Object.fromEntries(r.body.meals.map((m: any) => [m.id, m.isSaved]));
        assert.deepEqual(saved, {
          hearted: true,
          "via-copy": true,
          "via-their-copy": false,
          "via-archived-copy": false,
          plain: false,
        });
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

// ── BOOK-1C1: the filter sheet ───────────────────────────────────────────

describe("GET /cookbook/meals — difficulty (hard is stored fancy)", () => {
  const rows = [
    row("e", { difficulty: "easy" }),
    row("m", { difficulty: "medium" }),
    row("f", { difficulty: "fancy" }),
  ];

  it("filters by any requested difficulty; hard reads the stored fancy", async () => {
    await withHarness({ rows }, async (h) => {
      assert.deepEqual(ids((await h.get("?difficulty=easy")).body), ["e"]);
      assert.deepEqual(ids((await h.get("?difficulty=hard")).body), ["f"]);
      assert.deepEqual(ids((await h.get("?difficulty=easy,hard&sort=az")).body).sort(), ["e", "f"]);
      assert.deepEqual(ids((await h.get("?difficulty=Medium&difficulty=easy")).body).sort(), ["e", "m"]);
    });
  });

  it("the stored spelling is not on the wire; an unknown difficulty is a 400", async () => {
    await withHarness({ rows }, async (h) => {
      assert.equal((await h.get("?difficulty=fancy")).status, 400);
      assert.equal((await h.get("?difficulty=expert")).status, 400);
    });
  });

  it("the difficulty facet counts under every filter but its own", async () => {
    await withHarness({ rows }, async (h) => {
      const r = await h.get("?difficulty=easy");
      assert.deepEqual(r.body.facets.difficulty, { easy: 1, medium: 1, hard: 1 });
    });
  });
});

describe("GET /cookbook/meals — maxActiveMinutes, highProtein, maxCalories", () => {
  const rows = [
    row("a15", { activeTimeMinutes: 15, proteinGPerServing: 40, caloriesPerServing: 599 }),
    row("a20", { activeTimeMinutes: 20, proteinGPerServing: 39.5, caloriesPerServing: 600 }),
    row("a30", { activeTimeMinutes: 30, proteinGPerServing: 55, caloriesPerServing: 450 }),
    row("a45", { activeTimeMinutes: 45, proteinGPerServing: 12, caloriesPerServing: 800 }),
    // An authored-only time: no derived hands-on figure at all.
    row("underived", { activeTimeMinutes: null, proteinGPerServing: 60, caloriesPerServing: 300 }),
  ];

  it("a hands-on cap admits derived hands-on times at or under it; an underived meal never passes", async () => {
    await withHarness({ rows }, async (h) => {
      assert.deepEqual(ids((await h.get("?maxActiveMinutes=15")).body), ["a15"]);
      assert.deepEqual(ids((await h.get("?maxActiveMinutes=20&sort=az")).body).sort(), ["a15", "a20"]);
      assert.deepEqual(ids((await h.get("?maxActiveMinutes=30&sort=az")).body).sort(), ["a15", "a20", "a30"]);
    });
  });

  it("highProtein is 40 g a serving or more", async () => {
    await withHarness({ rows }, async (h) => {
      assert.deepEqual(ids((await h.get("?highProtein=true&sort=az")).body).sort(), ["a15", "a30", "underived"]);
      assert.equal((await h.get("?highProtein=false")).body.total, 5);
    });
  });

  it("maxCalories=600 is strictly under 600 (the sheet says Under 600 kcal)", async () => {
    await withHarness({ rows }, async (h) => {
      assert.deepEqual(ids((await h.get("?maxCalories=600&sort=az")).body).sort(), ["a15", "a30", "underived"]);
    });
  });

  it("the filters combine, and each facet drops only its own filter", async () => {
    await withHarness({ rows }, async (h) => {
      const r = await h.get("?maxActiveMinutes=30&highProtein=1&maxCalories=600");
      assert.deepEqual(ids(r.body).sort(), ["a15", "a30"]);
      const f = r.body.facets;
      // activeMinutes: under protein + calories (a15, a30, underived); underived counts under no cap.
      assert.deepEqual(f.activeMinutes, { "15": 1, "20": 1, "30": 2 });
      // highProtein: under the cap + calories (a15, a30), both high.
      assert.equal(f.highProtein, 2);
      // under600: under the cap + protein (a15, a30), both under.
      assert.equal(f.under600, 2);
    });
  });

  for (const [label, qs] of [
    ["hands-on cap off the list", "?maxActiveMinutes=25"],
    ["calorie cap off the list", "?maxCalories=500"],
    ["a protein flag that is not a flag", "?highProtein=yes"],
  ] as const) {
    it(`a bad value is a 400: ${label}`, async () => {
      await withHarness({ rows }, async (h) => {
        assert.equal((await h.get(qs)).status, 400);
      });
    });
  }
});

// ── BOOK-1C1: the seasons ────────────────────────────────────────────────

describe("seasons — the window (America/New_York, Nov 2 through Nov 30)", () => {
  const thanksgiving = SEASONS.find((s) => s.tag === "thanksgiving")!;

  it("opens at New York midnight on Nov 2 and closes at New York midnight after Nov 30", () => {
    const w = seasonWindow(thanksgiving, new Date("2026-11-15T12:00:00Z"));
    // EST (UTC-5) on both ends: DST ended Nov 1, 2026.
    assert.equal(w.startsAt.toISOString(), "2026-11-02T05:00:00.000Z");
    assert.equal(w.endsAt.toISOString(), "2026-12-01T05:00:00.000Z");
    assert.equal(w.endsOn, "2026-11-30");
  });

  it("is active from the first instant to the last, and not a millisecond outside", () => {
    assert.equal(isSeasonActive(thanksgiving, new Date("2026-11-02T04:59:59.999Z")), false);
    assert.equal(isSeasonActive(thanksgiving, new Date("2026-11-02T05:00:00.000Z")), true);
    assert.equal(isSeasonActive(thanksgiving, new Date("2026-12-01T04:59:59.999Z")), true);
    assert.equal(isSeasonActive(thanksgiving, new Date("2026-12-01T05:00:00.000Z")), false);
    assert.equal(isSeasonActive(thanksgiving, new Date("2026-10-14T12:00:00Z")), false);
  });

  it("recurs: next year resolves against next year (EDT until Nov 7, 2027)", () => {
    const w = seasonWindow(thanksgiving, new Date("2027-11-20T12:00:00Z"));
    assert.equal(w.startsAt.toISOString(), "2027-11-02T04:00:00.000Z");
    assert.equal(w.endsAt.toISOString(), "2027-12-01T05:00:00.000Z");
  });

  it("zonedMidnight handles a DST-day midnight", () => {
    assert.equal(zonedMidnight(2026, 3, 8, "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z");
    assert.equal(zonedMidnight(2026, 3, 9, "America/New_York").toISOString(), "2026-03-09T04:00:00.000Z");
  });

  it("the preview clock moves the evaluation instant, except in production", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    const preview = "2026-11-20T15:00:00Z";
    assert.equal(seasonClock({ COOKBOOK_SEASON_PREVIEW_AT: preview } as any, now).toISOString(), "2026-11-20T15:00:00.000Z");
    assert.equal(seasonClock({ COOKBOOK_SEASON_PREVIEW_AT: preview, NODE_ENV: "production" } as any, now), now);
    assert.equal(seasonClock({ COOKBOOK_SEASON_PREVIEW_AT: "soon" } as any, now), now);
    assert.equal(seasonClock({} as any, now), now);
  });
});

describe("GET /cookbook/seasons", () => {
  const rows = [
    row("feast", { tags: ["american", "thanksgiving"] }),
    row("turkey", { tags: ["thanksgiving", "thanksgiving-alternate", "course-turkey"] }),
    row("pie", { tags: ["Thanksgiving", "thanksgiving-alternate", "course-dessert"], allergens: ["dairy"] }),
    row("tacos", { tags: ["mexican"] }),
    row("private-pilot", { tags: ["thanksgiving"], isPublic: false }),
  ];

  async function atInstant<T>(iso: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.COOKBOOK_SEASON_PREVIEW_AT;
    if (iso === undefined) delete process.env.COOKBOOK_SEASON_PREVIEW_AT;
    else process.env.COOKBOOK_SEASON_PREVIEW_AT = iso;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.COOKBOOK_SEASON_PREVIEW_AT;
      else process.env.COOKBOOK_SEASON_PREVIEW_AT = prev;
    }
  }

  it("in the window: Thanksgiving with this user's count and per-course counts, allergens applied", async () => {
    await withHarness({ rows, allergies: ["Dairy-free"] }, async (h) => {
      const r = await atInstant("2026-11-20T15:00:00Z", () => h.path("/seasons"));
      assert.equal(r.status, 200);
      assert.equal(r.body.asOf, "2026-11-20T15:00:00.000Z");
      assert.equal(r.body.seasons.length, 1);
      const s = r.body.seasons[0];
      assert.equal(s.tag, "thanksgiving");
      assert.equal(s.label, "Thanksgiving");
      assert.equal(s.headline, "Thanksgiving feasts & dishes");
      assert.equal(s.blurb, "turkeys, sides, pies");
      assert.match(s.featuredNote, /Thanksgiving-week plans are under Featured/);
      assert.equal(s.startsAt, "2026-11-02T05:00:00.000Z");
      assert.equal(s.endsAt, "2026-12-01T05:00:00.000Z");
      assert.equal(s.endsOn, "2026-11-30");
      // The dairy pie is filtered out; the private pilot row never counts.
      assert.equal(s.count, 2);
      const courses = Object.fromEntries(s.courses.map((c: any) => [c.label, c.count]));
      assert.deepEqual(courses, {
        Feasts: 0,
        Turkey: 1,
        Stuffing: 0,
        Potatoes: 0,
        Cranberry: 0,
        Sides: 0,
        Desserts: 0,
        Leftovers: 0,
      });
    });
  });

  it("outside the window: no seasons at all", async () => {
    await withHarness({ rows }, async (h) => {
      const r = await atInstant("2026-10-14T12:00:00Z", () => h.path("/seasons"));
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.seasons, []);
    });
  });

  it("members only: no token or a guest token is a 401", async () => {
    await withHarness({ rows }, async (h) => {
      assert.equal((await h.path("/seasons", signToken("guest-1", { purpose: "guest" }))).status, 401);
      assert.equal((await h.path("/seasons", null)).status, 401);
    });
  });

  it("BOOK-1C2: a cranberry alternate counts under its own Cranberry chip, after Potatoes", async () => {
    const withCranberry = [
      ...rows,
      row("cranberry", { tags: ["thanksgiving", "thanksgiving-alternate", "course-cranberry"] }),
    ];
    await withHarness({ rows: withCranberry }, async (h) => {
      const r = await atInstant("2026-11-20T15:00:00Z", () => h.path("/seasons"));
      assert.equal(r.status, 200);
      const labels = r.body.seasons[0].courses.map((c: any) => c.label);
      assert.deepEqual(labels.slice(labels.indexOf("Potatoes"), labels.indexOf("Potatoes") + 2), ["Potatoes", "Cranberry"]);
      const cranberry = r.body.seasons[0].courses.find((c: any) => c.label === "Cranberry");
      assert.deepEqual(cranberry, { label: "Cranberry", tag: "course-cranberry", count: 1 });
    });
  });
});
