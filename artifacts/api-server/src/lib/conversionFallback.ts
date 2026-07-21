// WS7-8b Block B2 — runtime conversion AI-fallback (self-populating catalog).
//
// When quantity→grams misses the shared table (no curated/usda_derived
// conversionRef AND no code-table row) for a unit that NEEDS a factor
// (volume/count), this asks Haiku for the reusable density/count factors,
// writes them back to Ingredient.conversionRef STAMPED source:'ai_estimated',
// and returns them. The stamp is load-bearing: it keeps an AI guess auditable
// and sweepable in the shared catalog instead of laundering it as curated data
// (the July-11 ruling). Weight units never reach here (they convert with no
// factor); genuinely unmappable units ("to taste") aren't attempted.

import type { Prisma } from "@prisma/client";
import type Anthropic from "@anthropic-ai/sdk";

import { runAICall as productionRunAICall } from "./ai/runAICall";
import type { PrismaLike } from "./ai/promptRegistry";
import { ConversionFillResultSchema } from "./ai/schemas/macros";
import {
  lookupConversion,
  parseConversionRef,
  type IngredientConversion,
} from "./ingredientConversions";

// The fallback needs the runAICall surface (PrismaLike) plus — for write-back —
// the ingredient delegate. `ingredient` is OPTIONAL so pure runAICall test
// stubs (PrismaLike) still satisfy the type; production passes a full
// PrismaClient and the write-back fires. Without it the fallback still grounds
// the estimate; it just doesn't self-populate the catalog.
export type ConversionFallbackPrisma = PrismaLike & {
  ingredient?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update(args: any): Promise<unknown>;
  };
};

export interface ResolveConversionOptions {
  prisma: ConversionFallbackPrisma;
  userId: string;
  client?: Pick<Anthropic, "messages">;
  // Test seam — production omits and uses the module runAICall.
  runAICall?: typeof productionRunAICall;
}

export interface ConversionTarget {
  ingredientId: string | null;
  canonicalName: string;
  conversionRef: unknown;
}

/**
 * Resolve an ingredient's conversion, filling a table miss via Haiku and
 * writing the result back (stamped ai_estimated). Precedence: persisted
 * conversionRef → curated code table → AI fallback. Returns null when the AI
 * fails or yields no usable factor (caller then leaves the estimate to guess).
 * Never throws — a fallback failure is best-effort and non-fatal.
 */
export async function resolveConversionWithFallback(
  target: ConversionTarget,
  opts: ResolveConversionOptions,
): Promise<IngredientConversion | null> {
  const existing =
    parseConversionRef(target.conversionRef) ?? lookupConversion(target.canonicalName);
  if (existing) return existing;

  const runAICall = opts.runAICall ?? productionRunAICall;
  let result;
  try {
    result = await runAICall(
      "nutrition.gap_fill_conversion",
      { conversionFillInput: { canonicalName: target.canonicalName } },
      ConversionFillResultSchema,
      // D-WS9-053 §1 — temp 0: this factor is WRITTEN BACK into the shared
      // Ingredient.conversionRef (stamped ai_estimated) and reused by every
      // future meal + grocery calc, so a sampled draw would persist noise into
      // shared catalog data. A conversion factor is a deterministic lookup, not
      // a creative output. (The global runAICall default stays 0.7 for prose.)
      { prisma: opts.prisma, userId: opts.userId, client: opts.client, temperature: 0 },
    );
  } catch {
    return null;
  }
  if (!result.success) return null;

  const { gramsPerCup, gramsPerEach, confidence } = result.data;
  if (gramsPerCup == null && gramsPerEach == null) return null;

  const conv: IngredientConversion = { source: "ai_estimated", confidence };
  if (gramsPerCup != null) conv.gramsPerCup = gramsPerCup;
  if (gramsPerEach != null) conv.gramsPerEach = gramsPerEach;

  // Self-populate the shared catalog so the next read hits the cache. Best-
  // effort: a write failure must not fail the macro estimate.
  if (target.ingredientId && opts.prisma.ingredient) {
    try {
      await opts.prisma.ingredient.update({
        where: { id: target.ingredientId },
        data: { conversionRef: conv as unknown as Prisma.InputJsonValue },
      });
    } catch {
      /* non-fatal — the value still grounds this estimate */
    }
  }
  return conv;
}
