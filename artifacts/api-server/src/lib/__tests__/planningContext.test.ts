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
} from "../planningContext";

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
