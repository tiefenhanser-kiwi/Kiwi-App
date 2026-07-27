// Cookbook Phase A Block 1 — planningContext unit tests.
// Pure functions (season boundaries, computed-holiday overlap, empty window)
// plus the read-only Prisma loaders (union + dedupe + draft-exclusion +
// null-name coalesce), stubbing Prisma with the codebase's plain-object
// convention.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  getSeasonContext,
  getUpcomingEvents,
  buildRecentMealHistory,
  buildRecentPlanNames,
  buildRecentRotation,
} from "../planningContext";
import { TARGET_DISHES } from "../storeFillDishes";
import { lookupDishFamily } from "../store/dishFamily";

// ── helpers ────────────────────────────────────────────────────────────

const utc = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

// ── getSeasonContext ─────────────────────────────────────────────────────

describe("getSeasonContext", () => {
  it("maps month boundaries to meteorological seasons (N. hemisphere)", () => {
    assert.equal(getSeasonContext(utc("2026-02-28")).season, "winter");
    assert.equal(getSeasonContext(utc("2026-03-01")).season, "spring");
    assert.equal(getSeasonContext(utc("2026-05-31")).season, "spring");
    assert.equal(getSeasonContext(utc("2026-06-01")).season, "summer");
    assert.equal(getSeasonContext(utc("2026-08-31")).season, "summer");
    assert.equal(getSeasonContext(utc("2026-09-01")).season, "fall");
    assert.equal(getSeasonContext(utc("2026-11-30")).season, "fall");
    assert.equal(getSeasonContext(utc("2026-12-01")).season, "winter");
    assert.equal(getSeasonContext(utc("2026-01-15")).season, "winter");
  });

  it("emits currentDate as a UTC YYYY-MM-DD string", () => {
    assert.equal(getSeasonContext(utc("2026-07-07")).currentDate, "2026-07-07");
  });
});

// ── getUpcomingEvents ────────────────────────────────────────────────────

describe("getUpcomingEvents", () => {
  const names = (now: Date, windowDays?: number): string[] =>
    getUpcomingEvents(now, windowDays).map((e) => e.name);

  it("catches Memorial Day (last Mon of May) within the window", () => {
    // Memorial Day 2026 = Mon May 25. Window May 20 → May 30.
    assert.ok(names(utc("2026-05-20")).includes("Memorial Day"));
  });

  it("catches Thanksgiving week (week of the 4th Thu of Nov)", () => {
    // Thanksgiving 2026 = Thu Nov 26; week Sun Nov 22 – Sat Nov 28.
    assert.ok(names(utc("2026-11-20")).includes("Thanksgiving week"));
  });

  it("catches Super Bowl week AND NFL season from a late-January window", () => {
    // Super Bowl 2026: first Sun of Feb = Feb 1; week Jan 26 – Feb 1.
    // NFL season anchored to 2025 runs Sep 1 2025 → Feb 15 2026, so a Jan-2026
    // window must find it via the year-1 candidate (year-boundary path).
    const got = names(utc("2026-01-28"));
    assert.ok(got.includes("Super Bowl week"), `missing Super Bowl: ${got}`);
    assert.ok(got.includes("NFL season"), `missing NFL season: ${got}`);
  });

  it("catches baseball opening week (Mar 25 – Apr 5)", () => {
    assert.ok(names(utc("2026-03-28")).includes("Baseball opening week"));
  });

  it("returns [] for a window with no events (late Feb gap)", () => {
    // Feb 20 → Mar 2: after NFL season (ends Feb 15) and Super Bowl week,
    // before baseball opening week (Mar 25).
    assert.deepEqual(getUpcomingEvents(utc("2026-02-20")), []);
  });

  it("each event carries a non-empty hint", () => {
    for (const e of getUpcomingEvents(utc("2026-05-20"))) {
      assert.ok(e.hint.length > 0, `empty hint for ${e.name}`);
    }
  });
});

// ── loader stubs ─────────────────────────────────────────────────────────

interface StubActivity {
  entityId: string | null;
  createdAt: Date;
}
interface StubMeal {
  id: string;
  title: string;
}
interface StubItem {
  assignedDate: Date | null;
  meal: { title: string } | null;
}
interface StubInstance {
  isWizardDraft: boolean;
  isArchived: boolean;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  titleOverride?: string | null;
  template?: { title: string } | null;
  items?: StubItem[];
}

function makeLoaderPrisma(data: {
  activities?: StubActivity[];
  meals?: StubMeal[];
  instances?: StubInstance[];
}): PrismaClient {
  const activities = data.activities ?? [];
  const meals = data.meals ?? [];
  const instances = data.instances ?? [];
  return {
    userActivity: {
      findMany: async () => activities,
    },
    meal: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        meals.filter((m) => where.id.in.includes(m.id)),
    },
    mealPlanInstance: {
      // Honor the draft/archive DB predicate + createdAt-desc order + take, so
      // the tests can exercise draft-exclusion for real.
      findMany: async ({
        where,
        take,
      }: {
        where: { isWizardDraft?: boolean; isArchived?: boolean };
        take?: number;
      }) => {
        const rows = instances
          .filter(
            (i) =>
              (where.isWizardDraft === undefined ||
                i.isWizardDraft === where.isWizardDraft) &&
              (where.isArchived === undefined ||
                i.isArchived === where.isArchived),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
    },
  } as unknown as PrismaClient;
}

// ── buildRecentMealHistory ───────────────────────────────────────────────

describe("buildRecentMealHistory", () => {
  const now = utc("2026-06-20"); // window ≈ May 23 → Jun 20

  it("unions cooked + planned, dedupes by title (newest wins), excludes drafts + out-of-window", async () => {
    const prisma = makeLoaderPrisma({
      activities: [{ entityId: "m1", createdAt: utc("2026-06-18") }],
      meals: [{ id: "m1", title: "Tacos" }],
      instances: [
        {
          // real, in-window — contributes Tacos (Jun 12) + Salmon (Jun 14)
          isWizardDraft: false,
          isArchived: false,
          startDate: utc("2026-06-10"),
          endDate: utc("2026-06-16"),
          createdAt: utc("2026-06-09"),
          items: [
            { assignedDate: utc("2026-06-12"), meal: { title: "Tacos" } },
            { assignedDate: utc("2026-06-14"), meal: { title: "Salmon" } },
          ],
        },
        {
          // wizard draft — must be excluded by the DB predicate
          isWizardDraft: true,
          isArchived: false,
          startDate: utc("2026-06-11"),
          endDate: utc("2026-06-15"),
          createdAt: utc("2026-06-11"),
          items: [
            { assignedDate: utc("2026-06-13"), meal: { title: "SecretDraftMeal" } },
          ],
        },
        {
          // real but out of window (January) — excluded
          isWizardDraft: false,
          isArchived: false,
          startDate: utc("2026-01-01"),
          endDate: utc("2026-01-05"),
          createdAt: utc("2026-01-01"),
          items: [
            { assignedDate: utc("2026-01-03"), meal: { title: "OldMeal" } },
          ],
        },
      ],
    });

    const history = await buildRecentMealHistory(prisma, "u1", now);
    const titles = history.map((h) => h.title);

    assert.deepEqual(new Set(titles), new Set(["Tacos", "Salmon"]));
    assert.ok(!titles.includes("SecretDraftMeal"));
    assert.ok(!titles.includes("OldMeal"));

    // Tacos was cooked Jun 18 (newer than the planned Jun 12) — newest wins.
    const tacos = history.find((h) => h.title === "Tacos");
    assert.equal(tacos?.source, "cooked");
    // Newest-first ordering: Tacos (Jun 18) precedes Salmon (Jun 14).
    assert.equal(history[0].title, "Tacos");
  });

  it("returns planned-only when no cook_meal rows exist (defensive branch inert)", async () => {
    const prisma = makeLoaderPrisma({
      instances: [
        {
          isWizardDraft: false,
          isArchived: false,
          startDate: utc("2026-06-10"),
          endDate: utc("2026-06-16"),
          createdAt: utc("2026-06-10"),
          items: [{ assignedDate: utc("2026-06-12"), meal: { title: "Chili" } }],
        },
      ],
    });
    const history = await buildRecentMealHistory(prisma, "u1", now);
    assert.equal(history.length, 1);
    assert.equal(history[0].source, "planned");
    assert.equal(history[0].title, "Chili");
  });

  it("includes an item with a null assignedDate when the instance range overlaps", async () => {
    const prisma = makeLoaderPrisma({
      instances: [
        {
          isWizardDraft: false,
          isArchived: false,
          startDate: utc("2026-06-10"),
          endDate: utc("2026-06-16"),
          createdAt: utc("2026-06-10"),
          items: [{ assignedDate: null, meal: { title: "Undated Stew" } }],
        },
      ],
    });
    const history = await buildRecentMealHistory(prisma, "u1", now);
    assert.equal(history.length, 1);
    assert.equal(history[0].title, "Undated Stew");
    // when falls back to the instance endDate.
    assert.equal(history[0].when, "2026-06-16");
  });
});

// ── buildRecentPlanNames ─────────────────────────────────────────────────

describe("buildRecentPlanNames", () => {
  it("coalesces titleOverride ?? template.title, drops null names, excludes drafts, newest first", async () => {
    const prisma = makeLoaderPrisma({
      instances: [
        {
          isWizardDraft: false,
          isArchived: false,
          startDate: null,
          endDate: null,
          createdAt: utc("2026-06-10"),
          titleOverride: "My Custom Plan",
          template: { title: "Base Template" },
        },
        {
          isWizardDraft: false,
          isArchived: false,
          startDate: null,
          endDate: null,
          createdAt: utc("2026-06-09"),
          titleOverride: null,
          template: { title: "Template Title" },
        },
        {
          // no override and no template — dropped
          isWizardDraft: false,
          isArchived: false,
          startDate: null,
          endDate: null,
          createdAt: utc("2026-06-08"),
          titleOverride: null,
          template: null,
        },
        {
          // draft — excluded by the DB predicate
          isWizardDraft: true,
          isArchived: false,
          startDate: null,
          endDate: null,
          createdAt: utc("2026-06-11"),
          titleOverride: "Draft Name",
          template: null,
        },
      ],
    });

    const names = await buildRecentPlanNames(prisma, "u1");
    assert.deepEqual(names, ["My Custom Plan", "Template Title"]);
  });
});

// ── buildRecentRotation (Block 4b-2, D-WS9-073) ──────────────────────────

interface RotItemMeal {
  id: string;
  title: string;
  sourceStoreMealId: string | null;
}
interface RotInstance {
  isWizardDraft: boolean;
  isArchived: boolean;
  createdAt: Date;
  items: { meal: RotItemMeal | null }[];
}

// Stub that honors the draft/archive predicate + createdAt-desc + take on
// mealPlanInstance.findMany, and the id-in filter on meal.findMany (the
// original-lineage lookup). NOTE it does NOT expose the forks' own
// dishFamilyKey — the real query never selects it, and the family must come
// from the ORIGINAL via meal.findMany. That structural omission is the guard
// against the per-title-nudge bug.
function makeRotationPrisma(data: {
  instances?: RotInstance[];
  originals?: { id: string; dishFamilyKey: string | null }[];
}): PrismaClient {
  const instances = data.instances ?? [];
  const originals = data.originals ?? [];
  return {
    mealPlanInstance: {
      findMany: async ({
        where,
        take,
      }: {
        where: { isWizardDraft?: boolean; isArchived?: boolean };
        take?: number;
      }) => {
        const rows = instances
          .filter(
            (i) =>
              (where.isWizardDraft === undefined ||
                i.isWizardDraft === where.isWizardDraft) &&
              (where.isArchived === undefined ||
                i.isArchived === where.isArchived),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
    },
    meal: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        originals.filter((o) => where.id.in.includes(o.id)),
    },
  } as unknown as PrismaClient;
}

const plan = (createdAt: Date, meals: RotItemMeal[]): RotInstance => ({
  isWizardDraft: false,
  isArchived: false,
  createdAt,
  items: meals.map((meal) => ({ meal })),
});

// Two REAL catalog dish families with DISTINCT parents (TARGET_DISHES[0] and
// [1] happen to share a parent, so resolve B by parentKey inequality).
const famA = TARGET_DISHES[0];
const infoA = lookupDishFamily(famA.key)!;
const famB = TARGET_DISHES.find(
  (t) => lookupDishFamily(t.key)!.parentKey !== infoA.parentKey,
)!;
const infoB = lookupDishFamily(famB.key)!;

describe("buildRecentRotation", () => {
  it("resolves a fork → original → parent dish family (not the fork's own key)", async () => {
    const prisma = makeRotationPrisma({
      instances: [
        plan(utc("2026-06-20"), [
          { id: "fork1", title: "Grandma's Bolognese", sourceStoreMealId: "orig1" },
        ]),
      ],
      originals: [{ id: "orig1", dishFamilyKey: famA.key }],
    });
    const rot = await buildRecentRotation(prisma, "u1");
    assert.equal(rot.plansConsidered, 1);
    assert.equal(rot.meals.length, 1);
    assert.equal(rot.meals[0].title, "Grandma's Bolognese");
    assert.equal(rot.meals[0].dishFamily, infoA.parentKey);
    assert.equal(rot.meals[0].familyRank, infoA.rank);
    assert.equal(rot.meals[0].timesRecentlyServed, 1);
  });

  it("the family is driven by the ORIGINAL's key — swap it, the family swaps", async () => {
    const rotA = await buildRecentRotation(
      makeRotationPrisma({
        instances: [
          plan(utc("2026-06-20"), [
            { id: "fork1", title: "Same Fork Title", sourceStoreMealId: "orig1" },
          ]),
        ],
        originals: [{ id: "orig1", dishFamilyKey: famA.key }],
      }),
      "u1",
    );
    const rotB = await buildRecentRotation(
      makeRotationPrisma({
        instances: [
          plan(utc("2026-06-20"), [
            { id: "fork1", title: "Same Fork Title", sourceStoreMealId: "orig1" },
          ]),
        ],
        // Same fork, same title — only the ORIGINAL's family key differs.
        originals: [{ id: "orig1", dishFamilyKey: famB.key }],
      }),
      "u1",
    );
    assert.equal(rotA.meals[0].dishFamily, infoA.parentKey);
    assert.equal(rotB.meals[0].dishFamily, infoB.parentKey);
    assert.notEqual(rotA.meals[0].dishFamily, rotB.meals[0].dishFamily);
  });

  it("a meal with no sourceStoreMealId emits title-only (no dishFamily), no throw", async () => {
    const prisma = makeRotationPrisma({
      instances: [
        plan(utc("2026-06-20"), [
          { id: "live1", title: "Improvised Fridge Stir-Fry", sourceStoreMealId: null },
        ]),
      ],
    });
    const rot = await buildRecentRotation(prisma, "u1");
    assert.equal(rot.meals.length, 1);
    assert.equal(rot.meals[0].title, "Improvised Fridge Stir-Fry");
    assert.equal(rot.meals[0].dishFamily, undefined);
    assert.equal(rot.meals[0].familyRank, undefined);
  });

  it("an original missing dishFamilyKey falls back to title-only (the 1/20 case)", async () => {
    const prisma = makeRotationPrisma({
      instances: [
        plan(utc("2026-06-20"), [
          { id: "fork1", title: "Curated Special", sourceStoreMealId: "orig1" },
        ]),
      ],
      originals: [{ id: "orig1", dishFamilyKey: null }],
    });
    const rot = await buildRecentRotation(prisma, "u1");
    assert.equal(rot.meals.length, 1);
    assert.equal(rot.meals[0].dishFamily, undefined);
    assert.equal(rot.meals[0].title, "Curated Special");
  });

  it("a lineage pointer to an absent/archived original falls back to title-only", async () => {
    const prisma = makeRotationPrisma({
      instances: [
        plan(utc("2026-06-20"), [
          { id: "fork1", title: "Orphaned Fork", sourceStoreMealId: "gone" },
        ]),
      ],
      originals: [], // original no longer resolvable
    });
    const rot = await buildRecentRotation(prisma, "u1");
    assert.equal(rot.meals.length, 1);
    assert.equal(rot.meals[0].dishFamily, undefined);
  });

  it("a write-back fork with lineage is NOT special-cased — it resolves to its family", async () => {
    // The query never selects sourceType, so a live_writeback fork behaves like
    // any lineage-carrying fork: a served meal is a served meal. (Decision:
    // write-backs count as recently served and resolve their family.)
    const prisma = makeRotationPrisma({
      instances: [
        plan(utc("2026-06-20"), [
          { id: "wb1", title: "Written-Back Favorite", sourceStoreMealId: "orig1" },
        ]),
      ],
      originals: [{ id: "orig1", dishFamilyKey: famA.key }],
    });
    const rot = await buildRecentRotation(prisma, "u1");
    assert.equal(rot.meals[0].dishFamily, infoA.parentKey);
  });

  it("dedupes a recurring family across plans and counts recurrences", async () => {
    const prisma = makeRotationPrisma({
      instances: [
        plan(utc("2026-06-20"), [
          { id: "f1", title: "Bolognese v1", sourceStoreMealId: "orig1" },
        ]),
        plan(utc("2026-06-13"), [
          { id: "f2", title: "Bolognese v2", sourceStoreMealId: "orig2" },
        ]),
      ],
      // Two DIFFERENT originals (different titles) that map to the SAME family.
      originals: [
        { id: "orig1", dishFamilyKey: famA.key },
        { id: "orig2", dishFamilyKey: famA.key },
      ],
    });
    const rot = await buildRecentRotation(prisma, "u1");
    assert.equal(rot.meals.length, 1);
    assert.equal(rot.meals[0].dishFamily, infoA.parentKey);
    assert.equal(rot.meals[0].timesRecentlyServed, 2);
    // Newest plan's title represents the family.
    assert.equal(rot.meals[0].title, "Bolognese v1");
  });

  it("scopes by PLAN COUNT (take = depth), not by meal count or date window", async () => {
    const instances = [
      plan(utc("2026-06-20"), [{ id: "a", title: "Newest", sourceStoreMealId: null }]),
      plan(utc("2026-06-13"), [{ id: "b", title: "Second", sourceStoreMealId: null }]),
      plan(utc("2026-06-06"), [{ id: "c", title: "Third", sourceStoreMealId: null }]),
      plan(utc("2026-05-30"), [{ id: "d", title: "FourthDropped", sourceStoreMealId: null }]),
      plan(utc("2026-05-23"), [{ id: "e", title: "FifthDropped", sourceStoreMealId: null }]),
    ];
    const rot = await buildRecentRotation(makeRotationPrisma({ instances }), "u1", 3);
    assert.equal(rot.plansConsidered, 3);
    const titles = rot.meals.map((m) => m.title);
    assert.deepEqual(new Set(titles), new Set(["Newest", "Second", "Third"]));
    assert.ok(!titles.includes("FourthDropped"));
    assert.ok(!titles.includes("FifthDropped"));
  });

  it("returns an empty rotation for a user with no real plans", async () => {
    const rot = await buildRecentRotation(makeRotationPrisma({}), "u1");
    assert.deepEqual(rot, { plansConsidered: 0, meals: [] });
  });
});
