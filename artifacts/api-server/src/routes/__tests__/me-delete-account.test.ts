// D-WS9-257 — DELETE /me, the route that replaced deactivate/reactivate.
//
// The stub below is deliberately NOT a bag of no-op deleteMany spies. It
// models the FOREIGN KEY RULES the real database enforces, read out of
// prisma/migrations rather than inferred from Prisma's defaults (the two
// disagree: Prisma's default for an optional relation is SET NULL, and the
// generated SQL agrees, but the required ones are RESTRICT and a stub that
// treats them as cascades would pass while the route failed in production):
//
//   RESTRICT on users — grocery_lists, meal_plan_instances,
//     meal_plan_templates, retailer_connections, order_sessions. `user.delete`
//     THROWS a Prisma-shaped P2003 if any survive. This is what makes the
//     deliberate break in the task RED rather than silently green.
//   SET NULL on users — meals, dishes, llm_call_logs. `user.delete` does NOT
//     throw; it nulls the column. So removing the meal/dish deleteMany cannot
//     be caught by an FK — it is caught by the explicit "no orphans" assertion
//     at the end of the happy-path test, which is the whole reason that
//     assertion is written as a separate claim.
//   CASCADE on users — favorites, user_preferences, user_activities et al.
//   NO FK AT ALL — notification_preferences, used_tokens and
//     recipe_instruction_steps (owner link is application-layer). The stub
//     leaves these completely untouched by `user.delete`, because the database
//     does, which is what makes their explicit deletes testable.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createMeRouter } from "../me";

const USER_ID = "delete-me-user";
const OTHER_ID = "delete-me-other";

interface Row {
  [k: string]: unknown;
  userId?: string | null;
}

interface State {
  users: { id: string; tokensValidFrom: Date | null }[];
  meals: Row[];
  dishes: Row[];
  steps: { id: string; ownerType: string; ownerId: string }[];
  groceryLists: Row[];
  planInstances: Row[];
  planTemplates: Row[];
  retailerConnections: Row[];
  orderSessions: Row[];
  notificationPreferences: Row[];
  usedTokens: Row[];
  llmCalls: Row[];
  favorites: Row[];
  preferences: Row[];
}

function makeState(): State {
  return {
    users: [
      { id: USER_ID, tokensValidFrom: null },
      { id: OTHER_ID, tokensValidFrom: null },
    ],
    meals: [
      {
        id: "meal-own-1",
        userId: USER_ID,
        imageUrl: "https://storage.googleapis.com/kiwi-images/meal-own-1.jpg",
      },
      { id: "meal-own-2", userId: USER_ID, imageUrl: null },
      { id: "meal-other", userId: OTHER_ID, imageUrl: null },
    ],
    dishes: [
      {
        id: "dish-own-1",
        userId: USER_ID,
        imageUrl: "https://storage.googleapis.com/kiwi-images/dish-own-1.jpg",
      },
      { id: "dish-other", userId: OTHER_ID, imageUrl: null },
    ],
    steps: [
      { id: "step-1", ownerType: "meal", ownerId: "meal-own-1" },
      { id: "step-2", ownerType: "dish", ownerId: "dish-own-1" },
      { id: "step-other", ownerType: "meal", ownerId: "meal-other" },
    ],
    groceryLists: [{ id: "gl-1", userId: USER_ID }, { id: "gl-other", userId: OTHER_ID }],
    planInstances: [{ id: "pi-1", userId: USER_ID }],
    planTemplates: [{ id: "pt-1", userId: USER_ID }],
    retailerConnections: [{ id: "rc-1", userId: USER_ID }],
    orderSessions: [{ id: "os-1", userId: USER_ID }],
    notificationPreferences: [{ id: "np-1", userId: USER_ID }],
    usedTokens: [{ jti: "jti-1", userId: USER_ID }, { jti: "jti-other", userId: OTHER_ID }],
    llmCalls: [
      { id: "llm-1", userId: USER_ID, inputTokens: 10 },
      { id: "llm-other", userId: OTHER_ID, inputTokens: 5 },
    ],
    favorites: [{ id: "fav-1", userId: USER_ID }],
    preferences: [{ id: "prefs-1", userId: USER_ID }],
  };
}

/** Prisma's FK-violation shape. The route must not swallow it as a 204. */
function fkViolation(table: string): Error {
  return Object.assign(
    new Error(`Foreign key constraint violated on the constraint: ${table}_userId_fkey`),
    { code: "P2003", meta: { field_name: `${table}_userId_fkey (index)` } },
  );
}

function makeStubPrisma(state: State) {
  const deleteManyBy =
    (rows: Row[]) =>
    async ({ where }: { where: { userId?: string } }) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].userId === where.userId) {
          rows.splice(i, 1);
          count++;
        }
      }
      return { count };
    };

  const findManyBy =
    (rows: Row[]) =>
    async ({ where }: { where: { userId?: string } }) =>
      rows.filter((r) => r.userId === where.userId);

  // RESTRICT tables, in the order the database would complain about them.
  const restrict: [string, () => Row[]][] = [
    ["grocery_lists", () => state.groceryLists],
    ["meal_plan_instances", () => state.planInstances],
    ["meal_plan_templates", () => state.planTemplates],
    ["retailer_connections", () => state.retailerConnections],
    ["order_sessions", () => state.orderSessions],
  ];

  return {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.users.find((u) => u.id === where.id) ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        for (const [table, get] of restrict) {
          if (get().some((r) => r.userId === where.id)) throw fkViolation(table);
        }
        // SET NULL — the class that does NOT fail loudly.
        for (const r of state.meals) if (r.userId === where.id) r.userId = null;
        for (const r of state.dishes) if (r.userId === where.id) r.userId = null;
        for (const r of state.llmCalls) if (r.userId === where.id) r.userId = null;
        // CASCADE.
        await deleteManyBy(state.favorites)({ where: { userId: where.id } });
        await deleteManyBy(state.preferences)({ where: { userId: where.id } });
        // NO FK — notification_preferences / used_tokens / steps survive here.
        const idx = state.users.findIndex((u) => u.id === where.id);
        if (idx < 0) throw Object.assign(new Error("Record to delete does not exist."), {
          code: "P2025",
        });
        const [row] = state.users.splice(idx, 1);
        return row;
      },
    },
    meal: { findMany: findManyBy(state.meals), deleteMany: deleteManyBy(state.meals) },
    dish: { findMany: findManyBy(state.dishes), deleteMany: deleteManyBy(state.dishes) },
    mealPlanTemplate: {
      findMany: findManyBy(state.planTemplates),
      deleteMany: deleteManyBy(state.planTemplates),
    },
    mealPlanInstance: { deleteMany: deleteManyBy(state.planInstances) },
    groceryList: { deleteMany: deleteManyBy(state.groceryLists) },
    retailerConnection: { deleteMany: deleteManyBy(state.retailerConnections) },
    orderSession: { deleteMany: deleteManyBy(state.orderSessions) },
    notificationPreference: { deleteMany: deleteManyBy(state.notificationPreferences) },
    usedToken: { deleteMany: deleteManyBy(state.usedTokens) },
    recipeInstructionStep: {
      deleteMany: async ({ where }: { where: { ownerId: { in: string[] } } }) => {
        const ids = new Set(where.ownerId.in);
        let count = 0;
        for (let i = state.steps.length - 1; i >= 0; i--) {
          if (ids.has(state.steps[i].ownerId)) {
            state.steps.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
    },
    lLMCallLog: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId?: string };
        data: { userId: null };
      }) => {
        let count = 0;
        for (const r of state.llmCalls) {
          if (r.userId === where.userId) {
            r.userId = data.userId;
            count++;
          }
        }
        return { count };
      },
    },
    // The array form of $transaction: every element is already a promise by the
    // time it arrives, so this runs them in order and surfaces the first throw,
    // which is exactly the failure the FK break has to produce.
    $transaction: async (ops: Promise<unknown>[]) => {
      const out: unknown[] = [];
      for (const op of ops) out.push(await op);
      return out;
    },
  };
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(
  prisma: unknown,
  // Row 9 (1.1) · Stripe S1 Part E — the Stripe cancel seam. Omitted by every
  // pre-existing case in this file, so they keep the production default, which
  // finds no customer on these fixtures and does nothing.
  opts: { cancelStripeForUser?: unknown } = {},
): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(
    createMeRouter({
      prisma: prisma as never,
      ...(opts.cancelStripeForUser
        ? { cancelStripeForUser: opts.cancelStripeForUser as never }
        : {}),
    }),
  );
  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

async function del(
  harness: Harness,
  body: unknown,
  token: string | null = signToken(USER_ID),
): Promise<Response> {
  return await fetch(`${harness.baseUrl}/me`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("DELETE /me (D-WS9-257)", () => {
  beforeEach(() => {
    // The limiter is 3/hour per user and every case here uses the same id.
    __clearRateLimitStoreForTests();
  });

  it("204s and leaves no row of the user's in any table", async () => {
    const state = makeState();
    const harness = await spinUp(makeStubPrisma(state));
    try {
      const res = await del(harness, { confirm: "delete" });
      assert.equal(res.status, 204, await res.text());
      assert.equal(await res.text(), "", "204 carries no body");

      // The user row itself.
      assert.deepEqual(
        state.users.map((u) => u.id),
        [OTHER_ID],
      );

      // The RESTRICT class. If any of these had survived, user.delete would
      // have thrown P2003 and the response would be a 500, not a 204 — which
      // is the deliberate break this file is built to make red.
      assert.deepEqual(
        state.groceryLists.map((r) => r.userId),
        [OTHER_ID],
      );
      assert.equal(state.planInstances.length, 0);
      assert.equal(state.planTemplates.length, 0);
      assert.equal(state.retailerConnections.length, 0);
      assert.equal(state.orderSessions.length, 0);

      // The FK-less class. Nothing in the database would ever remove these, so
      // a green here can only be the route's own explicit delete.
      assert.equal(state.notificationPreferences.length, 0);
      assert.deepEqual(
        state.usedTokens.map((r) => r.userId),
        [OTHER_ID],
      );
      assert.deepEqual(
        state.steps.map((s) => s.id),
        ["step-other"],
        "the user's application-layer step rows are gone; another user's stay",
      );

      // The SET NULL class — the dangerous one. The FK does NOT fail here, so
      // dropping the meal/dish deleteMany would leave `userId: null` rows
      // behind and every other assertion in this test would still pass. THIS
      // is the claim that catches it: nothing survives un-owned.
      assert.deepEqual(
        state.meals.map((m) => m.id),
        ["meal-other"],
        "no orphaned meal survives the deletion",
      );
      assert.deepEqual(
        state.dishes.map((d) => d.id),
        ["dish-other"],
        "no orphaned dish survives the deletion",
      );
      assert.equal(
        state.meals.concat(state.dishes).filter((r) => r.userId === null).length,
        0,
      );

      // The cost ledger is KEPT and de-identified — the one thing that must
      // NOT be deleted.
      assert.deepEqual(
        state.llmCalls.map((r) => [r.id, r.userId]),
        [
          ["llm-1", null],
          ["llm-other", OTHER_ID],
        ],
      );
    } finally {
      await harness.close();
    }
  });

  it("400 confirm_required on a wrong or missing confirm word, and deletes nothing", async () => {
    for (const body of [{}, { confirm: "DELETE" }, { confirm: true }, { confirm: "deactivate" }]) {
      __clearRateLimitStoreForTests();
      const state = makeState();
      const harness = await spinUp(makeStubPrisma(state));
      try {
        const res = await del(harness, body);
        assert.equal(res.status, 400, `body ${JSON.stringify(body)}`);
        assert.equal(((await res.json()) as { error: string }).error, "confirm_required");
        assert.equal(state.users.length, 2, "nothing was deleted");
        assert.equal(state.meals.length, 3);
        assert.equal(state.groceryLists.length, 2);
      } finally {
        await harness.close();
      }
    }
  });

  it("401s without a token", async () => {
    const state = makeState();
    const harness = await spinUp(makeStubPrisma(state));
    try {
      const res = await del(harness, { confirm: "delete" }, null);
      assert.equal(res.status, 401);
      assert.equal(state.users.length, 2);
    } finally {
      await harness.close();
    }
  });

  it("rate-limits at 3 per user per hour", async () => {
    const harness = await spinUp(makeStubPrisma(makeState()));
    try {
      // Four BAD bodies: they never reach the transaction, so the only thing
      // under test is the bucket. 400, 400, 400, then 429.
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await del(harness, {})).status);
      assert.deepEqual(codes, [400, 400, 400, 429]);
    } finally {
      await harness.close();
    }
  });
});

// ── B3 — a token whose user row is gone authenticates nothing ────────────
//
// Not a route test: the claim is about requireAuth, and the route is only the
// probe. Before D-WS9-257 this was a 204 on the SECOND delete — the row was
// gone, the JWT was still signed and unexpired, and the guard read "no row" as
// "nothing to revoke". The stub's user.findUnique returns null for the deleted
// id, which is exactly what the real Prisma returns.
describe("requireAuth after deletion (D-WS9-257 / BUG-234 widening)", () => {
  beforeEach(() => __clearRateLimitStoreForTests());

  it("401s every authenticated route once the user row is gone", async () => {
    const state = makeState();
    const harness = await spinUp(makeStubPrisma(state));
    try {
      const token = signToken(USER_ID);
      assert.equal((await del(harness, { confirm: "delete" }, token)).status, 204);

      // The SAME token, still signed, still unexpired, still in the keychain.
      const replay = await del(harness, { confirm: "delete" }, token);
      assert.equal(replay.status, 401, "a deleted user's live JWT must not authenticate");
      assert.equal(
        ((await replay.json()) as { error: string }).error,
        "invalid or expired token",
      );

      // And on a route that has nothing to do with deletion.
      const other = await fetch(`${harness.baseUrl}/me/preferences`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(other.status, 401);
    } finally {
      await harness.close();
    }
  });
});

// ── Row 9 (1.1) · Stripe S1 Part E — the Stripe cancellation ─────────────
//
// Same shape and same ruling as the Apple revoke this route already does
// (D-WS9-257, best-effort): it runs BEFORE the delete, because the customer and
// subscription ids live on the `subscriptions` row that cascades with the user,
// and it CANNOT fail the deletion.
//
// ⚠️ The failure here costs more than Apple's. An un-revoked Apple token is a
// privacy loose end; an un-cancelled Stripe subscription KEEPS CHARGING A CARD
// for an account that no longer exists, and the person cannot log in to reach the
// Portal. So the "it throws and we still delete" test is not a nicety — it is the
// assertion that a Stripe outage cannot trap someone in an account they asked to
// leave, and its companion asserts the attempt is made exactly once so nobody is
// tempted to add a retry loop in front of a deletion.

describe("DELETE /me cancels Stripe first, best-effort (Stripe S1 Part E)", () => {
  beforeEach(() => {
    __clearRateLimitStoreForTests();
  });

  it("calls the cancel seam ONCE, before the delete, and still 204s", async () => {
    const state = makeState();
    const calls: Array<{ userId: string }> = [];
    let userStillPresentAtCancel: boolean | null = null;
    const harness = await spinUp(makeStubPrisma(state), {
      cancelStripeForUser: async ({ userId }: { userId: string }) => {
        calls.push({ userId });
        // The ORDER is the claim: the row the cancel reads its ids from must
        // still exist when it runs.
        userStillPresentAtCancel = state.users.some((u) => u.id === userId);
        return { hadCustomer: true, cancelled: true, customerDeleted: true, skipped: [] };
      },
    });
    try {
      const res = await del(harness, { confirm: "delete" });
      assert.equal(res.status, 204);
      assert.equal(calls.length, 1, "exactly once — a deletion is not a place for a retry loop");
      assert.equal(calls[0].userId, USER_ID);
      assert.equal(userStillPresentAtCancel, true, "cancel ran BEFORE the delete");
      assert.equal(state.users.some((u) => u.id === USER_ID), false, "and the user is gone");
    } finally {
      await harness.close();
    }
  });

  it("STILL DELETES when the cancel throws — a Stripe outage cannot trap someone in an account", async () => {
    const state = makeState();
    const harness = await spinUp(makeStubPrisma(state), {
      cancelStripeForUser: async () => {
        throw new Error("stripe is having a day");
      },
    });
    try {
      const res = await del(harness, { confirm: "delete" });
      assert.equal(res.status, 204, "the deletion is not conditional on a third party");
      assert.equal(state.users.some((u) => u.id === USER_ID), false);
      // And the other user is untouched, as ever.
      assert.equal(state.users.some((u) => u.id === OTHER_ID), true);
    } finally {
      await harness.close();
    }
  });

  it("still deletes when the cancel reports a SKIP rather than throwing", async () => {
    const state = makeState();
    const harness = await spinUp(makeStubPrisma(state), {
      cancelStripeForUser: async () => ({
        hadCustomer: true,
        cancelled: false,
        customerDeleted: false,
        skipped: ["cancel_failed"],
      }),
    });
    try {
      assert.equal((await del(harness, { confirm: "delete" })).status, 204);
      assert.equal(state.users.some((u) => u.id === USER_ID), false);
    } finally {
      await harness.close();
    }
  });

  it("a REFUSED confirmation does not touch Stripe — nothing is cancelled for a 400", async () => {
    const state = makeState();
    let called = 0;
    const harness = await spinUp(makeStubPrisma(state), {
      cancelStripeForUser: async () => {
        called++;
        return { hadCustomer: false, cancelled: false, customerDeleted: false, skipped: [] };
      },
    });
    try {
      const res = await del(harness, { confirm: "nope" });
      assert.equal(res.status, 400);
      assert.equal(called, 0, "a rejected confirmation must not cancel anybody's subscription");
      assert.equal(state.users.some((u) => u.id === USER_ID), true);
    } finally {
      await harness.close();
    }
  });
});
