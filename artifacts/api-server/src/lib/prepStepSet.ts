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

export async function loadPrepStepSet(
  params: LoadPrepStepSetParams,
): Promise<PrepStepRef[]> {
  const load = params.loadPrepWeekInput ?? productionLoadPrepWeekInput;
  try {
    const { input } = await load({
      planId: params.planId,
      userId: params.userId,
      prisma: params.prisma,
    });
    const stepPlan = buildStepPlan(
      combinePrep(buildPrepCombineInput(input)),
      input.planName,
    );
    return stepPlan.steps.map((s) => ({
      stepKey: s.stepKey,
      contributesToMealIds: s.contributesToMealIds,
    }));
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
