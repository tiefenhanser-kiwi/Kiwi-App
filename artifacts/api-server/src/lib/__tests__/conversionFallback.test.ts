// WS7-8b B2 — runtime conversion AI-fallback tests. Mocked runAICall; no live AI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveConversionWithFallback,
  type ConversionFallbackPrisma,
} from "../conversionFallback";

// Minimal PrismaLike-shaped stub; `ingredient.update` records write-backs.
function makeStub() {
  const updates: Array<{ id: string; conversionRef: unknown }> = [];
  const prisma = {
    aIPrompt: { findUnique: async () => null },
    systemSetting: { findUnique: async () => null },
    lLMCallLog: { create: async () => ({}) },
    ingredient: {
      update: async (args: { where: { id: string }; data: { conversionRef: unknown } }) => {
        updates.push({ id: args.where.id, conversionRef: args.data.conversionRef });
        return {};
      },
    },
  } as unknown as ConversionFallbackPrisma;
  return { prisma, updates };
}

function aiOk(data: unknown) {
  return async () => ({ success: true as const, data }) as never;
}
function aiFail() {
  return async () => ({ success: false as const, userFacingMessage: "x" }) as never;
}

describe("resolveConversionWithFallback", () => {
  it("returns the persisted conversionRef without calling the AI", async () => {
    const { prisma } = makeStub();
    let called = false;
    const conv = await resolveConversionWithFallback(
      { ingredientId: "i1", canonicalName: "whatever", conversionRef: { gramsPerCup: 50, source: "curated" } },
      { prisma, userId: "u", runAICall: (async () => { called = true; return { success: true, data: {} } as never; }) },
    );
    assert.equal(conv?.gramsPerCup, 50);
    assert.equal(called, false);
  });

  it("falls back to the curated code table before the AI", async () => {
    const { prisma } = makeStub();
    let called = false;
    const conv = await resolveConversionWithFallback(
      { ingredientId: "i1", canonicalName: "parmesan", conversionRef: null },
      { prisma, userId: "u", runAICall: (async () => { called = true; return { success: true, data: {} } as never; }) },
    );
    assert.equal(conv?.gramsPerCup, 100); // curated parmesan
    assert.equal(conv?.source, "curated");
    assert.equal(called, false);
  });

  it("on a full miss: AI-fills, stamps ai_estimated, and writes back", async () => {
    const { prisma, updates } = makeStub();
    const conv = await resolveConversionWithFallback(
      { ingredientId: "ing-99", canonicalName: "obscure grain", conversionRef: null },
      { prisma, userId: "u", runAICall: aiOk({ gramsPerCup: 185, gramsPerEach: null, confidence: "medium" }) },
    );
    assert.deepEqual(conv, { source: "ai_estimated", confidence: "medium", gramsPerCup: 185 });
    // write-back happened, stamped
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "ing-99");
    assert.equal((updates[0].conversionRef as { source: string }).source, "ai_estimated");
  });

  it("returns null (no write) on AI failure", async () => {
    const { prisma, updates } = makeStub();
    const conv = await resolveConversionWithFallback(
      { ingredientId: "i1", canonicalName: "x", conversionRef: null },
      { prisma, userId: "u", runAICall: aiFail() },
    );
    assert.equal(conv, null);
    assert.equal(updates.length, 0);
  });

  it("returns null when the AI yields no usable factor", async () => {
    const { prisma, updates } = makeStub();
    const conv = await resolveConversionWithFallback(
      { ingredientId: "i1", canonicalName: "x", conversionRef: null },
      { prisma, userId: "u", runAICall: aiOk({ gramsPerCup: null, gramsPerEach: null, confidence: "low" }) },
    );
    assert.equal(conv, null);
    assert.equal(updates.length, 0);
  });

  it("skips write-back when there is no ingredientId (unpersisted)", async () => {
    const { prisma, updates } = makeStub();
    const conv = await resolveConversionWithFallback(
      { ingredientId: null, canonicalName: "x", conversionRef: null },
      { prisma, userId: "u", runAICall: aiOk({ gramsPerCup: 120, gramsPerEach: null, confidence: "high" }) },
    );
    assert.equal(conv?.gramsPerCup, 120);
    assert.equal(updates.length, 0);
  });
});
