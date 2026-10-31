// SERVER-13 B (BUG-467) — GET /plans reaches every plan: keyset paging in the
// database on (createdAt, id), newest first, and `?q=` searched server side.
//
// Hans's account has 157 plans; the route read each filter `take: 100`, so plans
// 101–157 could never be listed. The stub evaluates every where clause strictly
// (fixtures/mealWhere — an unmodelled operator throws) and honours orderBy and
// take, so a page that leaks, repeats or skips a row is a red test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { likeLiteral, planSearchTerm } from "../../lib/planQueries";
import { createPlansRouter } from "../plans";
import { matchesWhere } from "./fixtures/mealWhere";
import { withSessionUser } from "./fixtures/sessionUserStub";

/* eslint-disable @typescript-eslint/no-explicit-any */

const U = "user-157";

function plan(n: number, opts: { userId?: string; createdAt?: Date; title?: string | null; template?: string; meals?: string[]; isArchived?: boolean; isWizardDraft?: boolean } = {}) {
  const meals = opts.meals ?? [`Meal ${n}`];
  return {
    id: `p-${String(n).padStart(3, "0")}`,
    userId: opts.userId ?? U,
    titleOverride: opts.title === undefined ? `Plan ${n}` : opts.title,
    status: "draft",
    startDate: null as Date | null,
    endDate: null as Date | null,
    activatedAt: null as Date | null,
    revisionId: 1,
    isArchived: opts.isArchived ?? false,
    isWizardDraft: opts.isWizardDraft ?? false,
    // Three plans to a timestamp: the id breaks the tie.
    createdAt: opts.createdAt ?? new Date(Date.UTC(2026, 0, 1) + Math.floor(n / 3) * 3_600_000),
    template: { title: opts.template ?? "Weeknight Template", description: null, imageUrl: null, tags: [] as string[] },
    items: meals.map((title) => ({ meal: { title } })),
    _count: { items: meals.length },
  };
}

function template(id: string, title: string, meals: string[] = []) {
  return {
    id, title, description: null, imageUrl: null, tags: [] as string[],
    isPublic: true, isArchived: false, isFeatured: true, isHostingFeatured: false,
    featuredStartDate: null, featuredEndDate: null, railPosition: null, createdAt: new Date("2026-01-01"),
    topRatedScore: null, useCount: 0,
    items: meals.map((t) => ({ meal: { title: t } })),
  };
}

function sortBy(rows: any[], orderBy: any) {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).filter((o: any) => typeof Object.values(o)[0] === "string");
  return [...rows].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0] as [string, string];
      const x = a[k] instanceof Date ? a[k].getTime() : a[k];
      const y = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (x !== y) return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    return 0;
  });
}

function stub(plans: ReturnType<typeof plan>[], templates: ReturnType<typeof template>[] = []) {
  const reads: { where: any; take?: number }[] = [];
  return {
    reads,
    db: {
      mealPlanInstance: {
        findMany: async ({ where, orderBy, take }: any) => {
          reads.push({ where, take });
          const rows = sortBy(plans.filter((p) => matchesWhere(p, where)), orderBy);
          return take === undefined ? rows : rows.slice(0, take);
        },
        findFirst: async ({ where }: any) => plans.find((p) => matchesWhere(p, where)) ?? null,
        findUnique: async ({ where }: any) => plans.find((p) => p.id === where.id) ?? null,
      },
      mealPlanTemplate: {
        findMany: async ({ where, take }: any) => templates.filter((t) => matchesWhere(t, where)).slice(0, take),
      },
      systemSetting: { findMany: async () => [] },
      $executeRaw: async () => 0,
    },
  };
}

async function serve(db: unknown) {
  const app = express();
  app.use(express.json());
  app.use(createPlansRouter({ prisma: withSessionUser(db) as never, computePlanMacros: (async () => ({})) as never, loadPrepStepSet: (async () => []) as never }));
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (qs: string) => {
    const res = await fetch(`${base}/plans${qs}`, { headers: { Authorization: `Bearer ${signToken(U)}` } });
    return { status: res.status, body: (await res.json()) as any };
  };
  /** Every page, following nextCursor; the ids in order and the page sizes. */
  const all = async (qs: string) => {
    const ids: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const { body } = await get(`${qs}${cursor ? `${qs ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : ""}`);
      ids.push(...body.items.map((p: any) => p.id));
      sizes.push(body.items.length);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return { ids, sizes };
  };
  return { get, all, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const HANS = () => [
  ...Array.from({ length: 157 }, (_, i) => plan(i + 1)),
  plan(900, { userId: "someone-else" }),
  plan(901, { isArchived: true }),
  plan(902, { isWizardDraft: true }),
];
const expected = (rows: ReturnType<typeof plan>[]) => sortBy(rows, [{ createdAt: "desc" }, { id: "desc" }]).map((p) => p.id);

describe("SERVER-13 B — every plan, paged in the database", () => {
  it("pages of 20 reach plan 157: newest first, (createdAt, id) order through ties, none twice, none skipped", async () => {
    const plans = HANS();
    const { db, reads } = stub(plans);
    const h = await serve(db);
    try {
      const { ids, sizes } = await h.all("?limit=20");
      assert.equal(ids.length, 157);
      assert.equal(new Set(ids).size, 157);
      assert.deepEqual(ids, expected(plans.filter((p) => p.userId === U && !p.isArchived && !p.isWizardDraft)));
      assert.deepEqual(sizes, [20, 20, 20, 20, 20, 20, 20, 17]);
      // Each page reads one more row than it shows, never a capped union.
      const pageReads = reads.filter((r) => r.take !== undefined);
      assert.ok(pageReads.every((r) => r.take === 21), JSON.stringify(pageReads.map((r) => r.take)));
    } finally {
      await h.close();
    }
  });

  it("the first page without a cursor keeps today's shape (plans, activeThisWeek, nextCursor), and `items` is the same page", async () => {
    const h = await serve(stub(HANS()).db);
    try {
      const { status, body } = await h.get("");
      assert.equal(status, 200);
      assert.deepEqual(Object.keys(body).sort(), ["activeThisWeek", "items", "nextCursor", "plans"]);
      assert.deepEqual(body.items, body.plans);
      assert.equal(body.plans.length, 20, "the default page is 20");
      assert.equal(typeof body.nextCursor, "string");
    } finally {
      await h.close();
    }
  });

  it("a legacy id cursor (the row id paginateById returned) reads as the same position", async () => {
    const plans = HANS();
    const h = await serve(stub(plans).db);
    try {
      const first = await h.get("?limit=20");
      const lastId = first.body.items[19].id;
      const viaNew = await h.get(`?limit=20&cursor=${encodeURIComponent(first.body.nextCursor)}`);
      const viaOld = await h.get(`?limit=20&cursor=${lastId}`);
      assert.deepEqual(viaOld.body.items.map((p: any) => p.id), viaNew.body.items.map((p: any) => p.id));
      assert.equal(viaOld.body.items[0].id, expected(plans.filter((p) => p.userId === U && !p.isArchived && !p.isWizardDraft))[20]);
      const unknown = await h.get("?limit=20&cursor=not-a-plan");
      assert.deepEqual(unknown.body.items, [], "an unknown cursor is an empty page, as before");
      assert.equal(unknown.body.nextCursor, null);
    } finally {
      await h.close();
    }
  });
});

describe("SERVER-13 B — ?q= searched server side", () => {
  const SEARCH = () => [
    ...HANS(),
    plan(201, { title: "THX test · Classic", createdAt: new Date("2025-06-01") }),
    plan(202, { title: null, template: "Thanksgiving Classic", createdAt: new Date("2025-06-02") }),
    plan(203, { title: "Week of tacos", meals: ["Classic Beef Lo Mein", "Fish Tacos"], createdAt: new Date("2025-06-03") }),
    plan(204, { title: "classic? no", userId: "someone-else" }),
  ];

  it("over the plan's title, its template's title and its meals' titles, case-insensitive, the user's own only", async () => {
    const h = await serve(stub(SEARCH()).db);
    try {
      const r = await h.get("?q=%20%20CLASSIC%20");
      assert.deepEqual(r.body.items.map((p: any) => p.id), ["p-203", "p-202", "p-201"]);
      assert.equal(r.body.nextCursor, null);
      assert.deepEqual((await h.get("?q=lo%20mein")).body.items.map((p: any) => p.id), ["p-203"]);
      assert.deepEqual((await h.get("?q=nothing-matches")).body.items, []);
    } finally {
      await h.close();
    }
  });

  it("a search pages like the list: 'Meal 1' matches 1, 10–19, 100–157 (69 plans), all reached", async () => {
    const plans = SEARCH();
    const h = await serve(stub(plans).db);
    try {
      const { ids } = await h.all("?limit=10&q=meal%201");
      const want = expected(plans.filter((p) => p.userId === U && !p.isArchived && !p.isWizardDraft && p.items.some((m) => m.meal.title.toLowerCase().includes("meal 1"))));
      assert.equal(want.length, 69);
      assert.deepEqual(ids, want);
    } finally {
      await h.close();
    }
  });
});

describe("SERVER-13 B — the template facets follow the user's plans", () => {
  it("my_plans,featured: the plans first, then the templates, each once, across pages", async () => {
    const plans = Array.from({ length: 23 }, (_, i) => plan(i + 1));
    const templates = Array.from({ length: 12 }, (_, i) => template(`t-${i + 1}`, `Featured ${i + 1}`));
    const h = await serve(stub(plans, templates).db);
    try {
      const { ids, sizes } = await h.all("?filter=my_plans,featured&limit=10");
      assert.deepEqual(ids, [...expected(plans), ...templates.map((t) => t.id)]);
      assert.deepEqual(sizes, [10, 10, 10, 5]);
      const onlyFacet = await h.all("?filter=featured&limit=5");
      assert.deepEqual(onlyFacet.ids, templates.map((t) => t.id));
    } finally {
      await h.close();
    }
  });

  it("the plans end exactly at a page: the next page starts the templates", async () => {
    const plans = Array.from({ length: 20 }, (_, i) => plan(i + 1));
    const templates = [template("t-1", "Featured 1"), template("t-2", "Featured 2")];
    const h = await serve(stub(plans, templates).db);
    try {
      const { ids, sizes } = await h.all("?filter=my_plans,featured&limit=10");
      assert.deepEqual(sizes, [10, 10, 2]);
      assert.deepEqual(ids.slice(-2), ["t-1", "t-2"]);
    } finally {
      await h.close();
    }
  });

  it("a facet is searched too (title or a meal's title), its date window kept", async () => {
    const templates = [template("t-a", "Holiday Feast", ["Roast Turkey"]), template("t-b", "Taco Night"), { ...template("t-c", "Turkey Burgers"), featuredEndDate: new Date("2020-01-01") }];
    const h = await serve(stub([], templates as any).db);
    try {
      assert.deepEqual((await h.get("?filter=featured&q=turkey")).body.items.map((p: any) => p.id), ["t-a"]);
    } finally {
      await h.close();
    }
  });
});

describe("SERVER-13 B — the search words", () => {
  it("are trimmed, collapsed and cut at 100; blank is no search", () => {
    assert.equal(planSearchTerm("  THX   test "), "THX test");
    assert.equal(planSearchTerm("   "), null);
    assert.equal(planSearchTerm(undefined), null);
    assert.equal(planSearchTerm(["a"]), null);
    assert.equal(planSearchTerm("x".repeat(150))?.length, 100);
  });

  it("reach the database as a LIKE literal: % _ and the escape itself are escaped", () => {
    assert.equal(likeLiteral("100% beef_stew"), String.raw`100\% beef\_stew`);
    assert.equal(likeLiteral(String.raw`a\b`), String.raw`a\\b`);
    assert.equal(likeLiteral("Lo Mein"), "Lo Mein");
  });
});
