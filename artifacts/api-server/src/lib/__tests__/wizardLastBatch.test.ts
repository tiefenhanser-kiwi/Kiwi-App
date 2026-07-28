// Plan-Gen Arc Block 4b-3 (D-WS9-072) — wizardLastBatch helper unit tests.
// Exercises the persist/read seam against a Map-backed stub Prisma so the
// single-row-per-user upsert ("generation clears") and the null-safe read are
// pinned without a real database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  persistWizardLastBatch,
  readWizardLastBatch,
} from "../wizardLastBatch";
import type { WizardPlanCandidate } from "../ai/schemas/wizard";

interface StoredRow {
  userId: string;
  payload: unknown;
  source: string;
  createdAt: Date;
}

// A Map-backed wizardLastBatch delegate: upsert keyed by userId enforces exactly
// one row per user (the schema's @unique), and records how many creates vs
// updates fired so the overwrite path is verifiable.
function makeStore() {
  const rows = new Map<string, StoredRow>();
  let creates = 0;
  let updates = 0;
  const prisma = {
    wizardLastBatch: {
      upsert: async (args: {
        where: { userId: string };
        create: { userId: string; payload: unknown; source: string };
        update: { payload: unknown; source: string; createdAt: Date };
      }) => {
        const existing = rows.get(args.where.userId);
        if (existing) {
          updates++;
          rows.set(args.where.userId, {
            ...existing,
            payload: args.update.payload,
            source: args.update.source,
            createdAt: args.update.createdAt,
          });
        } else {
          creates++;
          rows.set(args.where.userId, {
            userId: args.where.userId,
            payload: args.create.payload,
            source: args.create.source,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          });
        }
        return rows.get(args.where.userId);
      },
      findUnique: async (args: { where: { userId: string } }) =>
        rows.get(args.where.userId) ?? null,
    },
  };
  return { prisma, rows, stats: () => ({ creates, updates }) };
}

const CANDIDATES: WizardPlanCandidate[] = [
  {
    id: "c1",
    title: "Cozy Comfort Week",
    tags: ["Comfort"],
    whyBullets: ["one-pot meals"],
    mealTitles: ["Soup", "Chili", "Stew", "Bake", "Skillet"],
    dailyMacros: { calories: 540, proteinG: 28, carbsG: 56, fatG: 22 },
  },
];

describe("persistWizardLastBatch", () => {
  it("creates then OVERWRITES — exactly one row per user (generation clears)", async () => {
    const store = makeStore();
    await persistWizardLastBatch({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: store.prisma as any,
      userId: "u1",
      source: "wizard",
      candidates: CANDIDATES,
      input: { planDurationDays: 5 },
    });
    await persistWizardLastBatch({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: store.prisma as any,
      userId: "u1",
      source: "surprise",
      candidates: [],
      input: null,
    });

    // One row, not two — the second generation replaced the first.
    assert.equal(store.rows.size, 1);
    assert.equal(store.stats().creates, 1);
    assert.equal(store.stats().updates, 1);

    // The surviving row is the SECOND batch.
    const row = store.rows.get("u1")!;
    assert.equal(row.source, "surprise");
    const payload = row.payload as { source: string; candidates: unknown[]; input: unknown };
    assert.equal(payload.source, "surprise");
    assert.equal(payload.candidates.length, 0);
    assert.equal(payload.input, null);
  });

  it("round-trips candidates + input in the payload", async () => {
    const store = makeStore();
    await persistWizardLastBatch({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: store.prisma as any,
      userId: "u2",
      source: "wizard",
      candidates: CANDIDATES,
      input: { planDurationDays: 5, householdSize: 4 },
    });
    const payload = store.rows.get("u2")!.payload as {
      candidates: WizardPlanCandidate[];
      input: { householdSize: number };
    };
    assert.equal(payload.candidates[0].id, "c1");
    assert.equal(payload.candidates[0].mealTitles.length, 5);
    assert.equal(payload.input.householdSize, 4);
  });

  it("swallows a persist failure (best-effort — must not sink the response)", async () => {
    const prisma = {
      wizardLastBatch: {
        upsert: async () => {
          throw new Error("db down");
        },
      },
    };
    // Must resolve, not reject.
    await persistWizardLastBatch({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      userId: "u3",
      source: "wizard",
      candidates: CANDIDATES,
      input: null,
    });
    assert.ok(true);
  });
});

describe("readWizardLastBatch", () => {
  it("returns null when the user has no batch", async () => {
    const store = makeStore();
    const record = await readWizardLastBatch({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: store.prisma as any,
      userId: "nobody",
    });
    assert.equal(record, null);
  });

  it("returns the stored record with a parsed payload", async () => {
    const store = makeStore();
    await persistWizardLastBatch({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: store.prisma as any,
      userId: "u4",
      source: "tellkiwi",
      candidates: CANDIDATES,
      input: { description: "easy week" },
    });
    const record = await readWizardLastBatch({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: store.prisma as any,
      userId: "u4",
    });
    assert.ok(record);
    assert.equal(record!.source, "tellkiwi");
    assert.equal(record!.payload.candidates.length, 1);
    assert.equal(
      (record!.payload.input as { description: string }).description,
      "easy week",
    );
  });

  it("degrades a read failure to null", async () => {
    const prisma = {
      wizardLastBatch: {
        findUnique: async () => {
          throw new Error("db down");
        },
      },
    };
    const record = await readWizardLastBatch({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      userId: "u5",
    });
    assert.equal(record, null);
  });
});
