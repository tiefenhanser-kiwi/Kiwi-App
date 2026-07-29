// WS9 3c follow-up (BUG-053, Parts B + F) — session-scoped re-roll exclusion.
//
// A re-roll (surprise "Surprise Me again", or the standard wizard "More
// options ↺") must not return a plan already shown in THIS session — not merely
// the immediately-previous one. The client accumulates every shown plan's title
// + meal titles and sends them so the next generation excludes them.
//
// Deduped by plan title and keyed on the ARRIVING candidate(s), never on the
// re-roll `attempt` counter: attempt bumps before the new generation's data
// lands, so an attempt-keyed accumulator would re-count the stale, still-shown
// plan (the exact class of bug the auto-expand effect had — see Part A).

export interface SessionExclusion {
  /** Plan-level titles already shown this session. */
  planTitles: string[];
  /** Meal titles across all shown plans this session. */
  mealTitles: string[];
}

export const EMPTY_SESSION_EXCLUSION: SessionExclusion = {
  planTitles: [],
  mealTitles: [],
};

/** Request-body shape the generate endpoints accept (optional fields). */
export interface ExclusionRequest {
  excludePlanTitles: string[];
  excludeMealTitles: string[];
}

/** Map the accumulated session exclusion onto the request-body field names. */
export function toExclusionRequest(ex: SessionExclusion): ExclusionRequest {
  return {
    excludePlanTitles: ex.planTitles,
    excludeMealTitles: ex.mealTitles,
  };
}

/**
 * Fold the just-shown plan(s) into the running session exclusion. Accepts an
 * array so it serves both surprise (one candidate per generation) and the
 * standard wizard (three). Returns the SAME reference when nothing is new, so a
 * React effect can skip a redundant state write.
 */
export function accumulateShownPlans(
  prev: SessionExclusion,
  shown: ReadonlyArray<{ title: string; mealTitles: string[] }>,
): SessionExclusion {
  const seenPlans = new Set(prev.planTitles);
  const freshPlans = shown.filter((c) => c.title && !seenPlans.has(c.title));
  if (freshPlans.length === 0) return prev;

  const seenMeals = new Set(prev.mealTitles);
  const freshMeals: string[] = [];
  for (const c of freshPlans) {
    for (const m of c.mealTitles) {
      if (m && !seenMeals.has(m)) {
        seenMeals.add(m);
        freshMeals.push(m);
      }
    }
  }

  return {
    planTitles: [...prev.planTitles, ...freshPlans.map((c) => c.title)],
    mealTitles: [...prev.mealTitles, ...freshMeals],
  };
}
