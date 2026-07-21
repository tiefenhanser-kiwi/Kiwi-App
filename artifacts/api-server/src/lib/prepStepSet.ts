// WS7-8a Block 3 (D-WS7-153) — deterministic prep step-set loader.
//
// Returns the CODE-OWNED step set (stable stepKey + per-step contributesToMealIds)
// for a plan WITHOUT any AI call. This is the "freshly assembled step set" the
// per-meal prep derivation joins checked stepKeys against (see prepCompletion).
//
// Why recompute instead of reading the cached PrepWeekStructure.structureJson:
// an all-easy plan (every ingredient denylisted/buy-and-use) produces ZERO prep
// steps, so the generate route returns 400 and writes NO structure row — which
// is indistinguishable from a never-generated plan if you read the cache. The
// ruling (D-WS7-153) requires an all-easy plan to roll up to `prepped` (a meal
// that needs no prep is ready to cook) while a fresh prep-worthy plan must read
// `not_prepped`. Only recomputing the deterministic step set tells the two
// apart: all-easy → [] (→ vacuously prepped), fresh-with-prep → N steps (→ not
// prepped until checked). Keys are code-owned + stable, so checks made against
// the displayed (cached) steps line up with the recomputed set for the current
// plan content.

import type { PrismaClient } from "@prisma/client";

import {
  loadPrepWeekInput as productionLoadPrepWeekInput,
  PrepWeekEmptyPlanError,
  PrepWeekNotFoundError,
} from "./prepWeekAggregation";
import { buildPrepCombineInput } from "./prepCombineAdapter";
import { combinePrep } from "./prepCombineEngine";
import { buildStepPlan } from "./prepWeekAssembly";

// Minimal per-step shape the derivation needs (matches derivePrepCompletion).
export interface PrepStepRef {
  stepKey: string;
  contributesToMealIds: string[];
}

export interface LoadPrepStepSetParams {
  planId: string;
  userId: string;
  prisma: PrismaClient;
  // Injectable for tests / to reuse a router's already-wired loader.
  loadPrepWeekInput?: typeof productionLoadPrepWeekInput;
}

// WS7-8b Block 2 (D-WS7-184) — Mechanism 2 flag overlay. The AI-free recompute
// above cannot see the narration-time `skipSuggested` flag, but
// assemblePrepWeekResult already persisted it onto every demoted step inside
// PrepWeekStructure.structureJson (cooking.ts generate path). Read that blob and
// return the set of stepKeys the narrator demoted, so the required-set can drop
// them (BUG-013 / server-exclude half of BUG-015).
//
// DEGRADES TO KEEP-DEFAULT on any absence/malformation — never throws, never
// excludes when uncertain:
//   • no structure row (never generated / all-easy plan) → empty set → nothing
//     excluded (and with no structure nothing is checked either, so the meal is
//     correctly not_prepped, not falsely prepped);
//   • stale structure → stepKeys are stable across regenerate (same ingredient →
//     same key), so old flags still map; a genuinely-new key simply isn't in the
//     old blob → kept, matching the narrator's own "when unsure, KEEP";
//   • malformed/partial JSON → treated as no demotions.
//
// MIXED-BLEND GUARD (D-WS7-183): holds by construction — the narrator never sets
// `skipSuggested` on an `isBlend` step (aiPrompts.ts), so a
// `seasonings_dry#dish#<dishId>` blend key can never carry the flag and is never
// added here. We only ever collect keys where `skipSuggested === true`.
export function demotedStepKeysFromStructure(structureJson: unknown): Set<string> {
  const demoted = new Set<string>();
  const structure = structureJson as
    | { phases?: unknown }
    | null
    | undefined;
  if (!structure || !Array.isArray(structure.phases)) return demoted;
  for (const phase of structure.phases as unknown[]) {
    const steps = (phase as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps as unknown[]) {
      const s = step as { stepKey?: unknown; skipSuggested?: unknown } | null;
      if (
        s &&
        s.skipSuggested === true &&
        typeof s.stepKey === "string" &&
        s.stepKey.length > 0
      ) {
        demoted.add(s.stepKey);
      }
    }
  }
  return demoted;
}

export async function loadPrepStepSet(
  params: LoadPrepStepSetParams,
): Promise<PrepStepRef[]> {
  const load = params.loadPrepWeekInput ?? productionLoadPrepWeekInput;
  try {
    const { input } = await load({
      planId: params.planId,
      userId: params.userId,
      prisma: params.prisma,
      // D-WS9-049 A2.1 — this path builds the step set from ingredients only
      // (buildStepPlan below is called WITHOUT step text), so skip the two
      // RecipeInstructionStep queries loadPrepWeekInput would otherwise run.
      includeStepTexts: false,
    });
    const stepPlan = buildStepPlan(
      combinePrep(buildPrepCombineInput(input)),
      input.planName,
    );
    const refs = stepPlan.steps.map((s) => ({
      stepKey: s.stepKey,
      contributesToMealIds: s.contributesToMealIds,
    }));

    // WS7-8b Block 2 (D-WS7-184) — overlay the persisted `skipSuggested` flags
    // from the cached structure and drop demoted steps from the required-set.
    // The read is best-effort: a failure to reach the cache must not 5xx the
    // rollup, so treat any error as "no demotions" (KEEP-default).
    let demoted: Set<string>;
    try {
      const cached = await params.prisma.prepWeekStructure.findUnique({
        where: { planId: params.planId },
      });
      demoted = demotedStepKeysFromStructure(cached?.structureJson);
    } catch {
      demoted = new Set<string>();
    }
    return demoted.size === 0
      ? refs
      : refs.filter((r) => !demoted.has(r.stepKey));
  } catch (err) {
    // No cookable meals (empty) or non-owner/missing → no prep steps. The
    // caller's meal universe still drives the (vacuous) per-meal rollup; an
    // empty step set means every meal is vacuously prepped.
    if (
      err instanceof PrepWeekEmptyPlanError ||
      err instanceof PrepWeekNotFoundError
    ) {
      return [];
    }
    throw err;
  }
}
