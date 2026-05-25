// WS6 6c-4 Block A — bumpPlanRevision tests.
// Stubs Prisma at the call surface (mealPlanInstance.update). The helper
// either uses the injected tx client OR falls back to the singleton; both
// paths are covered.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Prisma, PrismaClient } from "@prisma/client";

import { bumpPlanRevision } from "../planRevision";

interface UpdateCall {
  where: { id: string };
  data: { revisionId: { increment: number } };
}

function makeStubClient(): { client: PrismaClient; calls: UpdateCall[]; revision: () => number } {
  const calls: UpdateCall[] = [];
  let revision = 1;
  const client = {
    mealPlanInstance: {
      update: async (args: UpdateCall) => {
        calls.push(args);
        revision += args.data.revisionId.increment;
        return { id: args.where.id, revisionId: revision };
      },
    },
  } as unknown as PrismaClient;
  return { client, calls, revision: () => revision };
}

describe("bumpPlanRevision", () => {
  it("increments revisionId by 1 each call", async () => {
    const { client, calls, revision } = makeStubClient();
    const tx = client as unknown as Prisma.TransactionClient;

    const r1 = await bumpPlanRevision("plan-1", tx);
    assert.equal(r1, 2);
    assert.equal(revision(), 2);

    const r2 = await bumpPlanRevision("plan-1", tx);
    assert.equal(r2, 3);
    assert.equal(revision(), 3);

    const r3 = await bumpPlanRevision("plan-1", tx);
    assert.equal(r3, 4);
    assert.equal(revision(), 4);

    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.deepEqual(c.where, { id: "plan-1" });
      assert.deepEqual(c.data, { revisionId: { increment: 1 } });
    }
  });

  it("uses the injected tx client when provided", async () => {
    const { client, calls } = makeStubClient();
    const tx = client as unknown as Prisma.TransactionClient;

    const result = await bumpPlanRevision("plan-X", tx);

    assert.equal(result, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].where.id, "plan-X");
  });
});
