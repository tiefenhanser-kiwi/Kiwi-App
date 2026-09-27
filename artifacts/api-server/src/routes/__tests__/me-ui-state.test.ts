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

function makeStubPrisma(
  // Row 13 · Block 1b B2 — the stored nudge stamp, so the write-if-null guard
  // has something to be guarded against. Null = never dismissed.
  seed: { personalizeNudgeDismissedAt?: Date | null } = {},
) {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const updateManyCalls: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = [];
  const row = {
    personalizeNudgeDismissedAt: seed.personalizeNudgeDismissedAt ?? null,
  };
  return {
    user: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return { id: args.where.id };
      },
      // D-WS9-263 — markPersonalizeNudgeDismissed is an updateMany carrying a
      // `personalizeNudgeDismissedAt: null` predicate (the lib/firstPlan.ts
      // write-if-null pattern). The stub EVALUATES that predicate against the
      // modelled row rather than assuming it matches, so the idempotency test
      // is testing the guard and not the stub.
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        updateManyCalls.push(args);
        if (args.where.id !== USER_ID) return { count: 0 };
        if (
          "personalizeNudgeDismissedAt" in args.where &&
          args.where.personalizeNudgeDismissedAt === null &&
          row.personalizeNudgeDismissedAt !== null
        ) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    _updates: updates,
    _updateManyCalls: updateManyCalls,
    _row: () => row,
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

// ── Row 13 · Block 1b B2 / D-WS9-263 — personalizeNudgeDismissed ───────────
//
// R2: the Home personalize card can be dismissed for good. Same wire shape as
// playlistCtaTapped above — the client sends the FACT, the server stamps the
// time — with one difference that is the whole point of this block:
//
//   THE STAMP IS WRITE-IF-NULL. It records WHEN the user stopped needing the
//   nudge, so a second call must not move it. A "dismissed at" that advances on
//   every client retry is a fact about the retry, not about the user.
//
// The card's [Later] button never reaches this route: later is per-DEVICE and
// lives on the client (see lib/personalizeNudge.ts).
describe("PATCH /me/ui-state — personalizeNudgeDismissed (D-WS9-263)", () => {
  it("stamps personalizeNudgeDismissedAt with a server Date, through the GUARDED write", async () => {
    const prisma = makeStubPrisma();
    const harness = await spinUp(prisma);
    try {
      const before = Date.now();
      const res = await patch(harness, { personalizeNudgeDismissed: true });
      assert.equal(res.status, 200);

      // It goes through updateMany, carrying the null predicate — not through
      // the plain update, where it could not be guarded.
      assert.equal(prisma._updateManyCalls.length, 1);
      const call = prisma._updateManyCalls[0];
      assert.equal(call.where.id, USER_ID);
      assert.equal(
        call.where.personalizeNudgeDismissedAt,
        null,
        "the write-if-null predicate is what makes it idempotent",
      );
      const stamp = call.data.personalizeNudgeDismissedAt;
      assert.ok(stamp instanceof Date, "a server Date, not client time");
      assert.ok(stamp.getTime() >= before && stamp.getTime() <= Date.now());

      // And the wire flag never reaches the row through the unguarded update.
      const plain = prisma._updates[0]?.data ?? {};
      assert.equal("personalizeNudgeDismissed" in plain, false);
      assert.equal("personalizeNudgeDismissedAt" in plain, false);
    } finally {
      await harness.close();
    }
  });

  it("🔴 IDEMPOTENT: a second call does NOT move the timestamp", async () => {
    const prisma = makeStubPrisma();
    const harness = await spinUp(prisma);
    try {
      assert.equal(
        (await patch(harness, { personalizeNudgeDismissed: true })).status,
        200,
      );
      const first = prisma._row().personalizeNudgeDismissedAt;
      assert.ok(first instanceof Date);

      // A retry, a second device, a double-tap — all the same request.
      const res = await patch(harness, { personalizeNudgeDismissed: true });
      assert.equal(res.status, 200, "still a success; nothing is wrong");
      assert.equal(
        prisma._row().personalizeNudgeDismissedAt,
        first,
        "the first dismissal wins and the stamp does not advance",
      );
      assert.equal(prisma._updateManyCalls.length, 2, "both calls really ran");
    } finally {
      await harness.close();
    }
  });

  it("the flag is one-way: false, a timestamp, and a bare column name are 400", async () => {
    const prisma = makeStubPrisma();
    const harness = await spinUp(prisma);
    try {
      for (const body of [
        { personalizeNudgeDismissed: false },
        { personalizeNudgeDismissed: "2026-09-27T10:00:00.000Z" },
        { personalizeNudgeDismissedAt: "2026-09-27T10:00:00.000Z" },
      ]) {
        assert.equal(
          (await patch(harness, body)).status,
          400,
          JSON.stringify(body),
        );
      }
      assert.equal(prisma._updateManyCalls.length, 0);
      assert.equal(prisma._updates.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("rides alongside the other ui-state fields without disturbing them", async () => {
    const prisma = makeStubPrisma();
    const harness = await spinUp(prisma);
    try {
      const res = await patch(harness, {
        lastMealsFilters: ["my_meals"],
        playlistCtaTapped: true,
        personalizeNudgeDismissed: true,
      });
      assert.equal(res.status, 200);
      // The two older fields still take the plain update, unchanged.
      const data = prisma._updates[0].data;
      assert.deepEqual(data.lastMealsFilters, ["my_meals"]);
      assert.ok(data.playlistCtaTappedAt instanceof Date);
      // The nudge took its own guarded write.
      assert.equal(prisma._updateManyCalls.length, 1);
      assert.ok(prisma._row().personalizeNudgeDismissedAt instanceof Date);
    } finally {
      await harness.close();
    }
  });
});
