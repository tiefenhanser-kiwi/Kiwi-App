// WS7-4-D c16 — unit tests for the toYmd helper. The helper formats a Date
// (DateTime column read from Prisma) as a calendar-date YYYY-MM-DD string
// using UTC components. UTC matches the store side: PATCH /plans/:id
// canonicalizes incoming YYYY-MM-DD via `new Date("YYYY-MM-DD")`, which JS
// interprets as UTC midnight. Symmetric extraction on read keeps the
// round-trip stable regardless of the server process's local timezone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  RAIL_LIMIT,
  resolvePlansForFilter,
  resolveRailPlans,
  toYmd,
} from "../planQueries";

describe("toYmd — calendar-date wire formatter", () => {
  it("returns null for null input", () => {
    assert.equal(toYmd(null), null);
  });

  it("formats a UTC-midnight Date as YYYY-MM-DD", () => {
    const d = new Date("2026-06-07T00:00:00.000Z");
    assert.equal(toYmd(d), "2026-06-07");
  });

  it("pads single-digit month and day with leading zero", () => {
    const d = new Date("2026-01-05T00:00:00.000Z");
    assert.equal(toYmd(d), "2026-01-05");
  });

  it("uses UTC components (a UTC-midnight Date returns the calendar date the user wrote, not the server's local-time date)", () => {
    // `new Date("YYYY-MM-DD")` parses as UTC midnight per the JS spec — same
    // path PATCH /plans/:id takes via toNullableDate. UTC extraction on read
    // must hand back the exact YYYY-MM-DD the user wrote, regardless of where
    // the server is running.
    const d = new Date("2026-12-31");
    assert.equal(toYmd(d), "2026-12-31");
  });

  it("preserves the date even when local time would shift it (TZ-agnostic on the server)", () => {
    // A Date constructed at UTC midnight 2026-06-07 reads as 2026-06-07 in
    // UTC components, full stop. The mobile parser receives the same string
    // and parses it with local-time semantics — that's where the calendar
    // date lives for the user, and the symmetry is the point.
    const d = new Date(Date.UTC(2026, 5, 7, 0, 0, 0, 0));
    assert.equal(toYmd(d), "2026-06-07");
  });
});

// ── WS9-2 2c Commit 1 — resolvePlansForFilter ────────────────────────────────
//
// Phase 0 found this function had NO unit test at all, and that no test anywhere
// asserted `image` on a PlanListItem coming out of GET /plans. That combination
// is what makes the rail's imagery a silent-failure surface: the Tried & True
// rail is the ONLY place in the app where photographs actually render (Meal.
// imageUrl is non-null on 0/1471 rows; every other TreatedImage shows its
// gradient), and its images ride TEMPLATE_SELECT.imageUrl through eight hops.
//
// These tests pin hop 1 → hop 2 for all four buckets. `image` is asserted
// explicitly in every one; a projection that drops imageUrl now fails a test in
// addition to failing the compile-time SelectFor guard in planQueries.ts.

const NOW = new Date("2026-08-12T12:00:00.000Z");
const USER_ID = "u-1";

// A public MealPlanTemplate row as TEMPLATE_SELECT projects it.
function templateRow(id: string, title: string, imageUrl: string | null) {
  return {
    id,
    title,
    description: `${title} description`,
    imageUrl,
    tags: ["hosting", "dev"],
  };
}

// A MealPlanInstance row as INSTANCE_TEMPLATE_INCLUDE projects it.
function instanceRow(id: string, imageUrl: string | null) {
  return {
    id,
    titleOverride: null as string | null,
    status: "upcoming",
    startDate: new Date("2026-08-10T00:00:00.000Z"),
    endDate: new Date("2026-08-16T00:00:00.000Z"),
    revisionId: 1,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    template: {
      title: "Backing Template",
      description: "desc",
      imageUrl,
      tags: ["dev"],
    },
  };
}

const TOP_RATED_SETTINGS = [
  { key: "top_rated.save_weight", value: 1 },
  { key: "top_rated.use_weight", value: 2 },
  { key: "top_rated.decay_half_life_days", value: 30 },
  { key: "top_rated.refresh_interval_hours", value: 6 },
  { key: "top_rated.display_count", value: 20 },
];

interface Captured {
  templateArgs: Record<string, unknown> | null;
  instanceArgs: Record<string, unknown> | null;
}

// Minimal prisma stub. Captures the args each findMany was called with so a
// test can assert the projection AND the ordering, not just the mapped output.
function makeStubPrisma(opts: {
  templates?: ReturnType<typeof templateRow>[];
  instances?: ReturnType<typeof instanceRow>[];
}): { prisma: PrismaClient; captured: Captured } {
  const captured: Captured = { templateArgs: null, instanceArgs: null };
  const prisma = {
    mealPlanTemplate: {
      findMany: async (args: Record<string, unknown>) => {
        captured.templateArgs = args;
        return opts.templates ?? [];
      },
    },
    mealPlanInstance: {
      findMany: async (args: Record<string, unknown>) => {
        captured.instanceArgs = args;
        return opts.instances ?? [];
      },
    },
    systemSetting: {
      findMany: async () => TOP_RATED_SETTINGS,
    },
  } as unknown as PrismaClient;
  return { prisma, captured };
}

const RAIL_IMAGE =
  "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=80";

describe("resolvePlansForFilter — image survives every bucket", () => {
  it("featured: imageUrl is selected and maps to `image`", async () => {
    const { prisma, captured } = makeStubPrisma({
      templates: [templateRow("t-1", "Quick Weeknights", RAIL_IMAGE)],
    });

    const rows = await resolvePlansForFilter(
      prisma,
      "featured",
      USER_ID,
      NOW,
      20,
      null,
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].image, RAIL_IMAGE);
    assert.equal(rows[0].source, "template");
    // Hop 1: the projection must actually ask the DB for the column.
    const select = (captured.templateArgs as { select: Record<string, boolean> })
      .select;
    assert.equal(
      select.imageUrl,
      true,
      "featured bucket must select imageUrl — dropping it silently blanks the rail",
    );
  });

  it("hosting_events: imageUrl is selected and maps to `image`", async () => {
    const { prisma, captured } = makeStubPrisma({
      templates: [templateRow("t-2", "Game Day Spread", RAIL_IMAGE)],
    });

    const rows = await resolvePlansForFilter(
      prisma,
      "hosting_events",
      USER_ID,
      NOW,
      20,
      null,
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].image, RAIL_IMAGE);
    const select = (captured.templateArgs as { select: Record<string, boolean> })
      .select;
    assert.equal(select.imageUrl, true);
  });

  it("top_rated: imageUrl is selected and maps to `image`", async () => {
    const { prisma, captured } = makeStubPrisma({
      templates: [templateRow("t-3", "Budget Bowls", RAIL_IMAGE)],
    });

    const rows = await resolvePlansForFilter(
      prisma,
      "top_rated",
      USER_ID,
      NOW,
      20,
      null,
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].image, RAIL_IMAGE);
    const select = (captured.templateArgs as { select: Record<string, boolean> })
      .select;
    assert.equal(select.imageUrl, true);
  });

  it("my_plans: the backing template's imageUrl is included and maps to `image`", async () => {
    const { prisma, captured } = makeStubPrisma({
      instances: [instanceRow("p-1", RAIL_IMAGE)],
    });

    const rows = await resolvePlansForFilter(
      prisma,
      "my_plans",
      USER_ID,
      NOW,
      20,
      null,
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].image, RAIL_IMAGE);
    assert.equal(rows[0].source, "instance");
    const include = (
      captured.instanceArgs as {
        include: { template: { select: Record<string, boolean> } };
      }
    ).include;
    assert.equal(include.template.select.imageUrl, true);
  });

  it("a null imageUrl maps to a null `image` (not undefined — the mobile Zod field is nullable, NOT optional)", async () => {
    const { prisma } = makeStubPrisma({
      templates: [templateRow("t-4", "No Photo", null)],
    });

    const rows = await resolvePlansForFilter(
      prisma,
      "featured",
      USER_ID,
      NOW,
      20,
      null,
    );

    assert.equal(rows[0].image, null);
    assert.ok(
      "image" in rows[0],
      "the key must be present — res.json drops undefined, and PlanListItemSchema rejects a missing `image`",
    );
  });
});

describe("resolvePlansForFilter — bucket predicates and ordering", () => {
  it("featured gates on isFeatured + the public/non-archived pool", async () => {
    const { prisma, captured } = makeStubPrisma({ templates: [] });
    await resolvePlansForFilter(prisma, "featured", USER_ID, NOW, 20, null);

    const where = (captured.templateArgs as { where: Record<string, unknown> })
      .where;
    assert.equal(where.isPublic, true);
    assert.equal(where.isArchived, false);
    assert.equal(where.isFeatured, true);
  });

  it("hosting_events gates on isHostingFeatured, not isFeatured", async () => {
    const { prisma, captured } = makeStubPrisma({ templates: [] });
    await resolvePlansForFilter(
      prisma,
      "hosting_events",
      USER_ID,
      NOW,
      20,
      null,
    );

    const where = (captured.templateArgs as { where: Record<string, unknown> })
      .where;
    assert.equal(where.isHostingFeatured, true);
    assert.equal(where.isFeatured, undefined);
  });

  it("top_rated has NO featured gate — it sweeps the whole public pool", async () => {
    // This is load-bearing and easy to mistake for a bug: because top_rated is
    // ungated, the rail already surfaces every public template, badged or not.
    const { prisma, captured } = makeStubPrisma({ templates: [] });
    await resolvePlansForFilter(prisma, "top_rated", USER_ID, NOW, 20, null);

    const where = (captured.templateArgs as { where: Record<string, unknown> })
      .where;
    assert.equal(where.isPublic, true);
    assert.equal(where.isArchived, false);
    assert.equal(where.isFeatured, undefined);
    assert.equal(where.isHostingFeatured, undefined);
  });

  it("top_rated caps at min(limit, displayCount) — displayCount wins when lower", async () => {
    const { prisma, captured } = makeStubPrisma({ templates: [] });
    await resolvePlansForFilter(prisma, "top_rated", USER_ID, NOW, 100, null);

    assert.equal((captured.templateArgs as { take: number }).take, 20);
  });

  it("my_plans excludes composted and wizard-draft rows", async () => {
    const { prisma, captured } = makeStubPrisma({ instances: [] });
    await resolvePlansForFilter(prisma, "my_plans", USER_ID, NOW, 20, null);

    const where = (captured.instanceArgs as { where: Record<string, unknown> })
      .where;
    assert.equal(where.userId, USER_ID);
    assert.equal(where.isArchived, false);
    assert.equal(where.isWizardDraft, false);
  });

  it("my_plans derives isActiveThisWeek by id-compare against the pre-resolved winnerId", async () => {
    const { prisma } = makeStubPrisma({
      instances: [instanceRow("p-1", null), instanceRow("p-2", null)],
    });
    const rows = await resolvePlansForFilter(
      prisma,
      "my_plans",
      USER_ID,
      NOW,
      20,
      "p-2",
    );

    assert.equal(rows.find((r) => r.id === "p-1")?.isActiveThisWeek, false);
    assert.equal(rows.find((r) => r.id === "p-2")?.isActiveThisWeek, true);
  });

  it("template buckets are never isActiveThisWeek, even when a winnerId is threaded", async () => {
    const { prisma } = makeStubPrisma({
      templates: [templateRow("t-1", "Featured Plan", null)],
    });
    const rows = await resolvePlansForFilter(
      prisma,
      "featured",
      USER_ID,
      NOW,
      20,
      "t-1",
    );

    assert.equal(rows[0].isActiveThisWeek, false);
  });
});

// ── WS9-2 2c (D-WS9-154) — resolveRailPlans ─────────────────────────────────

function railRow(
  id: string,
  title: string,
  over: Partial<{
    imageUrl: string | null;
    isFeatured: boolean;
    isHostingFeatured: boolean;
  }> = {},
) {
  return {
    id,
    title,
    description: `${title} description`,
    imageUrl: over.imageUrl !== undefined ? over.imageUrl : RAIL_IMAGE,
    tags: ["hosting", "dev"],
    isFeatured: over.isFeatured ?? false,
    isHostingFeatured: over.isHostingFeatured ?? true,
  };
}

describe("resolveRailPlans — the Home Tried & True rail", () => {
  it("selects imageUrl and maps it to `image`", async () => {
    const { prisma, captured } = makeStubPrisma({
      templates: [railRow("t-1", "Game Day Spread")],
    });
    const rows = await resolveRailPlans(prisma as unknown as PrismaClient);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].image, RAIL_IMAGE);
    const select = (captured.templateArgs as { select: Record<string, boolean> })
      .select;
    assert.equal(
      select.imageUrl,
      true,
      "RAIL_SELECT spreads TEMPLATE_SELECT — imageUrl must survive the collapse",
    );
  });

  it("carries both featuring flags so the client can derive the badge", async () => {
    const { prisma, captured } = makeStubPrisma({
      templates: [
        railRow("t-1", "Quick Weeknights", {
          isFeatured: true,
          isHostingFeatured: false,
        }),
      ],
    });
    const rows = await resolveRailPlans(prisma as unknown as PrismaClient);

    assert.equal(rows[0].isFeatured, true);
    assert.equal(rows[0].isHostingFeatured, false);
    const select = (captured.templateArgs as { select: Record<string, boolean> })
      .select;
    assert.equal(select.isFeatured, true);
    assert.equal(select.isHostingFeatured, true);
  });

  it("MEMBERSHIP is railPosition non-null — a null row is out of the rail", async () => {
    const { prisma, captured } = makeStubPrisma({ templates: [] });
    await resolveRailPlans(prisma as unknown as PrismaClient);

    const where = (captured.templateArgs as { where: Record<string, unknown> })
      .where;
    assert.deepEqual(where.railPosition, { not: null });
    assert.equal(where.isPublic, true);
    assert.equal(where.isArchived, false);
  });

  it("orders by railPosition ASC with createdAt DESC as the stable tiebreak", async () => {
    const { prisma, captured } = makeStubPrisma({ templates: [] });
    await resolveRailPlans(prisma as unknown as PrismaClient);

    assert.deepEqual((captured.templateArgs as { orderBy: unknown }).orderBy, [
      { railPosition: "asc" },
      { createdAt: "desc" },
    ]);
  });

  it("does NOT gate on isFeatured/isHostingFeatured — an unbadged curated row still shows", async () => {
    // railPosition is the membership test. The flags only pick the badge label.
    const { prisma, captured } = makeStubPrisma({
      templates: [
        railRow("t-6", "Budget Bowls", {
          isFeatured: false,
          isHostingFeatured: false,
        }),
      ],
    });
    const rows = await resolveRailPlans(prisma as unknown as PrismaClient);

    const where = (captured.templateArgs as { where: Record<string, unknown> })
      .where;
    assert.equal(where.isFeatured, undefined);
    assert.equal(where.isHostingFeatured, undefined);
    assert.equal(rows.length, 1);
  });

  it("caps at RAIL_LIMIT — the same ceiling the retired 4-per-badge × 3 merge had", async () => {
    const { prisma, captured } = makeStubPrisma({ templates: [] });
    await resolveRailPlans(prisma as unknown as PrismaClient);

    assert.equal((captured.templateArgs as { take: number }).take, RAIL_LIMIT);
    assert.equal(RAIL_LIMIT, 12);
  });

  it("an explicit limit overrides the default cap", async () => {
    const { prisma, captured } = makeStubPrisma({ templates: [] });
    await resolveRailPlans(prisma as unknown as PrismaClient, 3);

    assert.equal((captured.templateArgs as { take: number }).take, 3);
  });

  it("emits `image: null` as a PRESENT key when a curated row has no photo", async () => {
    const { prisma } = makeStubPrisma({
      templates: [railRow("t-1", "No Photo", { imageUrl: null })],
    });
    const rows = await resolveRailPlans(prisma as unknown as PrismaClient);

    assert.equal(rows[0].image, null);
    assert.ok("image" in rows[0]);
  });

  it("does not leak description onto the wire (the card never renders it)", async () => {
    const { prisma } = makeStubPrisma({
      templates: [railRow("t-1", "Game Day Spread")],
    });
    const rows = await resolveRailPlans(prisma as unknown as PrismaClient);

    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "id",
      "image",
      "isFeatured",
      "isHostingFeatured",
      "name",
      "tags",
    ]);
  });
});
