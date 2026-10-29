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
import {
  buildCoreWeek,
  buildFeastSession,
  FEAST_KEY_PREFIX,
  isTickable,
  tickableStepRefs,
  type PrepStepRef as BuildStepRef,
} from "./prepWeekBuild";
import { cachedStepsOf, resolveTicks } from "./prepTickCarry";

/**
 * Minimal per-step shape the derivation needs (matches derivePrepCompletion).
 * SERVER-8 C (BUG-568) — `carried`: the step's key was not ticked, but the ticks of the
 * screen the cook ticked carry it (SERVER-7's rule, prepTickCarry), so it counts as done.
 */
export type PrepStepRef = BuildStepRef & { carried?: true };

export interface LoadPrepStepSetParams {
  planId: string;
  userId: string;
  prisma: PrismaClient;
  // Injectable for tests / to reuse a router's already-wired loader.
  loadPrepWeekInput?: typeof productionLoadPrepWeekInput;
  /**
   * SERVER-8 C (BUG-568) — the plan's ticked stepKeys. Given, a week step a tick of
   * the cached screen carries is returned `carried` (see PrepStepRef).
   */
  ticks?: Iterable<string>;
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
//
// ⚠️ Part J.0 — NO LONGER READ by loadPrepStepSet, which now computes every
// demotion (prepWeekBuild.isTickable). Kept, with its tests, for one part so a
// rollback is a one-line revert; delete in J.1.
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
      const s = step as {
        stepKey?: unknown;
        skipSuggested?: unknown;
        holdsNoContainer?: unknown;
      } | null;
      // ── D-WS9-301 rule 10 — THE WASH STEP DOES NOT GATE "PREPPED" ────────
      //
      // It contributes to every meal in the plan that has produce, so leaving
      // it in the required set means NO meal can read prepped until it is
      // ticked — including for a cook who buys washed greens and skips it.
      // It holds no container and portions nothing, which is the same test
      // that keeps it out of the header count. The cook can still tick it; it
      // just does not hold the week hostage.
      if (
        s &&
        (s.skipSuggested === true || s.holdsNoContainer === true) &&
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
    // 🔴 Part J.0 (A1) — THE SAME BUILD THE ROUTE RENDERS FROM: step text, day
    // lags and today included. This used to call buildStepPlan WITHOUT step text
    // or lags (D-WS9-049 A2.1 skipped the two step queries), which keyed a
    // different plan — `seasonings_dry#dish#…` blends no screen showed — and read
    // demotions from the cached blob, which is written before the date overlay and
    // so never held a protein. 12 of 14 census meals stayed "not prepped" after
    // every step on screen was ticked. The two queries are the price of agreeing.
    const loaded = await load({
      planId: params.planId,
      userId: params.userId,
      prisma: params.prisma,
    });
    // A2 — only what the cook can tick: no engine demotion, no wash or cook-day
    // line (D-WS9-301 rule 10), no protein the overlay holds for cook day.
    // Everything is computed, so the cached blob is no longer read here.
    // PREP-1 (D-WS9-314) — the full week WITHOUT the feast: the core reads a
    // `thanksgiving-feast` meal as nothing to prep. The feast's own steps come
    // from its session, under their own keys, so its Hub pill is driven by
    // "Prep the feast" and a weeknight onion tick never counts for the stuffing.
    const week = buildCoreWeek(loaded);
    const core = await withCarriedTicks(tickableStepRefs(week), week, loaded, params);
    const feast = buildFeastSession(loaded);
    if (!feast) return core;
    return [
      ...core,
      ...tickableStepRefs(feast).map((r) => ({ ...r, stepKey: `${FEAST_KEY_PREFIX}${r.stepKey}` })),
    ];
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

/**
 * 🔴 SERVER-8 C (BUG-568) — THE ROLLUP COUNTS THE TICKS THE WAY COOK MODE DOES. A tick is a
 * key of the plan's CACHED Prep the Week, and an engine change re-keys steps; this
 * rollup compared the ticks with today's build, so a stale-cache plan read "not
 * prepped" after every step on its screen was ticked, until its Prep the Week next
 * regenerated (SERVER-7 left it). Now a week step is done when its key was ticked, or
 * when the ticks of the cached screen carry it (prepTickCarry resolveTicks, carrying
 * only a step tickable today: Cook Mode's weeknightDoneSteps). The cache is read only
 * when a tick names no step today. Feast ticks are the feast session's keys, as before.
 */
async function withCarriedTicks(
  refs: PrepStepRef[],
  week: ReturnType<typeof buildCoreWeek>,
  loaded: Awaited<ReturnType<typeof productionLoadPrepWeekInput>>,
  params: LoadPrepStepSetParams,
): Promise<PrepStepRef[]> {
  if (!params.ticks) return refs;
  const ticked = new Set([...params.ticks].filter((k) => !k.startsWith(FEAST_KEY_PREFIX)));
  const live = new Set(week.stepPlan.steps.map((s) => s.stepKey));
  if (![...ticked].some((k) => !live.has(k))) return refs;
  const cache = await params.prisma.prepWeekStructure.findUnique({ where: { planId: params.planId }, select: { structureJson: true } });
  const { done } = resolveTicks(ticked, week.stepPlan.steps, {
    cached: cachedStepsOf(cache?.structureJson),
    fold: (id) => loaded.identity?.foldedIdByIngredientId.get(id) ?? id,
    carryable: (s) => isTickable(s, week),
  });
  return refs.map((r) => (done.has(r.stepKey) && !ticked.has(r.stepKey) ? { ...r, carried: true as const } : r));
}
