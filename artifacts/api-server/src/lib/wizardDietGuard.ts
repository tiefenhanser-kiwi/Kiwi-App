// FIX-4 (A) — the diet as a CODE check on a generated plan, not only a prompt line.
//
// THE GAP (Hans, October 17, on his Pixel): with Vegetarian (and, separately,
// Pescatarian) saved, most of the wizard's plans still had meat. The prompt has
// said "eatingStyles are absolute exclusions" for months; the shelf it was
// handed was the whole catalog (~9% vegetarian), and nothing in code checked
// the answer. The shelves now filter on the diet (storeShortlist `diets`), and
// this file is the second half: every candidate the model returns is read slot
// by slot before it reaches the wire.
//
//   • a SHELF slot must be a meal whose ingredient names fit the diet (the
//     `fittingIds` set, read from the DB per request — independent of the
//     shelf filter, so a broken filter is still caught here);
//   • a LIVE slot has only a title and a one-line description at this point,
//     read by generatedMealFitsDiets (similar/diet.ts). Its ingredients are
//     checked again at expand (wizardExpansion.ts), where they first exist.
//
// A failing slot is REPLACED with a fitting shelf meal the set has not used yet
// (catalog first, D-WS9-238), as a store slot under its real id with an empty
// description (the wire reads the row's own). When no unused fitting meal is
// left the candidate is DROPPED rather than shipped with the violation; the
// route reports the short set the way FIX-2's delivered/requested does.

import type { PrismaClient } from "@prisma/client";

import type { WizardPlanCandidate } from "./ai/schemas/wizard";
import { logger } from "./logger";
import { generatedMealFitsDiets, type DietRestriction } from "./similar/diet";
import { mealIdsFittingDiets } from "./similar/swapPool";

export interface DietGuardContext {
  diets: readonly DietRestriction[];
  /** Real ids of shelf meals whose ingredient names fit every diet. */
  fittingIds: ReadonlySet<string>;
  /** Fitting shelf meals in shelf order — the replacement pool. */
  pool: readonly { id: string; title: string }[];
  /**
   * Real ids already placed in candidates of THIS response (shared and
   * mutated across calls, so a replacement never repeats a meal another card
   * holds — the distinctness rule the prompt states).
   */
  used: Set<string>;
  /**
   * FIX-4 (B) — on a "Get another plan option" call, the meal titles the user
   * has already been shown (lower-cased). The prompt is told to avoid them and
   * still repeated 2 of 5 on dev, so a slot carrying one is replaced like a
   * diet miss, and no replacement is drawn from them.
   */
  avoidTitles?: ReadonlySet<string>;
}

export interface DietGuardResult {
  candidate: WizardPlanCandidate | null;
  /** Titles that failed the diet, in slot order. */
  violations: string[];
  replaced: number;
}

/**
 * Check one RECONCILED candidate (storeSlots carry real Meal ids). Pure apart
 * from adding the kept candidate's store ids to `ctx.used`.
 */
export function enforceDietOnCandidate(
  candidate: WizardPlanCandidate,
  ctx: DietGuardContext,
): DietGuardResult {
  const avoid = ctx.avoidTitles ?? new Set<string>();
  if (ctx.diets.length === 0 && avoid.size === 0) {
    for (const s of candidate.storeSlots ?? []) ctx.used.add(s.storeMealId);
    return { candidate, violations: [], replaced: 0 };
  }
  const storeBySlot = new Map((candidate.storeSlots ?? []).map((s) => [s.slotIndex, s.storeMealId]));
  const mealTitles = [...candidate.mealTitles];
  const descriptions = candidate.mealDescriptions ? [...candidate.mealDescriptions] : undefined;
  const violations: string[] = [];
  const failing: number[] = [];
  for (let i = 0; i < mealTitles.length; i++) {
    const sid = storeBySlot.get(i);
    const ok =
      !avoid.has(mealTitles[i].toLowerCase()) &&
      (sid ? ctx.fittingIds.has(sid) : generatedMealFitsDiets(mealTitles[i], descriptions?.[i], ctx.diets));
    if (!ok) {
      violations.push(mealTitles[i]);
      failing.push(i);
    }
  }
  if (failing.length === 0) {
    for (const id of storeBySlot.values()) ctx.used.add(id);
    return { candidate, violations, replaced: 0 };
  }

  const inCandidate = new Set(
    [...storeBySlot.entries()].filter(([i]) => !failing.includes(i)).map(([, id]) => id),
  );
  const titlesInCandidate = new Set(
    mealTitles.filter((_, i) => !failing.includes(i)).map((t) => t.toLowerCase()),
  );
  for (const i of failing) {
    const pick = ctx.pool.find(
      (m) =>
        ctx.fittingIds.has(m.id) &&
        !ctx.used.has(m.id) &&
        !inCandidate.has(m.id) &&
        !titlesInCandidate.has(m.title.toLowerCase()) &&
        !avoid.has(m.title.toLowerCase()),
    );
    if (!pick) return { candidate: null, violations, replaced: 0 };
    mealTitles[i] = pick.title;
    if (descriptions && i < descriptions.length) descriptions[i] = "";
    storeBySlot.set(i, pick.id);
    inCandidate.add(pick.id);
    titlesInCandidate.add(pick.title.toLowerCase());
  }
  for (const id of storeBySlot.values()) ctx.used.add(id);
  const storeSlots = [...storeBySlot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slotIndex, storeMealId]) => ({ slotIndex, storeMealId }));
  return {
    candidate: {
      ...candidate,
      mealTitles,
      ...(descriptions ? { mealDescriptions: descriptions } : {}),
      storeSlots,
    },
    violations,
    replaced: failing.length,
  };
}

/** The guard's pool from a shelf: its real ids (in order) with their titles. */
export function dietGuardPool(shelf: {
  forPrompt: readonly { id: string; title: string }[];
  aliasToId: ReadonlyMap<string, string>;
}): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const m of shelf.forPrompt) {
    const id = shelf.aliasToId.get(m.id);
    if (id) out.push({ id, title: m.title });
  }
  return out;
}

/**
 * The per-request guard a generate route applies to each reconciled candidate:
 * reads which shelf meals fit (one query, only when a diet applies) and returns
 * a function that checks, replaces or drops, and logs what it did.
 */
export async function createDietGuard(
  prisma: Pick<PrismaClient, "meal">,
  shelf: { forPrompt: readonly { id: string; title: string }[]; aliasToId: ReadonlyMap<string, string> },
  diets: readonly DietRestriction[],
  meta: { route: string; userId: string },
  opts: { avoidTitles?: readonly string[] } = {},
): Promise<(c: WizardPlanCandidate) => WizardPlanCandidate | null> {
  const avoidTitles = new Set((opts.avoidTitles ?? []).map((t) => t.toLowerCase()));
  if (diets.length === 0 && avoidTitles.size === 0) return (c) => c;
  const pool = dietGuardPool(shelf);
  // With no diet every shelf meal "fits"; only the repeat rule is in play.
  const fittingIds =
    diets.length === 0 ? new Set(pool.map((m) => m.id)) : await mealIdsFittingDiets(prisma, pool.map((m) => m.id), diets);
  const ctx: DietGuardContext = { diets, fittingIds, pool, used: new Set(), avoidTitles };
  return (c) => {
    const r = enforceDietOnCandidate(c, ctx);
    if (r.violations.length > 0) {
      logger.warn(
        {
          event: "wizard_diet_guard",
          route: meta.route,
          userId: meta.userId,
          candidateId: c.id,
          diets,
          violations: r.violations,
          replaced: r.replaced,
          dropped: r.candidate === null,
        },
        "A generated plan broke the user's diet or repeated a shown meal — slots replaced from the shelf, or the plan dropped",
      );
    }
    return r.candidate;
  };
}
