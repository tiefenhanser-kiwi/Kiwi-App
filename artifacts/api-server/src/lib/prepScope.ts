// SERVER-9 C (BUG-582) — A TICK MADE IN A SUBSET OR ONE-MEAL SESSION COUNTS ONLY
// FOR THE MEALS IN THAT SESSION.
//
// A subset is the whole plan built and then scoped (A3), so its steps carried the
// WEEK's keys. A tick is (planId, stepKey), so "Mince the garlic" ticked in a
// one-meal session was the week's garlic step ticked: every meal that step covers
// then read "the minced garlic you prepped" (QA-NIGHT, R5 ×9: h3, h4, h10).
//
// THE SCOPE RIDES IN THE KEY. A subset step is served as `~<mask>.<check>~<key>`:
//   mask  — which of the plan's meals the session holds: bit i = the i-th of the
//           plan's distinct meal ids, sorted (planMealOrder), in base 32;
//   check — two base-32 characters of sha1(the session's meal ids, sorted), so a
//           key read against a plan whose meals have since changed decodes to
//           nothing rather than to the wrong meals (1 in 1024 slips through);
//   key   — the engine key, exactly the week's.
// Why the key and not a column: the shipped apps send back the key they were
// served and nothing else (PUT …/completions { stepKey }, .strict()), so only a
// key can carry the scope for them; and it needs no migration. Why so short: the
// shipped apps parse a served stepKey as at most 80 characters, and the longest
// engine key is 71 (prepWeekBuild FEAST_KEY_PREFIX note). A plan of up to 20
// meals has a mask of at most 4 characters, so the prefix is at most 9.
//
// A key that would not fit is served unscoped (the old behaviour) and logged by
// the caller; no plan on dev has more than 9 meals.

import { createHash } from "node:crypto";

export const SCOPED_KEY_MAX = 80;
const SCOPED_RE = /^~([0-9a-v]+)\.([0-9a-v]{2})~(.+)$/;

/**
 * The plan's meals for scoping: the loader's planMealIds (every item's meal), or, for a
 * loader that has none (a hand-built test load), its input meals.
 */
export function planMealsOf(load: { planMealIds?: readonly string[]; input: { meals: readonly { mealId: string }[] } }): string[] {
  return [...(load.planMealIds ?? load.input.meals.map((m) => m.mealId))];
}

/** The plan's distinct meal ids, sorted: the bit order of a scope mask. */
export function planMealOrder(mealIds: Iterable<string>): string[] {
  return [...new Set(mealIds)].sort();
}

function checkOf(sortedScope: readonly string[]): string {
  const h = createHash("sha1").update(sortedScope.join(",")).digest();
  // 10 bits → two base-32 characters.
  const n = ((h[0]! << 2) | (h[1]! >> 6)) & 0x3ff;
  return n.toString(32).padStart(2, "0");
}

/**
 * The prefix for a session over `scope`, or null when the session is the whole
 * set of `eligible` meals (Prep the Week by another door: its ticks are the week's)
 * or a scope meal is not in the plan.
 */
export function scopePrefix(planMeals: readonly string[], scope: Iterable<string>, eligible?: Iterable<string>): string | null {
  const order = planMealOrder(planMeals);
  const chosen = new Set(scope);
  if (chosen.size === 0) return null;
  if (eligible) {
    const all = new Set(eligible);
    if ([...all].every((id) => chosen.has(id))) return null;
  }
  let mask = 0n;
  for (const id of chosen) {
    const i = order.indexOf(id);
    if (i < 0) return null;
    mask |= 1n << BigInt(i);
  }
  return `~${mask.toString(32)}.${checkOf([...chosen].sort())}~`;
}

/** `prefix + key`, or null when it would be longer than the apps accept. */
export function scopedKey(prefix: string, key: string): string | null {
  const k = `${prefix}${key}`;
  return k.length <= SCOPED_KEY_MAX ? k : null;
}

export interface ScopedTick {
  /** The stored key, as ticked. */
  stepKey: string;
  /** The engine key (the week's). */
  base: string;
  /** The session's meals; null when the key no longer decodes against this plan. */
  mealIds: ReadonlySet<string> | null;
}

/** A scoped key decoded against the plan's meals, or null for an unscoped key. */
export function parseScopedKey(stepKey: string, planMeals: readonly string[]): ScopedTick | null {
  const m = SCOPED_RE.exec(stepKey);
  if (!m) return null;
  const [, maskText, check, base] = m as unknown as [string, string, string, string];
  const order = planMealOrder(planMeals);
  // At most 10 base-32 characters (50 bits) parse exactly as a Number.
  const n = maskText.length <= 10 ? parseInt(maskText, 32) : NaN;
  if (!Number.isSafeInteger(n) || n === 0) return { stepKey, base, mealIds: null };
  const mask = BigInt(n);
  const ids: string[] = [];
  for (let i = 0; mask >> BigInt(i) > 0n; i++) {
    if (((mask >> BigInt(i)) & 1n) === 0n) continue;
    if (i >= order.length) return { stepKey, base, mealIds: null };
    ids.push(order[i]!);
  }
  if (checkOf([...ids].sort()) !== check) return { stepKey, base, mealIds: null };
  return { stepKey, base, mealIds: new Set(ids) };
}

export interface SplitTicks {
  /** Keys ticked in Prep the Week (or the feast's `feast#` keys): every meal. */
  unscoped: string[];
  /** Keys ticked in a subset or one-meal session. */
  scoped: ScopedTick[];
}

export function splitTicks(ticks: Iterable<string>, planMeals: readonly string[]): SplitTicks {
  const out: SplitTicks = { unscoped: [], scoped: [] };
  for (const k of ticks) {
    const s = parseScopedKey(k, planMeals);
    if (s) out.scoped.push(s);
    else out.unscoped.push(k);
  }
  return out;
}

/**
 * The engine keys that count as ticked FOR ONE MEAL: every unscoped tick, and the
 * engine key of every scoped tick whose session held the meal. What Cook Mode's
 * words for that meal read (feastCookWording weeknightCookWordingFor).
 */
export function ticksForMeal(ticks: Iterable<string>, mealId: string, planMeals: readonly string[]): string[] {
  const { unscoped, scoped } = splitTicks(ticks, planMeals);
  return [...unscoped, ...scoped.filter((s) => s.mealIds?.has(mealId)).map((s) => s.base)];
}

/** Scoped ticks grouped by session (same prefix): the engine keys and the meals. */
export function scopedGroups(scoped: readonly ScopedTick[]): { prefix: string; mealIds: ReadonlySet<string>; bases: string[] }[] {
  const groups = new Map<string, { prefix: string; mealIds: ReadonlySet<string>; bases: string[] }>();
  for (const s of scoped) {
    if (!s.mealIds) continue;
    const prefix = s.stepKey.slice(0, s.stepKey.length - s.base.length);
    const g = groups.get(prefix) ?? { prefix, mealIds: s.mealIds, bases: [] };
    g.bases.push(s.base);
    groups.set(prefix, g);
  }
  return [...groups.values()];
}

/**
 * A subset or one-meal session's result with its keys scoped (see the head).
 *
 * A step ALREADY ticked for every meal of the session is served under the key that
 * ticked it: the week's key when Prep the Week ticked it, or a wider session's. So
 * the session shows it ticked, as it did when subsets carried week keys, and an
 * untick there removes that tick, as it did then. `unfit` lists the steps served
 * unscoped because the scoped key would be longer than the apps accept.
 */
export function withSessionKeys<R extends { phases: { steps: { stepKey: string }[] }[] }>(
  result: R,
  session: { planMeals: readonly string[]; scope: readonly string[]; eligible: readonly string[]; ticks: Iterable<string> },
): { result: R; unfit: string[] } {
  const prefix = scopePrefix(session.planMeals, session.scope, session.eligible);
  if (!prefix) return { result, unfit: [] };
  const { unscoped, scoped } = splitTicks(session.ticks, session.planMeals);
  const week = new Set(unscoped);
  const unfit: string[] = [];
  const keyFor = (key: string): string => {
    if (week.has(key)) return key;
    const wider = scoped.find((s) => s.base === key && s.mealIds && session.scope.every((id) => s.mealIds!.has(id)));
    if (wider) return wider.stepKey;
    const k = scopedKey(prefix, key);
    if (k === null) unfit.push(key);
    return k ?? key;
  };
  return {
    result: { ...result, phases: result.phases.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, stepKey: keyFor(s.stepKey) })) })) },
    unfit,
  };
}
