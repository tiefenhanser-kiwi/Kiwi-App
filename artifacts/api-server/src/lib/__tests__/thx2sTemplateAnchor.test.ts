// THX-2S Part B (D-WS9-311) — servings and anchored dating on adopt.
//
// The Thanksgiving week: anchor = Thursday 2026-11-26, items Monday–Friday in
// template order. Adopted on or before the anchor → dated Mon 23 … Fri 27 by
// the items' own days, no perishability re-sort; after it → exactly an
// unanchored template. Each item's servingsOverride rides onto the plan item,
// and the grocery list reads it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";

import { signToken } from "../auth";
import { consolidatePlanIngredients } from "../groceryList";
import { adoptTemplateForUser } from "../guestClaim";
import { copyTemplateForUser } from "../planFromTemplate";
import {
  anchoredDatingFor,
  dateInAnchorWeek,
  isWithinAnchorWindow,
} from "../templateAnchor";
import { createPlansRouter } from "../../routes/plans";
import { withSessionUser } from "../../routes/__tests__/fixtures/sessionUserStub";

const USER = "thx2s-user";
const ANCHOR = new Date("2026-11-26T00:00:00Z"); // Thursday
const NOV_5 = new Date("2026-11-05T00:00:00Z");
const NOV_27 = new Date("2026-11-27T00:00:00Z");
const ymd = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

/** The Classic week: Mon/Tue catalog, Wed pizza, Thu feast at 10, Fri leftovers. */
function thanksgivingItems() {
  return [
    { id: "ti-mon", mealId: "m-mon", positionIndex: 0, assignedDayOfWeek: "Monday", servingsOverride: null },
    { id: "ti-tue", mealId: "m-tue", positionIndex: 1, assignedDayOfWeek: "Tuesday", servingsOverride: null },
    { id: "ti-wed", mealId: "m-wed", positionIndex: 2, assignedDayOfWeek: "Wednesday", servingsOverride: null },
    { id: "ti-thu", mealId: "m-feast", positionIndex: 3, assignedDayOfWeek: "Thursday", servingsOverride: 10 },
    { id: "ti-fri", mealId: "m-fri", positionIndex: 4, assignedDayOfWeek: "Friday", servingsOverride: null },
  ].map((it) => ({ ...it, isBreakfast: false, isLunch: false, isDinner: true }));
}

interface Rec {
  instances: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  instanceUpdates: Array<Record<string, unknown>>;
}

/** A tx for copyTemplateForUser. The template's meals are the user's own, so
 *  nothing forks — the fork is mealFork.test.ts's business, not this file's. */
function makeTx(template: Record<string, unknown> | null, rec: Rec) {
  return {
    mealPlanTemplate: {
      findUnique: async () => template,
      update: async () => ({}),
    },
    meal: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({ id, userId: USER })),
    },
    mealPlanInstance: {
      create: async (args: { data: Record<string, unknown> }) => {
        rec.instances.push(args.data);
        return { id: "inst-1", revisionId: 1, ...args.data };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        rec.instanceUpdates.push(args.data);
        return { id: "inst-1" };
      },
    },
    mealPlanItem: {
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        rec.items.push(...args.data);
        return { count: args.data.length };
      },
    },
    userActivity: { create: async () => ({ id: "act" }) },
    user: { updateMany: async () => ({ count: 0 }) },
  };
}

function anchoredTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: "t-thx",
    userId: "kiwi-kitchen-editorial",
    isPublic: true,
    isArchived: false,
    anchorDate: ANCHOR,
    optimizationNotes: null,
    items: thanksgivingItems(),
    ...overrides,
  };
}

const noopMark = async () => {};
const newRec = (): Rec => ({ instances: [], items: [], instanceUpdates: [] });

describe("templateAnchor — pure", () => {
  it("dates each weekday inside the anchor's Sunday–Saturday week", () => {
    assert.equal(ymd(dateInAnchorWeek(ANCHOR, "Monday")), "2026-11-23");
    assert.equal(ymd(dateInAnchorWeek(ANCHOR, "Thursday")), "2026-11-26");
    assert.equal(ymd(dateInAnchorWeek(ANCHOR, "friday")), "2026-11-27");
    assert.equal(dateInAnchorWeek(ANCHOR, null), null);
    assert.equal(dateInAnchorWeek(ANCHOR, "Someday"), null);
  });

  it("the window is on or before the anchor day, inclusive", () => {
    assert.equal(isWithinAnchorWindow(ANCHOR, NOV_5), true);
    assert.equal(isWithinAnchorWindow(ANCHOR, new Date("2026-11-26T23:59:00Z")), true);
    assert.equal(isWithinAnchorWindow(ANCHOR, NOV_27), false);
  });

  it("no anchor, or no item with a day → no dating", () => {
    assert.equal(anchoredDatingFor({ anchorDate: null, items: thanksgivingItems() }, NOV_5), null);
    assert.equal(anchoredDatingFor({ anchorDate: ANCHOR, items: [{ assignedDayOfWeek: null }] }, NOV_5), null);
  });
});

describe("copyTemplateForUser — anchored dating + servings (THX-2S B)", () => {
  it("adopted Nov 5 → Mon 23 … Fri 27 in template order, Thursday the feast at 10", async () => {
    const rec = newRec();
    const out = await copyTemplateForUser(
      makeTx(anchoredTemplate(), rec) as never, "t-thx", USER, noopMark, { today: NOV_5 },
    );
    assert.equal(out.kind, "created");
    assert.equal(ymd(rec.instances[0].startDate), "2026-11-23");
    assert.equal(ymd(rec.instances[0].endDate), "2026-11-27");
    // Dating is not activation.
    assert.equal(rec.instances[0].activatedAt, undefined);
    assert.deepEqual(
      rec.items.map((i) => [i.mealId, i.assignedDayOfWeek, ymd(i.assignedDate)]),
      [
        ["m-mon", "Monday", "2026-11-23"],
        ["m-tue", "Tuesday", "2026-11-24"],
        ["m-wed", "Wednesday", "2026-11-25"],
        ["m-feast", "Thursday", "2026-11-26"],
        ["m-fri", "Friday", "2026-11-27"],
      ],
    );
    assert.deepEqual(rec.items.map((i) => i.servingsOverride), [null, null, null, 10, null]);
    assert.ok(out.kind === "created" && out.anchoredWindow !== null);
  });

  it("adopted Nov 27 (after the anchor) → NOT refused; an undated copy, exactly as an unanchored template", async () => {
    const rec = newRec();
    const out = await copyTemplateForUser(
      makeTx(anchoredTemplate(), rec) as never, "t-thx", USER, noopMark, { today: NOV_27 },
    );
    assert.equal(out.kind, "created");
    assert.equal(out.kind === "created" && out.anchoredWindow, null);
    assert.equal(rec.instances[0].startDate, null);
    assert.equal(rec.instances[0].endDate, null);
    assert.ok(rec.items.every((i) => i.assignedDate === null));
    // Servings still ride: the feast is still written for 10.
    assert.equal(rec.items[3].servingsOverride, 10);
  });

  it("a template with no anchor behaves exactly as today", async () => {
    const rec = newRec();
    const items = thanksgivingItems().map((i) => {
      const { servingsOverride: _drop, ...rest } = i;
      return rest; // a pre-THX-2S row: no servingsOverride key at all
    });
    await copyTemplateForUser(
      makeTx(anchoredTemplate({ anchorDate: null, items }), rec) as never, "t-thx", USER, noopMark, { today: NOV_5 },
    );
    assert.equal(rec.instances[0].startDate, null);
    assert.equal(rec.instances[0].endDate, null);
    assert.deepEqual(rec.items.map((i) => i.assignedDayOfWeek), ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
    assert.ok(rec.items.every((i) => i.assignedDate === null && i.servingsOverride === null));
  });
});

describe("adoptTemplateForUser (sign-up templatePlanId) — the anchor applies", () => {
  function prismaFor(template: Record<string, unknown>, rec: Rec) {
    const tx = makeTx(template, rec);
    return { $transaction: async <T,>(cb: (t: typeof tx) => Promise<T>) => cb(tx) } as unknown as PrismaClient;
  }

  it("signing up Nov 5 keeps the anchored week and does NOT re-date from tomorrow or activate", async () => {
    const rec = newRec();
    const id = await adoptTemplateForUser({
      prisma: prismaFor(anchoredTemplate(), rec), userId: USER, templateId: "t-thx", localDate: "2026-11-05",
    });
    assert.equal(id, "inst-1");
    assert.equal(ymd(rec.instances[0].startDate), "2026-11-23");
    assert.deepEqual(rec.instanceUpdates, []);
  });

  it("signing up Nov 24 (inside the anchored week) activates it", async () => {
    const rec = newRec();
    await adoptTemplateForUser({
      prisma: prismaFor(anchoredTemplate(), rec), userId: USER, templateId: "t-thx", localDate: "2026-11-24",
    });
    assert.equal(rec.instanceUpdates.length, 1);
    assert.ok(rec.instanceUpdates[0].activatedAt instanceof Date);
    assert.equal(rec.instanceUpdates[0].startDate, undefined, "dates are not rewritten");
  });

  it("an unanchored template still dates from tomorrow (unchanged)", async () => {
    const rec = newRec();
    await adoptTemplateForUser({
      prisma: prismaFor(anchoredTemplate({ anchorDate: null }), rec), userId: USER, templateId: "t-thx", localDate: "2026-11-05",
    });
    assert.equal(ymd(rec.instanceUpdates[0].startDate), "2026-11-06");
  });
});

describe("grocery — the feast item's servingsOverride 10 buys the 10-serving quantity", () => {
  // A household of 2 adopted the feast: the fork's dishes carry servingsDefault
  // 2 (BUG-046 unification) against the authored anchor of 10.
  function planWith(servingsOverride: number | null) {
    return {
      id: "plan-thx",
      userId: USER,
      items: [
        {
          id: "pi-thu",
          mealId: "m-feast",
          positionIndex: 0,
          servingsOverride,
          recipeOverrideJson: null,
          meal: {
            id: "m-feast",
            dishLinks: [
              {
                positionIndex: 0,
                dish: {
                  id: "d-turkey",
                  title: "Herb-Roasted Whole Turkey",
                  servingsDefault: 2,
                  authoredServingsDefault: 10,
                  dishIngredients: [
                    {
                      id: "di-1",
                      quantity: 12,
                      unit: "pound",
                      preparationNote: null,
                      isOptional: false,
                      fromLeftovers: false,
                      ingredient: {
                        id: "ing-turkey",
                        canonicalName: "whole turkey",
                        displayName: "whole turkey",
                        category: "Protein",
                        purchaseUnit: null,
                        purchaseQuantity: null,
                        purchaseDisplay: null,
                        conversionRef: null,
                        packYieldUnit: null,
                        packYieldPerPack: null,
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
      user: { pantryStaples: [], preferences: null },
    };
  }
  const prismaFor = (plan: unknown) =>
    ({ mealPlanInstance: { findUnique: async () => plan } }) as unknown as PrismaClient;

  it("override 10 → 12 lb (the authored quantity); no override → 2.4 lb, listed 2.5 (household 2)", async () => {
    const withOverride = await consolidatePlanIngredients({ prisma: prismaFor(planWith(10)), planId: "plan-thx", userId: USER });
    const turkey = withOverride.find((i) => i.canonicalName === "whole turkey");
    assert.equal(turkey?.quantity, 12);
    assert.equal(turkey?.sources[0].servings, 10);

    const household = await consolidatePlanIngredients({ prisma: prismaFor(planWith(null)), planId: "plan-thx", userId: USER });
    // 12 × 2/10 = 2.4 lb, which the shopping round-up ladder lists as 2.5.
    assert.equal(household.find((i) => i.canonicalName === "whole turkey")?.quantity, 2.5);
  });
});

describe("PATCH /plans/:id { isActiveThisWeek } — the anchored hold", () => {
  async function spin(prisma: unknown, now: Date) {
    const app = express();
    app.use(express.json());
    app.use("/api", createPlansRouter({
      prisma: withSessionUser(prisma) as never,
      now: () => now,
      planNeedsMacroEstimation: (async () => false) as never,
      mutationLimiterOpts: { capacity: 1000, refillPerSec: 100 },
    } as never));
    return await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const server: Server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        resolve({
          url: `http://127.0.0.1:${addr.port}/api`,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
  }

  function stub(startDate: Date, endDate: Date) {
    const itemUpdates: unknown[] = [];
    const instanceUpdates: Array<Record<string, unknown>> = [];
    const row = {
      userId: USER, titleOverride: null, startDate, endDate, status: "draft",
      breakfastOverrides: null, lunchOverrides: null, prepStatus: "not_prepped",
      prepStatusIsManual: false, revisionId: 1, mealPlanTemplateId: "t-thx",
    };
    const tx = {
      mealPlanInstance: {
        findUnique: async () => row,
        findMany: async () => [],
        update: async (a: { data: Record<string, unknown> }) => {
          instanceUpdates.push(a.data);
          return { id: "inst-1", revisionId: 2 };
        },
      },
      mealPlanTemplate: {
        findUnique: async () => ({ anchorDate: ANCHOR, items: thanksgivingItems() }),
      },
      mealPlanItem: {
        findMany: async () => thanksgivingItems().map((i) => ({ id: i.id, mealId: i.mealId })),
        update: async (a: unknown) => {
          itemUpdates.push(a);
          return {};
        },
      },
      meal: { findMany: async () => [] },
      userActivity: { create: async () => ({ id: "act" }) },
    };
    return {
      prisma: { ...tx, $transaction: async <T,>(cb: (t: typeof tx) => Promise<T>) => cb(tx) },
      itemUpdates,
      instanceUpdates,
    };
  }

  const patch = (url: string) =>
    fetch(`${url}/plans/inst-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(USER)}` },
      body: JSON.stringify({ isActiveThisWeek: true, localDate: "2026-11-05" }),
    });

  it("on its anchored dates (Nov 5): no re-date, no re-sort — a no-op", async () => {
    const s = stub(new Date("2026-11-23T00:00:00Z"), new Date("2026-11-27T00:00:00Z"));
    const h = await spin(s.prisma, NOV_5);
    try {
      const res = await patch(h.url);
      assert.equal(res.status, 200);
      assert.deepEqual(s.itemUpdates, [], "no item was re-assigned");
      assert.deepEqual(s.instanceUpdates, [], "the dates did not move");
    } finally {
      await h.close();
    }
  });

  it("after the user moved the dates: today's behaviour (re-assigned from tomorrow)", async () => {
    const s = stub(new Date("2026-11-30T00:00:00Z"), new Date("2026-12-04T00:00:00Z"));
    const h = await spin(s.prisma, NOV_5);
    try {
      const res = await patch(h.url);
      assert.equal(res.status, 200);
      assert.equal(s.itemUpdates.length, 5, "every item re-assigned");
      assert.equal(ymd(s.instanceUpdates[0].startDate), "2026-11-05");
    } finally {
      await h.close();
    }
  });
});
