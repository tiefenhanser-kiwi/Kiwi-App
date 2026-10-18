// THX-2S Part C (D-WS9-311) — theme meals stay off the everyday pool.
//
// Every reader of the everyday catalog pool runs its REAL where clause against
// a two-meal catalog — one public meal tagged `thanksgiving`, one untagged —
// through a small evaluator of the Prisma filter subset these readers use. So
// a reader that drops `everydayPoolWhere()` lets the tagged meal through and
// its test goes red (a recorded-args check could not tell).
//
// Readers: buildStoreShortlist (the weekly shelf: /wizard/shelf incl. guests,
// build-plans, expand), the wizard's named-dish candidates, GET /me/meals
// top_rated (swap suggestions + Add Meals), GET /meals. NOT readers: the
// Cookbook search, the playlist riders, a stored-shelf re-read.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";

import { signToken } from "../auth";
import {
  buildStoreShortlist,
  EVERYDAY_SHELF_EXCLUDED_TAGS,
} from "../store/storeShortlist";
import { resolveStoreComposeConfig } from "../store/storeComposeConfig";
import { explicitMealCandidatesWhere } from "../../routes/wizard";
import { createMeRouter } from "../../routes/me";
import { createMealsRouter } from "../../routes/meals";
import { withSessionUser } from "../../routes/__tests__/fixtures/sessionUserStub";

// ── a Prisma where evaluator (only the operators these readers use) ─────────

type Row = Record<string, unknown>;

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) return value === cond;
  const c = cond as Record<string, unknown>;
  for (const [op, arg] of Object.entries(c)) {
    switch (op) {
      case "in": if (!(arg as unknown[]).includes(value)) return false; break;
      case "notIn": if ((arg as unknown[]).includes(value)) return false; break;
      case "not": if (arg === null ? value === null : value === arg) return false; break;
      case "lte": if (!((value as number) <= (arg as number))) return false; break;
      case "gt": if (!((value as number) > (arg as number))) return false; break;
      case "hasSome": if (!(arg as unknown[]).some((t) => (value as unknown[]).includes(t))) return false; break;
      case "contains": {
        const ci = c.mode === "insensitive";
        const v = String(value);
        if (!(ci ? v.toLowerCase().includes(String(arg).toLowerCase()) : v.includes(String(arg)))) return false;
        break;
      }
      case "mode": break;
      default: throw new Error(`evaluator: unsupported operator "${op}" — extend it, never ignore it`);
    }
  }
  return true;
}

export function matchesWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "AND") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((w) => matchesWhere(row, w as Record<string, unknown>))) return false;
    } else if (key === "OR") {
      if (!(cond as Record<string, unknown>[]).some((w) => matchesWhere(row, w))) return false;
    } else if (key === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((w) => matchesWhere(row, w as Record<string, unknown>))) return false;
    } else if (!matchField(row[key], cond)) {
      return false;
    }
  }
  return true;
}

// ── the catalog ──────────────────────────────────────────────────────────────

function meal(id: string, title: string, tags: string[]): Row {
  return {
    id, title, displayTitle: null, description: null, tags,
    isPublic: true, isArchived: false, mealType: "dinner", userId: null,
    cuisineType: "american", difficulty: "easy", estimatedTimeMinutes: 30, activeTimeMinutes: 30,
    servingsDefault: 4, authoredServingsDefault: 4,
    caloriesPerServing: 500, proteinGPerServing: 30, carbsGPerServing: 40, fatGPerServing: 20,
    dishFamilyKey: null, allergens: [], imageUrl: null, saveCount: 5, useCount: 5, createdAt: new Date(0),
  };
}
const TURKEY = meal("m-thx", "Herb-Roasted Turkey", ["american", "fancy", "thanksgiving"]);
const WEEKNIGHT = meal("m-plain", "Turkey Meatballs", ["american", "easy"]);
const CATALOG = [TURKEY, WEEKNIGHT];

function prismaOver(rows: Row[]) {
  return {
    meal: {
      findMany: async (args: { where?: Record<string, unknown>; take?: number }) =>
        rows.filter((r) => matchesWhere(r, args.where)).slice(0, args.take ?? rows.length),
    },
    systemSetting: { findMany: async () => [] },
    // FIX-6 (BUG-436) — top_rated reads the stored allergies and diet; no row.
    userPreferences: { findUnique: async () => null },
  };
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return await new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("EVERYDAY_SHELF_EXCLUDED_TAGS — THX-2G's approve contract", () => {
  it("is exported under that exact name and contains thanksgiving", () => {
    assert.ok(Array.isArray(EVERYDAY_SHELF_EXCLUDED_TAGS));
    assert.ok(EVERYDAY_SHELF_EXCLUDED_TAGS.includes("thanksgiving"));
  });
});

describe("everyday-pool readers never return a thanksgiving-tagged public meal", () => {
  it("the evaluator itself: no filter → both meals (the fixture is not vacuous)", () => {
    assert.equal(CATALOG.filter((r) => matchesWhere(r, { isPublic: true })).length, 2);
  });

  it("buildStoreShortlist (the weekly shelf)", async () => {
    const shelf = await buildStoreShortlist(prismaOver(CATALOG) as unknown as PrismaClient, {
      cuisines: ["american"],
      allergiesAndAvoidances: [],
      difficulty: "fancy",
      userId: "u-pool",
      rotationSalt: 0,
      config: { ...resolveStoreComposeConfig(), shortlistSize: 10 },
    });
    assert.deepEqual(shelf.selectedIds, ["m-plain"]);
  });

  it("the wizard's named-dish candidates (\"turkey\")", () => {
    const where = explicitMealCandidatesWhere(["turkey"], []);
    assert.deepEqual(
      CATALOG.filter((r) => matchesWhere(r, where as Record<string, unknown>)).map((r) => r.id),
      ["m-plain"],
    );
  });

  it("GET /me/meals?filter=top_rated (swap suggestions, Add Meals)", async () => {
    const app = express();
    app.use(express.json());
    app.use(createMeRouter({
      prisma: withSessionUser(prismaOver(CATALOG)) as never,
      estimateDishMacros: (async () => ({ status: "failed", error: "test stub" })) as never,
    }));
    const h = await listen(app);
    try {
      const res = await fetch(`${h.url}/me/meals?filter=top_rated`, {
        headers: { Authorization: `Bearer ${signToken("u-pool")}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { meals: { id: string }[] };
      assert.deepEqual(body.meals.map((m) => m.id), ["m-plain"]);
    } finally {
      await h.close();
    }
  });

  it("GET /meals (the catalog list)", async () => {
    const app = express();
    app.use(express.json());
    app.use(createMealsRouter({ prisma: withSessionUser(prismaOver(CATALOG)) as never }));
    const h = await listen(app);
    try {
      const res = await fetch(`${h.url}/meals`, {
        headers: { Authorization: `Bearer ${signToken("u-pool")}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { meals: { id: string }[] };
      assert.deepEqual(body.meals.map((m) => m.id), ["m-plain"]);
    } finally {
      await h.close();
    }
  });
});
