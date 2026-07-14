// WS9 Block 3a / D-WS9-026 — markFirstPlanCreated write-if-null contract.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Prisma } from "@prisma/client";
import { markFirstPlanCreated } from "../firstPlan";

test("markFirstPlanCreated: updateMany guards on firstPlanCreatedAt = null (write-if-null, first wins)", async () => {
  const calls: Array<{ where: unknown; data: unknown }> = [];
  const tx = {
    user: {
      updateMany: async (args: { where: unknown; data: unknown }) => {
        calls.push(args);
        return { count: 1 };
      },
    },
  } as unknown as Prisma.TransactionClient;

  await markFirstPlanCreated(tx, "user-abc");

  assert.equal(calls.length, 1);
  const { where, data } = calls[0] as {
    where: { id: string; firstPlanCreatedAt: null };
    data: { firstPlanCreatedAt: Date };
  };
  // The null predicate is what makes it a *first*, not a *latest*.
  assert.equal(where.id, "user-abc");
  assert.equal(where.firstPlanCreatedAt, null);
  assert.ok(data.firstPlanCreatedAt instanceof Date);
});
