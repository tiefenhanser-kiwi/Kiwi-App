// WS9 Redesign Arc Block 1 — /me/playlist (D-WS9-234 / D-WS9-244).
//
// GET lists the user's playlist as Pick-screen cards (real, owned ids);
// POST forks a public catalog meal on acquire (D-WS7-139) and stores the
// FORK's id — a second add of the same catalog meal resolves to the existing
// fork by lineage; an owned meal is stored as-is (idempotent on the unique);
// anyone else's private meal is 403; DELETE is 204 and idempotent and never
// deletes the meal.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createPlaylistRouter } from "../playlist";
import { withSessionUser } from "./fixtures/sessionUserStub";

const U = "playlist-user";

interface MealRow {
  id: string;
  userId: string | null;
  isPublic: boolean;
  isArchived?: boolean;
  sourceStoreMealId?: string | null;
  title?: string;
}
interface PlaylistRow {
  id: string;
  userId: string;
  mealId: string;
  createdAt: Date;
}

function makeStub(opts: { meals: MealRow[]; playlist?: PlaylistRow[] }) {
  const meals = new Map(opts.meals.map((m) => [m.id, { ...m }]));
  const playlist: PlaylistRow[] = [...(opts.playlist ?? [])];
  const forks: string[] = [];
  let forkN = 0;
  let rowN = playlist.length;
  const mealDeletes: string[] = [];

  const card = (m: MealRow) => ({
    id: m.id,
    title: m.title ?? `T-${m.id}`,
    description: null,
    cuisineType: "italian",
    difficulty: "easy",
    estimatedTimeMinutes: 40,
    activeTimeMinutes: 20,
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
    tags: ["quick"],
    sourceStoreMealId: m.sourceStoreMealId ?? null,
    isPublic: m.isPublic,
    userId: m.userId,
    _count: { dishLinks: 3 },
  });

  const client = {
    meal: {
      findUnique: async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
        const m = meals.get(args.where.id);
        if (!m) return null;
        if (args.select && "isArchived" in args.select) {
          return { id: m.id, userId: m.userId, isPublic: m.isPublic, isArchived: m.isArchived ?? false };
        }
        // The fork helper's deep read (dishes omitted — clone fidelity is mealFork.test.ts).
        return {
          id: m.id,
          userId: m.userId,
          title: m.title ?? `T-${m.id}`,
          displayTitle: null,
          description: null,
          mealType: "dinner",
          sourceType: "curated",
          cuisineType: null,
          difficulty: "easy",
          estimatedTimeMinutes: 40,
          activeTimeMinutes: 20,
          imageUrl: null,
          servingsDefault: 4,
          authoredServingsDefault: 4,
          tags: [],
          allergens: [],
          allergensStampedAt: null,
          allergenSources: null,
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
          dishLinks: [],
        };
      },
      create: async (args: { data: { sourceStoreMealId?: string; userId: string; isPublic: boolean } }) => {
        forkN += 1;
        const id = `fork-${forkN}`;
        forks.push(args.data.sourceStoreMealId ?? "?");
        meals.set(id, {
          id,
          userId: args.data.userId,
          isPublic: args.data.isPublic,
          sourceStoreMealId: args.data.sourceStoreMealId ?? null,
          title: `T-${args.data.sourceStoreMealId}`,
        });
        return { id };
      },
      deleteMany: async (args: { where: { id: string } }) => {
        mealDeletes.push(args.where.id);
        return { count: 0 };
      },
    },
    recipeInstructionStep: { findMany: async () => [] },
    userPreferences: { findUnique: async () => null },
    playlistMeal: {
      findMany: async (args: { where: { userId: string } }) =>
        playlist
          .filter((p) => p.userId === args.where.userId)
          .filter((p) => !(meals.get(p.mealId)?.isArchived ?? false))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((p) => ({ createdAt: p.createdAt, meal: card(meals.get(p.mealId)!) })),
      findFirst: async (args: {
        where: { userId: string; meal: { sourceStoreMealId: string } };
      }) => {
        const hit = playlist.find(
          (p) =>
            p.userId === args.where.userId &&
            meals.get(p.mealId)?.sourceStoreMealId === args.where.meal.sourceStoreMealId,
        );
        return hit ? { id: hit.id, mealId: hit.mealId, createdAt: hit.createdAt } : null;
      },
      upsert: async (args: {
        where: { userId_mealId: { userId: string; mealId: string } };
        create: { userId: string; mealId: string };
      }) => {
        const k = args.where.userId_mealId;
        const existing = playlist.find((p) => p.userId === k.userId && p.mealId === k.mealId);
        if (existing) return { id: existing.id, mealId: existing.mealId, createdAt: existing.createdAt };
        rowN += 1;
        const row: PlaylistRow = {
          id: `pl-${rowN}`,
          userId: args.create.userId,
          mealId: args.create.mealId,
          createdAt: new Date(2026, 8, 1 + rowN),
        };
        playlist.push(row);
        return { id: row.id, mealId: row.mealId, createdAt: row.createdAt };
      },
      deleteMany: async (args: { where: { userId: string; mealId: string } }) => {
        const before = playlist.length;
        for (let i = playlist.length - 1; i >= 0; i--) {
          if (playlist[i].userId === args.where.userId && playlist[i].mealId === args.where.mealId) {
            playlist.splice(i, 1);
          }
        }
        return { count: before - playlist.length };
      },
    },
  };
  return {
    prisma: {
      ...client,
      $transaction: async <T,>(cb: (tx: typeof client) => Promise<T>) => cb(client),
    },
    forks,
    playlist,
    mealDeletes,
  };
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}
async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createPlaylistRouter({ prisma: withSessionUser(prisma) as never }));
  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) return reject(new Error("no bind"));
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

const H = (userId = U) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${signToken(userId)}`,
});

const MEALS: MealRow[] = [
  { id: "cat-1", userId: null, isPublic: true, title: "Catalog One" },
  { id: "cat-2", userId: null, isPublic: true, title: "Catalog Two" },
  { id: "own-1", userId: U, isPublic: false, title: "My Chili" },
  { id: "own-2", userId: U, isPublic: false, title: "My Salad" },
  { id: "theirs", userId: "someone-else", isPublic: false },
  { id: "gone", userId: null, isPublic: true, isArchived: true },
];

describe("POST /api/me/playlist", () => {
  it("public catalog meal → fork-on-acquire, stores the FORK id; a second add resolves by lineage (no second fork)", async () => {
    const s = makeStub({ meals: MEALS });
    const h = await spinUp(s.prisma);
    try {
      const r1 = await fetch(`${h.baseUrl}/me/playlist`, {
        method: "POST",
        headers: H(),
        body: JSON.stringify({ mealId: "cat-1" }),
      });
      assert.equal(r1.status, 201);
      const b1 = (await r1.json()) as { playlistMeal: Record<string, unknown> };
      assert.equal(b1.playlistMeal.mealId, "fork-1");
      assert.equal(b1.playlistMeal.sourceMealId, "cat-1");
      assert.equal(b1.playlistMeal.forked, true);
      assert.deepEqual(s.forks, ["cat-1"]);

      const r2 = await fetch(`${h.baseUrl}/me/playlist`, {
        method: "POST",
        headers: H(),
        body: JSON.stringify({ mealId: "cat-1" }),
      });
      assert.equal(r2.status, 201);
      const b2 = (await r2.json()) as { playlistMeal: Record<string, unknown> };
      assert.equal(b2.playlistMeal.mealId, "fork-1", "resolved to the existing fork");
      assert.equal(b2.playlistMeal.forked, false);
      assert.deepEqual(s.forks, ["cat-1"], "no second fork");
      assert.equal(s.playlist.length, 1);
    } finally {
      await h.close();
    }
  });

  it("owned meal → stored as-is, idempotent on the unique", async () => {
    const s = makeStub({ meals: MEALS });
    const h = await spinUp(s.prisma);
    try {
      for (let i = 0; i < 2; i++) {
        const r = await fetch(`${h.baseUrl}/me/playlist`, {
          method: "POST",
          headers: H(),
          body: JSON.stringify({ mealId: "own-1" }),
        });
        assert.equal(r.status, 201);
        const b = (await r.json()) as { playlistMeal: Record<string, unknown> };
        assert.equal(b.playlistMeal.mealId, "own-1");
        assert.equal(b.playlistMeal.sourceMealId, null);
      }
      assert.deepEqual(s.forks, []);
      assert.equal(s.playlist.length, 1);
    } finally {
      await h.close();
    }
  });

  it("403 for another user's private meal; 404 for missing / archived; 400 for a bad body; 401 unauthenticated", async () => {
    const s = makeStub({ meals: MEALS });
    const h = await spinUp(s.prisma);
    try {
      const post = (body: unknown, headers: Record<string, string> = H()) =>
        fetch(`${h.baseUrl}/me/playlist`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.equal((await post({ mealId: "theirs" })).status, 403);
      assert.equal((await post({ mealId: "nope" })).status, 404);
      assert.equal((await post({ mealId: "gone" })).status, 404);
      assert.equal((await post({})).status, 400);
      assert.equal((await post({ mealId: "own-1" }, { "Content-Type": "application/json" })).status, 401);
      assert.equal(s.playlist.length, 0);
      assert.deepEqual(s.forks, []);
    } finally {
      await h.close();
    }
  });
});

describe("GET /api/me/playlist", () => {
  it("lists the user's playlist as cards, newest first, with count", async () => {
    const s = makeStub({
      meals: MEALS,
      playlist: [
        { id: "pl-1", userId: U, mealId: "own-1", createdAt: new Date("2026-09-01T00:00:00Z") },
        { id: "pl-2", userId: U, mealId: "own-2", createdAt: new Date("2026-09-05T00:00:00Z") },
        { id: "pl-3", userId: "other", mealId: "own-2", createdAt: new Date("2026-09-06T00:00:00Z") },
      ],
    });
    const h = await spinUp(s.prisma);
    try {
      const r = await fetch(`${h.baseUrl}/me/playlist`, { headers: H() });
      assert.equal(r.status, 200);
      const b = (await r.json()) as { playlist: Array<Record<string, unknown>>; count: number };
      assert.equal(b.count, 2);
      assert.deepEqual(
        b.playlist.map((m) => m.id),
        ["own-2", "own-1"],
      );
      const card = b.playlist[0];
      assert.equal(card.title, "My Salad");
      assert.equal(card.estimatedTimeMinutes, 40);
      assert.equal(card.activeTimeMinutes, 20);
      assert.deepEqual(card.macrosPerServing, { calories: 500, protein: 30, carbs: 40, fat: 20 });
      assert.deepEqual(card.tags, ["quick"]);
      assert.equal(card.dishCount, 3);
      assert.equal(card.isPlaylist, true);
      assert.equal(card.source, "playlist");
      assert.equal(typeof card.addedAt, "string");
    } finally {
      await h.close();
    }
  });

  it("empty playlist → [] and count 0; 401 unauthenticated", async () => {
    const s = makeStub({ meals: MEALS });
    const h = await spinUp(s.prisma);
    try {
      const r = await fetch(`${h.baseUrl}/me/playlist`, { headers: H() });
      assert.deepEqual(await r.json(), { playlist: [], count: 0 });
      assert.equal((await fetch(`${h.baseUrl}/me/playlist`)).status, 401);
    } finally {
      await h.close();
    }
  });
});

describe("DELETE /api/me/playlist/:mealId", () => {
  it("removes the entry (204), is idempotent, and never deletes the meal", async () => {
    const s = makeStub({
      meals: MEALS,
      playlist: [{ id: "pl-1", userId: U, mealId: "own-1", createdAt: new Date() }],
    });
    const h = await spinUp(s.prisma);
    try {
      const r1 = await fetch(`${h.baseUrl}/me/playlist/own-1`, { method: "DELETE", headers: H() });
      assert.equal(r1.status, 204);
      assert.equal(s.playlist.length, 0);
      const r2 = await fetch(`${h.baseUrl}/me/playlist/own-1`, { method: "DELETE", headers: H() });
      assert.equal(r2.status, 204);
      assert.deepEqual(s.mealDeletes, []);
      assert.equal((await fetch(`${h.baseUrl}/me/playlist/own-1`, { method: "DELETE" })).status, 401);
    } finally {
      await h.close();
    }
  });
});
