// THX-3d round 2 (M, as Hans ruled Oct 22) — THE WEEKNIGHT'S MORNING CUT.
//
// Prep the Week leaves a cut that would not keep for its cook day ("Parmesan-Crusted
// Baked Pork Chops (Friday, 4 days out) — juice the lemon and prep the broccoli florets
// that morning"). That note lived only under Prep the Week. On the meal's day it is now
// the first thing Cook Mode says for the dish, with how the cut waits (heldMorning: the
// pot left on the stove, off; the toss in its oil in the fridge; a container), and the
// scheduler does it in the first free window (cookingScheduler heldMorningFirst).
//
// A weeknight meal is the user's own copy, so nothing is written: the meal detail read
// in its plan (GET /meals/:id?planItemId) and the cooking sequence both reshape the
// dish's steps at read time, from the plan's own Prep the Week build (code only, no AI).
// A step that is new takes the next free stepIndex after the dish's last one — Cook
// Mode keys and the prep collapse go by (dishId, stepIndex), never by position — and
// comes FIRST in the dish's array; the sequence orders it by time.

import type { PrismaClient } from "@prisma/client";

import { loadPrepWeekInput } from "./prepWeekAggregation";
import { buildCoreWeek, type PrepWeekBuild } from "./prepWeekBuild";
import {
  alreadyCut,
  boilHold,
  boilPlace,
  coats,
  CUT_AT_THE_STEP,
  cutSentence,
  HELD_MORNING_STEP,
  headOf,
  plainHold,
  potNoun,
  pourJuice,
  referBack,
  isGarnish,
  MORNING_MIN_LEAD,
  spreadOnPan,
  TOSS,
  tossHold,
} from "./heldMorning";
import { deriveAmountRefs, type AmountRef } from "./stepAmountRefs";

/** A cut Prep the Week leaves for one meal's cook day. */
export interface HeldCookDayCut {
  dishId: string;
  ingredientId: string;
  ingredientName: string;
}

/**
 * The plan's held cuts for one meal, as Prep the Week's "held for cook day" lines list
 * them (prepWeekBuild heldLinesFor): a portion held past its window, and produce that
 * browns once cut. A held measure (a dry blend's, a sauce jar's) is not a cut.
 */
export function heldCutsInBuild(build: PrepWeekBuild, mealId: string): HeldCookDayCut[] {
  const out: HeldCookDayCut[] = [];
  const add = (dishId: string | undefined, ingredientId: string | undefined, ingredientName: string) => {
    if (dishId && ingredientId && !out.some((x) => x.dishId === dishId && x.ingredientId === ingredientId)) out.push({ dishId, ingredientId, ingredientName });
  };
  for (const st of build.stepPlan.steps) {
    const h = build.holds.get(st.stepKey);
    if (h && st.phase !== "seasonings_dry" && st.phase !== "sauces_marinades") {
      for (const p of h.heldPortions.filter((x) => x.mealId === mealId)) {
        const c = st.components.find((x) => x.ingredientName === p.ingredientName);
        for (const m of c?.measures.filter((x) => x.mealId === mealId) ?? []) add(m.dishId, m.ingredientId, p.ingredientName);
      }
    }
    if (st.demoted?.reason === "does-not-hold") {
      for (const c of st.components) for (const m of c.measures.filter((x) => x.mealId === mealId)) add(m.dishId, m.ingredientId, c.ingredientName);
    }
  }
  return out;
}

/** The plan's held cuts for one meal; none when the plan has no week to prep. */
export async function heldCookDayCuts(prisma: PrismaClient, args: { planId: string; userId: string; mealId: string; now?: Date }): Promise<HeldCookDayCut[]> {
  try {
    const load = await loadPrepWeekInput({ planId: args.planId, userId: args.userId, prisma, ...(args.now ? { now: args.now } : {}) });
    return heldCutsInBuild(buildCoreWeek(load), args.mealId);
  } catch {
    return [];
  }
}

export interface MorningStepIn {
  stepIndex: number;
  text: string;
  estimatedMinutes: number;
  phaseType: string;
}
export interface MorningStep extends MorningStepIn {
  /** The step's words or minutes moved (its amounts must be read again). */
  changed: boolean;
  /** A step the read added: it has no stored row. */
  isNew: boolean;
}
export interface MorningRow {
  name: string;
  quantity: number;
  unit: string;
  note: string | null;
}

const CUT_START = /^(?:peel|cut|slice|dice|chop|mince|grate|core|scrub|halve|quarter|trim|cube|juice|zest|thinly|finely|roughly|coarsely)\b/i;

/**
 * A dish's steps with its held cuts done in the morning, in the order Cook Mode reads
 * them. The same reading as the catalog feasts' (scripts/thx2/patch.ts item 16): the
 * cut is the dish's own cutting step when it has one, else a new first step in the
 * row's words; what comes next decides how it waits. A dish with nothing held, or whose
 * step already holds, comes back as it was.
 */
export function morningSteps(
  steps: readonly MorningStepIn[],
  held: readonly MorningRow[],
  /** PREP-3 (R8) — the weeknight's: a cut used before this minute of the dish is not a morning step. */
  opts: { minLead?: number } = {},
): MorningStep[] {
  const out: MorningStep[] = [...steps].sort((a, b) => a.stepIndex - b.stepIndex).map((s) => ({ ...s, changed: false, isNew: false }));
  let nextIndex = Math.max(-1, ...steps.map((s) => s.stepIndex)) + 1;
  const make = (text: string, estimatedMinutes: number, phaseType: string): MorningStep => ({ stepIndex: nextIndex++, text, estimatedMinutes, phaseType, changed: true, isNew: true });
  const set = (s: MorningStep, text: string, estimatedMinutes = s.estimatedMinutes, phaseType = s.phaseType) => Object.assign(s, { text, estimatedMinutes, phaseType, changed: true });
  for (const row of held) {
    // PREP-3 (R8) — an avocado is cut at its own step, never in the morning.
    if (CUT_AT_THE_STEP.test(row.name)) continue;
    const head = new RegExp(`\\b${headOf(row.name)}`, "i");
    if (!out.some((s) => head.test(s.text))) continue;
    if (out.some((s) => head.test(s.text) && HELD_MORNING_STEP.test(s.text))) continue;
    let cut = out.find((s) => CUT_START.test(s.text) && alreadyCut([s.text.split(/;\s*/)[0]], row.name));
    // PREP-3 (R8) — used within the dish's first minutes (its own clock, the steps in
    // order): no morning, no "this morning". A cut the recipe never wrote is its first step.
    if (opts.minLead !== undefined) {
      const usedAt = out.findIndex((s) => s !== cut && head.test(s.text) && !(cut && out.indexOf(s) < out.indexOf(cut)));
      const minute = out.slice(0, Math.max(0, usedAt)).reduce((n, s) => n + s.estimatedMinutes, 0);
      if (usedAt >= 0 && minute < opts.minLead) {
        const sentence = cut ? null : cutSentence(row);
        if (sentence) out.unshift(make(sentence, 2, "prep"));
        continue;
      }
    }
    if (cut && TOSS.test(cut.text)) {
      // Cut and tossed in one step: in its oil, that step is the morning one (the
      // feast's apples are cut and tossed with lemon and sugar the same way).
      const own = coats([cut.text]) ? tossHold(cut.text, row.name) : null;
      if (own) {
        const at = out.indexOf(cut);
        set(cut, own.toss, own.spread ? Math.max(1, cut.estimatedMinutes - 1) : cut.estimatedMinutes);
        if (own.spread) out.splice(at + 1, 0, make(own.spread, 1, "prep"));
      }
      continue;
    }
    if (!cut) {
      const sentence = cutSentence(row);
      if (sentence) {
        cut = make(sentence, /potato/i.test(sentence) ? 5 : 2, "prep");
        out.unshift(cut);
      }
    }
    const from = cut ? out.indexOf(cut) + 1 : 0;
    // The next step that names the food; failing that, one that names its pieces.
    const named = out.findIndex((s, i) => i >= from && head.test(s.text));
    const nextAt = named >= 0 ? named : out.findIndex((s, i) => i >= from && /\b(?:chunks|cubes|pieces|florets)\b/i.test(s.text));
    const next = nextAt >= 0 ? out[nextAt] : null;
    const boil = next ? boilHold(cut ? cut.text : null, next.text, row.name) : null;
    if (boil && next) {
      const fill = Math.min(3, next.estimatedMinutes);
      const later = boilPlace(next.text)!.rest ? Math.max(1, next.estimatedMinutes - fill) : 1;
      if (cut) {
        set(cut, boil.held, cut.estimatedMinutes + fill);
        set(next, boil.later, later, "cook");
      } else {
        set(next, boil.held, fill, "prep");
        out.splice(nextAt + 1, 0, make(boil.later, later, "cook"));
      }
      continue;
    }
    if (!cut) continue;
    const toss = next && TOSS.test(next.text) && coats(out.slice(from, nextAt + 1).map((s) => s.text)) ? tossHold(next.text, row.name) : null;
    if (toss && next) {
      const spreadMinutes = toss.spread ? Math.min(2, Math.max(1, next.estimatedMinutes - 1)) : 0;
      set(next, toss.toss, next.estimatedMinutes - spreadMinutes);
      if (toss.spread) out.splice(nextAt + 1, 0, make(toss.spread, spreadMinutes, "prep"));
      else if (toss.pan) {
        const spread = out.find((s, i) => i > nextAt && /^Spread\b/i.test(s.text));
        if (spread) set(spread, spreadOnPan(spread.text, toss.pan, row.name));
        else out.splice(nextAt + 1, 0, make(`Spread the ${potNoun(row.name)} on ${toss.pan}.`, 1, "prep"));
      }
      continue;
    }
    set(cut, plainHold(cut.text, row.name, row.note));
    // Round 3 (U) — a garnish is named where it goes on: "the chives you sliced this morning".
    if (isGarnish(row.name, row.note)) {
      for (const s of out.slice(out.indexOf(cut) + 1)) {
        const named = referBack(s.text, row.name, row.note);
        if (named !== s.text) set(s, named);
      }
    }
    // The juice waits in its container, so the step that squeezed the fruit pours it.
    if (next && /\bjuiced\b/i.test(row.note ?? "")) {
      const poured = pourJuice(next.text);
      if (poured !== next.text) set(next, poured);
    }
  }
  return out;
}

/** A morning step as the wire carries it: its words, minutes, phase and amounts. */
export interface MorningWireStep extends MorningStep {
  amountRefs: AmountRef[];
}

/**
 * The weeknight morning for one plan meal, per dish: the dish's steps reshaped
 * (morningSteps) with each new or changed step's amounts read again from the dish's
 * own rows. Only dishes something is held for appear; a feast is never passed here.
 */
export async function weeknightMorningFor(
  prisma: PrismaClient,
  args: { planId: string; userId: string; mealId: string; dishes: readonly { dishId: string; steps: readonly MorningStepIn[] }[]; now?: Date },
): Promise<Map<string, MorningWireStep[]>> {
  const out = new Map<string, MorningWireStep[]>();
  const cuts = await heldCookDayCuts(prisma, args);
  if (cuts.length === 0) return out;
  const dishIds = [...new Set(cuts.map((c) => c.dishId))].filter((id) => args.dishes.some((d) => d.dishId === id));
  const rows = await prisma.dishIngredient.findMany({
    where: { dishId: { in: dishIds } },
    select: { dishId: true, ingredientId: true, quantity: true, unit: true, preparationNote: true, ingredient: { select: { canonicalName: true } } },
  });
  for (const dishId of dishIds) {
    const own = rows.filter((r) => r.dishId === dishId);
    const held = cuts
      .filter((c) => c.dishId === dishId)
      .map((c) => own.find((r) => r.ingredientId === c.ingredientId))
      .filter((r): r is (typeof own)[number] => !!r)
      .map((r) => ({ name: r.ingredient.canonicalName, quantity: r.quantity, unit: r.unit, note: r.preparationNote }));
    const steps = morningSteps(args.dishes.find((d) => d.dishId === dishId)!.steps, held, { minLead: MORNING_MIN_LEAD });
    if (!steps.some((s) => s.changed)) continue;
    const matcher = own.map((r) => ({ ingredientId: r.ingredientId, name: r.ingredient.canonicalName, quantity: r.quantity, unit: r.unit }));
    out.set(dishId, steps.map((s) => ({ ...s, amountRefs: s.changed ? deriveAmountRefs(s.text, matcher).amountRefs : [] })));
  }
  return out;
}
