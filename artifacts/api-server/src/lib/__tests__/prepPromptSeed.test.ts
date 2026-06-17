// WS7-8a Block 2 — prep.narrate_steps seed idempotency.
// Exercises the real seedAIPrompts against an in-memory prisma stub: the new
// narration prompt seeds with its authored body, the retired aggregation key is
// swept, and a second run is a no-op (no new versions).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { seedAIPrompts } from "../../../prisma/seeds/aiPrompts";

interface VersionRow {
  id: string;
  promptId: string;
  version: number;
  body: string;
  isActive: boolean;
}

function makeSeedPrismaStub() {
  const prompts = new Map<string, { id: string; key: string }>();
  const versions: VersionRow[] = [];
  let seq = 0;
  const id = () => `id-${++seq}`;
  let createCalls = 0;
  const deleteManyKeys: string[][] = [];

  const prisma = {
    aIPrompt: {
      upsert: async ({
        where,
        create,
      }: {
        where: { key: string };
        create: { key: string };
      }) => {
        let row = prompts.get(where.key);
        if (!row) {
          row = { id: id(), key: create.key };
          prompts.set(where.key, row);
        }
        return { id: row.id };
      },
      deleteMany: async ({ where }: { where: { key: { in: string[] } } }) => {
        deleteManyKeys.push(where.key.in);
        let count = 0;
        for (const k of where.key.in) {
          if (prompts.delete(k)) count++;
        }
        return { count };
      },
    },
    aIPromptVersion: {
      findFirst: async ({
        where,
      }: {
        where: { promptId: string; isActive: boolean };
      }) => {
        const v = versions.find(
          (r) => r.promptId === where.promptId && r.isActive === where.isActive,
        );
        return v ? { id: v.id, version: v.version, body: v.body } : null;
      },
      aggregate: async ({ where }: { where: { promptId: string } }) => {
        const vs = versions.filter((r) => r.promptId === where.promptId);
        const max = vs.length ? Math.max(...vs.map((r) => r.version)) : null;
        return { _max: { version: max } };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { promptId: string; isActive: boolean };
        data: { isActive: boolean };
      }) => {
        let count = 0;
        for (const r of versions) {
          if (r.promptId === where.promptId && r.isActive === where.isActive) {
            r.isActive = data.isActive;
            count++;
          }
        }
        return { count };
      },
      create: async ({ data }: { data: Omit<VersionRow, "id"> }) => {
        createCalls++;
        const row: VersionRow = { id: id(), ...data };
        versions.push(row);
        return row;
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  } as unknown as PrismaClient;

  return {
    prisma,
    prompts,
    versions,
    deleteManyKeys,
    createCalls: () => createCalls,
  };
}

describe("seedAIPrompts — prep.narrate_steps", () => {
  it("seeds the narration prompt, retires the old key, and is idempotent", async () => {
    const stub = makeSeedPrismaStub();

    await seedAIPrompts(stub.prisma);

    // New key exists with an active, authored (non-placeholder) body.
    const prompt = stub.prompts.get("prep.narrate_steps");
    assert.ok(prompt, "prep.narrate_steps prompt should be seeded");
    const active = stub.versions.find(
      (v) => v.promptId === prompt.id && v.isActive,
    );
    assert.ok(active, "an active version should exist");
    assert.match(active.body, /Prep the Week narrator/);
    assert.match(active.body, /\{\{prepNarrationInput\}\}/);

    // Old aggregation key is gone (swept via RETIRED_KEYS) and never re-seeded.
    assert.equal(stub.prompts.has("prep.aggregation_logic"), false);
    assert.ok(
      stub.deleteManyKeys.some((keys) => keys.includes("prep.aggregation_logic")),
      "retired sweep should target prep.aggregation_logic",
    );

    // Second run: bodies already match active → zero new version rows.
    const createsAfterFirst = stub.createCalls();
    await seedAIPrompts(stub.prisma);
    assert.equal(
      stub.createCalls(),
      createsAfterFirst,
      "re-seeding should create no new versions (idempotent)",
    );
  });
});
