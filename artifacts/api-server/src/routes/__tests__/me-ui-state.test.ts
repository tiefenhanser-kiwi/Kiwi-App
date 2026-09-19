// Row 5 · Block 4 (D-WS9-247 amendment) — PATCH /me/ui-state, the per-user
// "Set up my Playlist" tapped flag.
//
// The route had no test of its own before this (the filter fields it carries
// are covered indirectly by the screens that read them). What is pinned here:
//   1. `playlistCtaTapped: true` becomes a SERVER-side `playlistCtaTappedAt`
//      stamp on the user row — the client never supplies a time;
//   2. the flag is one-way: `false`, a timestamp, or any other value is 400;
//   3. the filter fields still write exactly as before, alone or beside it;
//   4. an empty body is still 400.
//
// Same lightweight harness as me-preferences.test.ts (real JWT, prisma
// stubbed at the factory deps boundary, no DB).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createMeRouter } from "../me";
import { withSessionUser } from "./fixtures/sessionUserStub";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

const USER_ID = "test-user-ui-state";

function makeStubPrisma() {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  return {
    user: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return { id: args.where.id };
      },
    },
    _updates: updates,
  };
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma: withSessionUser(prisma) as never }));
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
          new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

function patch(harness: Harness, body: unknown) {
  return fetch(`${harness.baseUrl}/me/ui-state`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signToken(USER_ID)}`,
    },
    body: JSON.stringify(body),
  });
}

describe("PATCH /me/ui-state — playlistCtaTapped (D-WS9-247 amendment)", () => {
  it("`playlistCtaTapped: true` stamps playlistCtaTappedAt with a server Date on the user row", async () => {
    const prisma = makeStubPrisma();
    const harness = await spinUp(prisma);
    try {
      const before = Date.now();
      const res = await patch(harness, { playlistCtaTapped: true });
      assert.equal(res.status, 200);
      assert.equal(prisma._updates.length, 1);
      const { where, data } = prisma._updates[0];
      assert.equal(where.id, USER_ID);
      // The wire flag is NOT written through; the stamp is.
      assert.equal("playlistCtaTapped" in data, false, "the boolean must not reach the row");
      const stamp = data.playlistCtaTappedAt;
      assert.ok(stamp instanceof Date, "playlistCtaTappedAt is a Date");
      assert.ok(stamp.getTime() >= before && stamp.getTime() <= Date.now(), "stamped now, server-side");
      assert.deepEqual(Object.keys(data), ["playlistCtaTappedAt"]);
    } finally {
      await harness.close();
    }
  });

  it("the flag is one-way: `false`, a string timestamp, and a bare playlistCtaTappedAt are all 400 and write nothing", async () => {
    const prisma = makeStubPrisma();
    const harness = await spinUp(prisma);
    try {
      for (const body of [
        { playlistCtaTapped: false },
        { playlistCtaTapped: "2026-09-18T20:00:00.000Z" },
        { playlistCtaTappedAt: "2026-09-18T20:00:00.000Z" },
      ]) {
        const res = await patch(harness, body);
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.equal(prisma._updates.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("filter fields still write as before, alone or beside the flag", async () => {
    const prisma = makeStubPrisma();
    const harness = await spinUp(prisma);
    try {
      let res = await patch(harness, { lastMealsFilters: ["my_meals"] });
      assert.equal(res.status, 200);
      assert.deepEqual(prisma._updates[0].data, { lastMealsFilters: ["my_meals"] });

      res = await patch(harness, { lastPlansFilters: ["featured"], playlistCtaTapped: true });
      assert.equal(res.status, 200);
      const data = prisma._updates[1].data;
      assert.deepEqual(data.lastPlansFilters, ["featured"]);
      assert.ok(data.playlistCtaTappedAt instanceof Date);
    } finally {
      await harness.close();
    }
  });

  it("an empty body is still 400", async () => {
    const prisma = makeStubPrisma();
    const harness = await spinUp(prisma);
    try {
      const res = await patch(harness, {});
      assert.equal(res.status, 400);
      assert.equal(prisma._updates.length, 0);
    } finally {
      await harness.close();
    }
  });
});
