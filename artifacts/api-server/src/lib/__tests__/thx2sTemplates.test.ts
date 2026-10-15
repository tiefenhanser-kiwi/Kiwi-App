// THX-2S Part E (BUG-403) — the Featured chip in rail order; an archived
// template cannot be previewed or adopted by id.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";

import { signToken } from "../auth";
import { copyTemplateForUser } from "../planFromTemplate";
import { resolvePlansForFilter } from "../planQueries";
import { createPlansRouter } from "../../routes/plans";
import { withSessionUser } from "../../routes/__tests__/fixtures/sessionUserStub";

const USER = "thx2s-e-user";

const ARCHIVED = {
  id: "t-arch",
  userId: USER, // the owner too: archived is gone for everyone
  isPublic: true,
  isArchived: true,
  anchorDate: null,
  optimizationNotes: null,
  items: [],
};

describe("Featured chip order (BUG-403)", () => {
  it("featured orders by railPosition (nulls last), then createdAt desc", async () => {
    const calls: Array<{ orderBy: unknown }> = [];
    const prisma = {
      mealPlanTemplate: {
        findMany: async (args: { orderBy: unknown }) => {
          calls.push(args);
          return [];
        },
      },
    } as unknown as PrismaClient;
    await resolvePlansForFilter(prisma, "featured", USER, new Date(), 10, null);
    assert.deepEqual(calls[0].orderBy, [
      { railPosition: { sort: "asc", nulls: "last" } },
      { createdAt: "desc" },
    ]);
    // Hosting keeps its order.
    await resolvePlansForFilter(prisma, "hosting_events", USER, new Date(), 10, null);
    assert.deepEqual(calls[1].orderBy, { createdAt: "desc" });
  });
});

describe("archived templates (BUG-403)", () => {
  it("cannot be adopted by id (use-template / sign-up share this copy)", async () => {
    let created = 0;
    const tx = {
      mealPlanTemplate: { findUnique: async () => ARCHIVED },
      mealPlanInstance: { create: async () => { created += 1; return {}; } },
    };
    const out = await copyTemplateForUser(tx as never, "t-arch", USER, async () => {});
    assert.equal(out.kind, "not_found");
    assert.equal(created, 0);
  });

  async function spin(prisma: unknown) {
    const app = express();
    app.use(express.json());
    app.use("/api", createPlansRouter({ prisma: withSessionUser(prisma) as never }));
    return await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const server: Server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${addr.port}/api`, close: () => new Promise((r) => server.close(() => r())) });
      });
    });
  }

  it("GET /plans/templates/:id → 404; POST /plans/use-template/:id → 404", async () => {
    const tx = {
      mealPlanTemplate: { findUnique: async () => ARCHIVED },
      mealPlanInstance: { create: async () => { throw new Error("must not create"); } },
    };
    const prisma = { ...tx, $transaction: async <T,>(cb: (t: typeof tx) => Promise<T>) => cb(tx) };
    const h = await spin(prisma);
    try {
      const auth = { Authorization: `Bearer ${signToken(USER)}` };
      const get = await fetch(`${h.url}/plans/templates/t-arch`, { headers: auth });
      assert.equal(get.status, 404);
      const use = await fetch(`${h.url}/plans/use-template/t-arch`, { method: "POST", headers: auth });
      assert.equal(use.status, 404);
    } finally {
      await h.close();
    }
  });
});
