// WS7-2 Block A — /me/favorites endpoint tests.
// 9 tests: 3 endpoints (POST/DELETE/GET) x 3 cases (happy / idempotency / auth).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createMeRouter } from "../me";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

interface FavRow {
  id: string;
  userId: string;
  mealId: string;
  createdAt: Date;
}

function makeStubPrisma(opts: {
  meals?: Set<string>;
  initialFavorites?: FavRow[];
}) {
  const meals = opts.meals ?? new Set<string>();
  const favorites: FavRow[] = [...(opts.initialFavorites ?? [])];

  return {
    meal: {
      findUnique: async ({
        where,
      }: {
        where: { id: string };
      }): Promise<{ id: string } | null> => {
        return meals.has(where.id) ? { id: where.id } : null;
      },
    },
    favorite: {
      upsert: async ({
        where,
        create,
      }: {
        where: { userId_mealId: { userId: string; mealId: string } };
        update: Record<string, unknown>;
        create: { userId: string; mealId: string };
      }) => {
        const existing = favorites.find(
          (f) =>
            f.userId === where.userId_mealId.userId &&
            f.mealId === where.userId_mealId.mealId,
        );
        if (existing) return existing;
        const row: FavRow = {
          id: `fav-${favorites.length + 1}`,
          userId: create.userId,
          mealId: create.mealId,
          createdAt: new Date(`2026-05-19T0${favorites.length}:00:00Z`),
        };
        favorites.push(row);
        return row;
      },
      deleteMany: async ({
        where,
      }: {
        where: { userId?: string; mealId: string };
      }): Promise<{ count: number }> => {
        const before = favorites.length;
        for (let i = favorites.length - 1; i >= 0; i--) {
          if (
            favorites[i].userId === where.userId &&
            favorites[i].mealId === where.mealId
          ) {
            favorites.splice(i, 1);
          }
        }
        return { count: before - favorites.length };
      },
      findMany: async ({
        where,
        orderBy,
      }: {
        where: { userId?: string };
        orderBy: { createdAt: "desc" | "asc" };
        select: unknown;
      }) => {
        const filtered = favorites.filter((f) => f.userId === where.userId);
        const sorted = filtered.sort((a, b) =>
          orderBy.createdAt === "desc"
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return sorted.map((f) => ({ mealId: f.mealId }));
      },
    },
    _favorites: () => favorites,
  };
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma: prisma as never }));

  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

const USER_ID = "test-user-favorites";

describe("POST /me/favorites", () => {
  it("happy: creates a favorite and returns 201", async () => {
    const prisma = makeStubPrisma({ meals: new Set(["meal-1"]) });
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/favorites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ mealId: "meal-1" }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        favorite: { id: string; mealId: string; createdAt: string };
      };
      assert.equal(body.favorite.mealId, "meal-1");
      assert.ok(body.favorite.id);
      assert.ok(body.favorite.createdAt);
    } finally {
      await harness.close();
    }
  });

  it("idempotent: re-favoriting returns the existing row, no duplicate", async () => {
    const prisma = makeStubPrisma({ meals: new Set(["meal-1"]) });
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const body = JSON.stringify({ mealId: "meal-1" });
      const r1 = await fetch(`${harness.baseUrl}/me/favorites`, {
        method: "POST",
        headers,
        body,
      });
      const r2 = await fetch(`${harness.baseUrl}/me/favorites`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(r1.status, 201);
      assert.equal(r2.status, 201);
      const b1 = (await r1.json()) as { favorite: { id: string } };
      const b2 = (await r2.json()) as { favorite: { id: string } };
      assert.equal(b1.favorite.id, b2.favorite.id);
      assert.equal(prisma._favorites().length, 1);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when meal does not exist", async () => {
    const prisma = makeStubPrisma({ meals: new Set() });
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/favorites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ mealId: "ghost-meal" }),
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });
});

describe("DELETE /me/favorites/:mealId", () => {
  it("happy: removes an existing favorite and returns success", async () => {
    const prisma = makeStubPrisma({
      meals: new Set(["meal-1"]),
      initialFavorites: [
        { id: "f1", userId: USER_ID, mealId: "meal-1", createdAt: new Date() },
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/favorites/meal-1`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      assert.equal(prisma._favorites().length, 0);
    } finally {
      await harness.close();
    }
  });

  it("idempotent: deleting a non-existent favorite still returns success", async () => {
    const prisma = makeStubPrisma({ meals: new Set(["meal-1"]) });
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/favorites/meal-1`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { success: boolean };
      assert.equal(body.success, true);
    } finally {
      await harness.close();
    }
  });

  it("rejects 401 when no auth header is present", async () => {
    const prisma = makeStubPrisma({ meals: new Set(["meal-1"]) });
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/favorites/meal-1`, {
        method: "DELETE",
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

describe("GET /me/favorites", () => {
  it("happy: returns mealIds in newest-first order", async () => {
    const prisma = makeStubPrisma({
      meals: new Set(["m1", "m2", "m3"]),
      initialFavorites: [
        { id: "f-old", userId: USER_ID, mealId: "m1", createdAt: new Date("2026-01-01") },
        { id: "f-mid", userId: USER_ID, mealId: "m2", createdAt: new Date("2026-03-15") },
        { id: "f-new", userId: USER_ID, mealId: "m3", createdAt: new Date("2026-05-10") },
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/favorites`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { favorites: string[] };
      assert.deepEqual(body.favorites, ["m3", "m2", "m1"]);
    } finally {
      await harness.close();
    }
  });

  it("returns an empty array when the user has no favorites", async () => {
    const prisma = makeStubPrisma({});
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/favorites`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { favorites: string[] };
      assert.deepEqual(body.favorites, []);
    } finally {
      await harness.close();
    }
  });

  it("rejects 401 when no auth header is present", async () => {
    const prisma = makeStubPrisma({});
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/favorites`);
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});
