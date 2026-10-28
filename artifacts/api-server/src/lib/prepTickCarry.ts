// SERVER-7 B (BUG-556/557) — A TICK IS A TICK OF THE STEP THE COOK SAW.
//
// A PrepStepCompletion row holds the stepKey of the step the cook ticked on the Prep the
// Week screen, and that screen is the plan's CACHED structure. The engine re-keys steps
// when it changes (`seasonings_dry#dish#<dish>` became a container key `cnt#seas#<dish>|…`,
// the week's one `seasonings_dry#blend` became a mix per dish, `sauces_marinades#<food>`
// a marinade container), so a tick made on an older cache is a key today's build does not
// have. QA-6 found 171 of 172 such ticks on dev: Cook Mode, which compares the ticks with
// today's build, stopped saying those containers, and the regenerate's prune deleted them.
//
// The identity that survives a re-key is what a step holds: its PORTIONS, each a food of a
// dish in a phase. An old key still says which portions it held:
//   <phase>#<foodId>            that food's portions
//   <phase>#dish#<dishId>       that dish's mix (a blend or a marinade): its portions in
//   cnt#<ph4>#<dishId>|…        either mix phase, because a dish's spices can move from
//                               the dry blend into a wet rub
//   seasonings_dry#blend        the week's one blend: every dry portion
// and the cached step says which meals it served. A portion is decided by the most
// specific step of the OLD screen that held it (its own key, then a food step, then the
// dish's mix), ticked or not; a portion no step of that screen held (the oil today's
// engine measures into a marinade an older one never showed) does not decide anything.
// A step of today's build counts as ticked when its key was ticked, or when every portion
// the old screen held is ticked and at least one is. With no cache to read, every portion
// must be ticked. A tick that carries no step is reported and kept, never dropped.

import type { PrepWeekResult } from "./ai/schemas/prepWeek";
import type { PlannedStep } from "./prepWeekAssembly";
import { WEEK_LABEL_STEP_KEY } from "./prepWeekLabels";

const PHASE_OF: Record<string, string> = { seas: "seasonings_dry", sauc: "sauces_marinades", prod: "produce", prot: "proteins" };
const PHASES = new Set(Object.values(PHASE_OF));
const MIX_PHASES = new Set(["seasonings_dry", "sauces_marinades"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What an old key held: the portions it names (a field left out matches any). */
export interface Claim { key: string; phase: string; dishId?: string; food?: string; mealIds?: ReadonlySet<string> }
interface Portion { phase: string; dishId: string; food: string; mealId?: string }

export interface TickResolution {
  /** Today's step keys that count as ticked: the exact ticks, and the steps carried. */
  done: Set<string>;
  /** Today's key → the old keys whose ticks carry it (carried steps only). */
  carried: Map<string, string[]>;
  /** Ticks that are not today's keys and carry no step of today's. */
  unmapped: string[];
}

export type CachedSteps = ReadonlyMap<string, { contributesToMealIds: readonly string[] }>;

/** The week's steps of a stored structure, by key (the screen the cook ticked). */
export function cachedStepsOf(structureJson: unknown): Map<string, { contributesToMealIds: string[] }> {
  const out = new Map<string, { contributesToMealIds: string[] }>();
  const phases = (structureJson as Partial<PrepWeekResult> | null)?.phases;
  if (!Array.isArray(phases)) return out;
  for (const p of phases) for (const s of p?.steps ?? []) if (typeof s?.stepKey === "string") out.set(s.stepKey, { contributesToMealIds: Array.isArray(s.contributesToMealIds) ? s.contributesToMealIds : [] });
  return out;
}

/** The portions an old key held, or null when its key says nothing about any. */
export function claimOf(key: string, cached?: { contributesToMealIds: readonly string[] }): Claim | null {
  const mealIds = cached && cached.contributesToMealIds.length > 0 ? new Set(cached.contributesToMealIds) : undefined;
  const meals = mealIds ? { mealIds } : {};
  const m = /^cnt#([a-z]{4})#([^|]+)\|/.exec(key);
  if (m) return PHASE_OF[m[1]] && UUID.test(m[2]) ? { key, phase: PHASE_OF[m[1]], dishId: m[2], ...meals } : null;
  const [phase, a, b] = key.split("#");
  if (!PHASES.has(phase)) return null;
  if (a === "blend" && b === undefined) return { key, phase, ...meals };
  if ((a === "dish" || a === "left") && b && UUID.test(b)) return { key, phase, dishId: b, ...meals };
  if (a && b === undefined && UUID.test(a)) return { key, phase, food: a, ...meals };
  return null;
}

export function portionsOf(step: PlannedStep, fold: (id: string) => string): Portion[] {
  const out: Portion[] = [];
  for (const c of step.components) {
    for (const m of c.measures) {
      if (!m.dishId || !m.ingredientId) continue;
      // (PREP-3 R4 — a marinade's own oil is measured under `<id>|mix`.)
      out.push({ phase: step.phase, dishId: m.dishId, food: fold(m.ingredientId.split("|")[0]), ...(m.mealId ? { mealId: m.mealId } : {}) });
    }
  }
  return out;
}

/**
 * How specifically a claim holds a portion (-1 not at all): the food's own step in the
 * portion's phase (5), the dish's mix in it (4: the lime juice measured into the peanut
 * sauce was the sauce step's, not "Cut limes into wedges"), the food's step in another
 * phase (3), the dish's mix in the other mix phase (2), the week's one blend (1).
 */
export function score(c: Claim, p: Portion, fold: (id: string) => string): number {
  if (c.mealIds && p.mealId && !c.mealIds.has(p.mealId)) return -1;
  if (c.food !== undefined) return fold(c.food) === p.food ? (c.phase === p.phase ? 5 : 3) : -1;
  if (c.dishId !== undefined) {
    if (c.dishId !== p.dishId) return -1;
    if (c.phase === p.phase) return 4;
    return MIX_PHASES.has(c.phase) && MIX_PHASES.has(p.phase) ? 2 : -1;
  }
  return c.phase === p.phase ? 1 : -1;
}

/**
 * The ticks, resolved against today's build. `cached` is the stored week the cook ticked;
 * `fold` is the plan's food identity (identity.foldedIdByIngredientId), so an older group
 * id names the same food.
 */
export function resolveTicks(
  ticks: Iterable<string>,
  steps: readonly PlannedStep[],
  opts: { cached?: CachedSteps; fold?: (id: string) => string; /** Only these steps may be carried (Cook Mode: tickable today). */ carryable?: (s: PlannedStep) => boolean } = {},
): TickResolution {
  const fold = opts.fold ?? ((id: string) => id);
  const ticked = new Set(ticks);
  // The label step is put on at read time (labelWeekResult): a live key the build lacks.
  const keys = new Set([...steps.map((s) => s.stepKey), WEEK_LABEL_STEP_KEY]);
  const done = new Set([...ticked].filter((k) => keys.has(k)));
  const orphans = [...ticked].filter((k) => !keys.has(k));
  const cached = opts.cached && opts.cached.size > 0 ? opts.cached : null;
  // The old screen's claims: every cached step that is not a key today, ticked or not; with
  // no cache, the ticks alone.
  const claims: (Claim & { ticked: boolean })[] = [];
  for (const k of cached ? new Set([...cached.keys(), ...orphans]) : orphans) {
    if (keys.has(k)) continue;
    const c = claimOf(k, cached?.get(k));
    if (c) claims.push({ ...c, ticked: ticked.has(k) });
  }
  const carried = new Map<string, string[]>();
  if (claims.some((c) => c.ticked)) {
    // A portion of a step the old screen showed under today's key is decided by that key.
    const exact = new Map<string, boolean>();
    const pk = (p: Portion) => `${p.phase}|${p.dishId}|${p.food}|${p.mealId ?? ""}`;
    for (const s of steps) {
      if (!(cached ? cached.has(s.stepKey) : ticked.has(s.stepKey))) continue;
      for (const p of portionsOf(s, fold)) exact.set(pk(p), (exact.get(pk(p)) ?? false) || ticked.has(s.stepKey));
    }
    for (const s of steps) {
      if (s.demoted || done.has(s.stepKey) || (opts.carryable && !opts.carryable(s))) continue;
      const by = new Set<string>();
      let ok = true;
      let any = false;
      for (const p of portionsOf(s, fold)) {
        const e = exact.get(pk(p));
        if (e !== undefined) {
          if (!e) ok = false;
          continue;
        }
        let best = -1;
        let bestClaims: typeof claims = [];
        for (const c of claims) {
          const sc = score(c, p, fold);
          if (sc > best) { best = sc; bestClaims = [c]; } else if (sc === best && sc >= 0) bestClaims.push(c);
        }
        if (best < 0) {
          if (!cached) ok = false; // nothing old held it: with no cache to say so, it was not ticked
          continue;
        }
        const t = bestClaims.filter((c) => c.ticked);
        if (t.length === 0) { ok = false; continue; }
        any = true;
        for (const c of t) by.add(c.key);
      }
      if (!ok || !any) continue;
      done.add(s.stepKey);
      carried.set(s.stepKey, [...by]);
    }
  }
  const used = new Set([...carried.values()].flat());
  return { done, carried, unmapped: orphans.filter((k) => !used.has(k)) };
}
