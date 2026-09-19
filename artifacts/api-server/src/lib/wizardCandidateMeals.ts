// D-WS9-191 Block 1 (Part A.4) — compose a candidate's wire `meals[]`.
//
// The chooser card is the review now: each meal row needs a title AND a
// one-line description at choose time. Phase 0 measured 93.2% of candidate
// slots store-bound (a real Meal.id with a DB description), so the description
// is a DB read for ~19 of 20 rows and the model only describes the live
// remainder. This is the ONE place the two sources meet, and it is pure: the
// shortlist pre-loads every shelf row's description + time keyed by real id
// (storeShortlist.ts descriptionById / timeById), so no query runs here and the
// stream path can compose synchronously between reconcile and the frame.
//
// Everything is additive: mealTitles and storeSlots are untouched (content hash,
// expand, the playlist rule, the last batch and the mobile .passthrough() all
// keep reading them); the raw model array `mealDescriptions` is consumed here
// and stripped from the wire object.

import type {
  WizardCandidateMealWire,
  WizardPlanCandidate,
  WizardPlanCandidateWire,
} from "./ai/schemas/wizard";
import { logger } from "./logger";

export interface ComposeCandidateMealsOptions {
  /** Real Meal.id → Meal.description (null/blank when the row has none). */
  descriptionById: ReadonlyMap<string, string | null>;
  /** Real Meal.id → the shelf row's estimatedTimeMinutes. */
  timeById?: ReadonlyMap<string, number>;
  /**
   * Row 5 Block 4 — real Meal.id → the shelf row's imageUrl (null until the
   * queue writes one). Absent map, or a null entry, → no `imageUrl` key on
   * the row and the card renders the ramp.
   */
  imageUrlById?: ReadonlyMap<string, string | null>;
  /** For the length-mismatch warn only. */
  userId?: string;
}

function nonBlank(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/**
 * Compose `meals` for ONE reconciled candidate (storeSlots already carry REAL
 * ids). Per slot, in mealTitles order:
 *   - store slot (marked in storeSlots): description = the DB row's, blank →
 *     null, `??` the model's non-empty entry `??` null; storeMealId = the real
 *     id; estimatedTimeMinutes = the shelf row's when known; imageUrl = the
 *     shelf row's when it has one (Row 5 Block 4 — the plan-option thumb).
 *   - live slot: the model's non-empty entry ?? null. No id, no time (a fresh
 *     title has no honest minutes yet — BUG-245), and NO image: a live slot
 *     has no Meal row, so there is nothing to show — never a sibling's, never
 *     a fetch. The card renders the ramp.
 * A `mealDescriptions` whose length differs from mealTitles is IGNORED for the
 * whole candidate (one warn) — never a dropped candidate.
 */
export function composeCandidateMeals(
  candidate: WizardPlanCandidate,
  opts: ComposeCandidateMealsOptions,
): WizardCandidateMealWire[] {
  const { mealTitles } = candidate;
  let modelDescriptions: string[] | null = candidate.mealDescriptions ?? null;
  if (modelDescriptions && modelDescriptions.length !== mealTitles.length) {
    logger.warn(
      {
        event: "wizard_candidate_descriptions_length_mismatch",
        userId: opts.userId,
        candidateId: candidate.id,
        mealTitles: mealTitles.length,
        mealDescriptions: modelDescriptions.length,
      },
      "mealDescriptions length differs from mealTitles — ignoring the model's array",
    );
    modelDescriptions = null;
  }
  const storeBySlot = new Map<number, string>();
  for (const s of candidate.storeSlots ?? []) {
    if (!storeBySlot.has(s.slotIndex)) storeBySlot.set(s.slotIndex, s.storeMealId);
  }
  return mealTitles.map((title, i) => {
    const modelEntry = nonBlank(modelDescriptions?.[i]);
    const realId = storeBySlot.get(i);
    if (realId === undefined) {
      return { title, description: modelEntry };
    }
    const stored = nonBlank(opts.descriptionById.get(realId));
    const time = opts.timeById?.get(realId);
    const imageUrl = nonBlank(opts.imageUrlById?.get(realId));
    return {
      title,
      description: stored ?? modelEntry,
      storeMealId: realId,
      ...(time !== undefined ? { estimatedTimeMinutes: time } : {}),
      ...(imageUrl !== null ? { imageUrl } : {}),
    };
  });
}

/**
 * The wire object for ONE reconciled candidate: `meals` composed, the raw
 * `mealDescriptions` stripped (the client never needs it), everything else
 * as-is.
 */
export function toWireCandidate(
  candidate: WizardPlanCandidate,
  opts: ComposeCandidateMealsOptions,
): WizardPlanCandidateWire {
  const { mealDescriptions: _consumed, ...rest } = candidate;
  return { ...rest, meals: composeCandidateMeals(candidate, opts) };
}

/** Batch form of toWireCandidate, order preserved. */
export function toWireCandidates(
  candidates: WizardPlanCandidate[],
  opts: ComposeCandidateMealsOptions,
): WizardPlanCandidateWire[] {
  return candidates.map((c) => toWireCandidate(c, opts));
}
