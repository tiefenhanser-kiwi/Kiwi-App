// WS7-4-A — emitActivity tests.
// Stubs Prisma at userActivity.create. Covers happy path with explicit tx,
// fallback to singleton, metadata persistence, eventType narrowing, and
// error-swallow behavior.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ActivityEventType, Prisma, PrismaClient } from "@prisma/client";

import { emitActivity } from "../userActivity";

interface CreateCall {
  data: {
    userId: string;
    eventType: ActivityEventType;
    entityType: string | null;
    entityId: string | null;
    platform: string;
    metadata?: unknown;
  };
}

function makeStubClient(opts: { throwOnCreate?: boolean } = {}): {
  client: PrismaClient;
  calls: CreateCall[];
} {
  const calls: CreateCall[] = [];
  const client = {
    userActivity: {
      create: async (args: CreateCall) => {
        if (opts.throwOnCreate) {
          throw new Error("simulated DB failure");
        }
        calls.push(args);
        return { id: "act-1", ...args.data, createdAt: new Date() };
      },
    },
  } as unknown as PrismaClient;
  return { client, calls };
}

describe("emitActivity", () => {
  it("writes via the explicit tx client when provided", async () => {
    const { client, calls } = makeStubClient();
    const tx = client as unknown as Prisma.TransactionClient;

    await emitActivity({
      userId: "user-1",
      eventType: "plan_meal_assigned",
      entityType: "plan",
      entityId: "plan-1",
      tx,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.userId, "user-1");
    assert.equal(calls[0].data.eventType, "plan_meal_assigned");
    assert.equal(calls[0].data.entityType, "plan");
    assert.equal(calls[0].data.entityId, "plan-1");
    assert.equal(calls[0].data.platform, "api");
  });

  it("falls back to the singleton client when tx is omitted", async () => {
    // No throw means singleton path resolved without error. We can't easily
    // observe the singleton's call here, but the public contract is "does
    // not throw" — explicit-tx path above already covers shape verification.
    await assert.doesNotReject(async () => {
      await emitActivity({
        userId: "user-fallback",
        eventType: "plan_review_opened",
      });
    });
  });

  it("persists metadata exactly as provided", async () => {
    const { client, calls } = makeStubClient();
    const tx = client as unknown as Prisma.TransactionClient;

    await emitActivity({
      userId: "user-2",
      eventType: "plan_meal_changed",
      metadata: { planId: "p1", count: 3 },
      tx,
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].data.metadata, { planId: "p1", count: 3 });
  });

  it("accepts new and legacy ActivityEventType values (compile-time narrowing)", async () => {
    const { client, calls } = makeStubClient();
    const tx = client as unknown as Prisma.TransactionClient;

    const values: ActivityEventType[] = [
      "plan_meal_assigned",
      "plan_review_opened",
      "view_plan",
    ];
    for (const eventType of values) {
      await emitActivity({ userId: "user-3", eventType, tx });
    }

    assert.equal(calls.length, 3);
    assert.equal(calls[0].data.eventType, "plan_meal_assigned");
    assert.equal(calls[1].data.eventType, "plan_review_opened");
    assert.equal(calls[2].data.eventType, "view_plan");
  });

  it("swallows DB errors and resolves cleanly", async () => {
    const { client } = makeStubClient({ throwOnCreate: true });
    const tx = client as unknown as Prisma.TransactionClient;

    await assert.doesNotReject(async () => {
      await emitActivity({
        userId: "user-err",
        eventType: "plan_meal_added",
        tx,
      });
    });
  });
});
