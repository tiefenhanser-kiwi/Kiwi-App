// LIFE-2 — POST /me/activity/cook-finished, and requireAuth's lastActiveAt write.
//
// The route: auth; 400 on a bad body; 404 on a meal that is neither the user's
// nor public, and on a plan item that is not theirs or does not carry the meal;
// one cook_finished row; idempotent within a minute for the same meal and plan
// item. The stub models the activity table's rows so the dedupe reads what the
// route wrote.
//
// The writer: requireAuth stamps lastActiveAt fire-and-forget, once per user
// per hour per client; it never blocks the request and a failing write never
// fails it.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { signToken } from "../../lib/auth";
import { createLastActiveToucher, TOUCH_INTERVAL_MS } from "../../lib/lastActive";
import { createRequireAuth } from "../../middleware/auth";
import { COOK_FINISHED_DEDUPE_MS, createMeRouter } from "../me";
import { withSessionUser } from "./fixtures/sessionUserStub";

const USER = "life2-cook-user";
const OTHER = "life2-other-user";

interface ActivityRow {
  userId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
}

function stubPrisma() {
  const meals: Record<string, { isPublic: boolean; userId: string | null }> = {
    "mine-private": { isPublic: false, userId: USER },
    "catalog-public": { isPublic: true, userId: null },
    "theirs-private": { isPublic: false, userId: OTHER },
  };
  const items: Record<string, { mealId: string; owner: string }> = {
    "item-mine": { mealId: "mine-private", owner: USER },
    "item-catalog": { mealId: "catalog-public", owner: USER },
    "item-theirs": { mealId: "catalog-public", owner: OTHER },
  };
  const activities: ActivityRow[] = [];
  return {
    meal: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const m = meals[where.id];
        return m ? { id: where.id, ...m } : null;
      },
    },
    mealPlanItem: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const i = items[where.id];
        return i ? { mealId: i.mealId, planInstance: { userId: i.owner } } : null;
      },
    },
    userActivity: {
      findMany: async ({ where }: { where: { userId: string; eventType: string; entityId: string; createdAt: { gte: Date } } }) =>
        activities.filter(
          (a) =>
            a.userId === where.userId &&
            a.eventType === where.eventType &&
            a.entityId === where.entityId &&
            a.createdAt.getTime() >= where.createdAt.gte.getTime(),
        ),
      create: async ({ data }: { data: ActivityRow }) => {
        activities.push({ ...data, metadata: data.metadata ?? null });
        return data;
      },
    },
    _activities: activities,
  };
}

async function serve(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

async function harness(now: () => Date = () => new Date()) {
  const prisma = stubPrisma();
  const app = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma: withSessionUser(prisma) as never, now }));
  const h = await serve(app);
  const post = (body: unknown, token: string | null = signToken(USER)) =>
    fetch(`${h.url}/me/activity/cook-finished`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  return { prisma, post, close: h.close };
}

describe("LIFE-2 — POST /me/activity/cook-finished", () => {
  it("🔴 401 without a session; nothing written", async () => {
    const h = await harness();
    try {
      const res = await h.post({ mealId: "mine-private" }, null);
      assert.equal(res.status, 401);
      assert.equal(h.prisma._activities.length, 0);
    } finally {
      await h.close();
    }
  });

  it("400 on a missing or malformed mealId", async () => {
    const h = await harness();
    try {
      assert.equal((await h.post({})).status, 400);
      assert.equal((await h.post({ mealId: 42 })).status, 400);
      assert.equal((await h.post({ mealId: "mine-private", planItemId: "" })).status, 400);
      assert.equal(h.prisma._activities.length, 0);
    } finally {
      await h.close();
    }
  });

  it("201 for the user's own meal and for a public one: one cook_finished row each", async () => {
    const h = await harness();
    try {
      const a = await h.post({ mealId: "mine-private" });
      assert.equal(a.status, 201);
      assert.deepEqual(await a.json(), { recorded: true });
      assert.equal((await h.post({ mealId: "catalog-public", planItemId: "item-catalog" })).status, 201);
      assert.deepEqual(
        h.prisma._activities.map((r) => [r.userId, r.eventType, r.entityType, r.entityId, r.metadata]),
        [
          [USER, "cook_finished", "meal", "mine-private", null],
          [USER, "cook_finished", "meal", "catalog-public", { planItemId: "item-catalog" }],
        ],
      );
    } finally {
      await h.close();
    }
  });

  it("🔴 404 on a meal that isn't theirs (private to someone else) or doesn't exist — the same answer", async () => {
    const h = await harness();
    try {
      const theirs = await h.post({ mealId: "theirs-private" });
      const missing = await h.post({ mealId: "no-such-meal" });
      assert.equal(theirs.status, 404);
      assert.equal(missing.status, 404);
      assert.deepEqual(await theirs.json(), await missing.json());
      assert.equal(h.prisma._activities.length, 0);
    } finally {
      await h.close();
    }
  });

  it("🔴 404 on a plan item that is someone else's, missing, or for a different meal", async () => {
    const h = await harness();
    try {
      assert.equal((await h.post({ mealId: "catalog-public", planItemId: "item-theirs" })).status, 404);
      assert.equal((await h.post({ mealId: "catalog-public", planItemId: "no-such-item" })).status, 404);
      assert.equal((await h.post({ mealId: "catalog-public", planItemId: "item-mine" })).status, 404);
      assert.equal(h.prisma._activities.length, 0);
    } finally {
      await h.close();
    }
  });

  it("🔴 idempotent within a minute: the same cook again is 200 { recorded: false }, no second row", async () => {
    let clock = new Date("2026-10-26T23:00:00Z");
    const h = await harness(() => clock);
    try {
      assert.equal((await h.post({ mealId: "mine-private", planItemId: "item-mine" })).status, 201);
      clock = new Date(clock.getTime() + COOK_FINISHED_DEDUPE_MS - 1000);
      const again = await h.post({ mealId: "mine-private", planItemId: "item-mine" });
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { recorded: false });
      assert.equal(h.prisma._activities.length, 1);

      // Another plan item, or no plan item, is a different cook.
      assert.equal((await h.post({ mealId: "mine-private" })).status, 201);
      // A minute and a second after the first: a new cook of the same meal.
      clock = new Date(clock.getTime() + 2000);
      assert.equal((await h.post({ mealId: "mine-private", planItemId: "item-mine" })).status, 201);
      assert.equal(h.prisma._activities.length, 3);
    } finally {
      await h.close();
    }
  });
});

describe("LIFE-2 — lastActiveAt, written by requireAuth", () => {
  function userStub() {
    const writes: { id: string; at: Date }[] = [];
    let fail: "reject" | "throw" | null = null;
    let hold: Promise<void> | null = null;
    const sql: string[] = [];
    const stub = {
      user: {
        findUnique: async () => ({ tokensValidFrom: null }),
        // The users table's own writer: the touch must never go through it.
        updateMany: async () => {
          throw new Error("lastActiveAt must not be written through user.updateMany (it moves updatedAt)");
        },
        update: async () => {
          throw new Error("lastActiveAt must not be written through user.update (it moves updatedAt)");
        },
      },
      // Tagged template: values are [lastActiveAt, userId].
      $executeRaw: (strings: TemplateStringsArray, at: Date, id: string) => {
        if (fail === "throw") throw new Error("sync boom");
        sql.push(strings.join("?"));
        return (async () => {
          if (hold) await hold;
          if (fail === "reject") throw new Error("db down");
          writes.push({ id, at });
          return 1;
        })();
      },
    };
    return {
      stub,
      writes,
      sql,
      failWith: (f: typeof fail) => void (fail = f),
      holdWrites: (p: Promise<void> | null) => void (hold = p),
    };
  }

  it("🔴 at most once per user per hour; a second user is its own; the hour passing writes again", async () => {
    const s = userStub();
    let clock = new Date("2026-10-26T12:00:00Z");
    const t = createLastActiveToucher(s.stub as never, { now: () => clock });
    assert.equal(t.touch("u1"), true);
    for (let i = 0; i < 50; i++) assert.equal(t.touch("u1"), false);
    assert.equal(t.touch("u2"), true);
    clock = new Date(clock.getTime() + TOUCH_INTERVAL_MS - 1);
    assert.equal(t.touch("u1"), false);
    clock = new Date(clock.getTime() + 1);
    assert.equal(t.touch("u1"), true);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(s.writes.map((w) => w.id), ["u1", "u2", "u1"]);
    assert.deepEqual(s.writes.map((w) => w.at.toISOString()), [
      "2026-10-26T12:00:00.000Z",
      "2026-10-26T12:00:00.000Z",
      "2026-10-26T13:00:00.000Z",
    ]);
    // One column, nothing else: updatedAt is not touched.
    assert.equal(s.sql[0], `UPDATE "users" SET "lastActiveAt" = ? WHERE "id" = ?`);
  });

  it("🔴 a failing write (rejected or thrown) never throws, and is not retried every request", async () => {
    const s = userStub();
    const t = createLastActiveToucher(s.stub as never);
    s.failWith("reject");
    assert.doesNotThrow(() => t.touch("u1"));
    s.failWith("throw");
    assert.doesNotThrow(() => t.touch("u2"));
    assert.equal(t.touch("u1"), false, "armed before the write: one attempt per hour");
    await new Promise((r) => setImmediate(r));
    assert.equal(s.writes.length, 0);
  });

  it("🔴 through the real guard: the request is answered before the write finishes, and a failing write still answers 200", async () => {
    const s = userStub();
    let release!: () => void;
    s.holdWrites(new Promise<void>((r) => (release = r)));
    const app = express();
    // One client, many guards — as every router builds its own.
    const guardA = createRequireAuth({ prisma: s.stub as never });
    const guardB = createRequireAuth({ prisma: s.stub as never });
    app.get("/a", guardA, (_req, res) => void res.json({ ok: true }));
    app.get("/b", guardB, (_req, res) => void res.json({ ok: true }));
    const h = await serve(app);
    try {
      const auth = { Authorization: `Bearer ${signToken("guard-user")}` };
      const r1 = await fetch(`${h.url}/a`, { headers: auth });
      assert.equal(r1.status, 200, "answered while the write is still held");
      assert.equal(s.writes.length, 0);
      const r2 = await fetch(`${h.url}/b`, { headers: auth });
      assert.equal(r2.status, 200);
      release();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(s.writes.map((w) => w.id), ["guard-user"], "one write across both guards");

      s.failWith("throw");
      const r3 = await fetch(`${h.url}/a`, { headers: { Authorization: `Bearer ${signToken("other-user")}` } });
      assert.equal(r3.status, 200, "a throwing write never fails the request");
    } finally {
      await h.close();
    }
  });
});
