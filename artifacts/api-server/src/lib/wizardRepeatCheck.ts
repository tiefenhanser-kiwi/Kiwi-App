// WS9 BUG-249 — the per-generation cross-candidate repeat check.
//
// Hans: "When Kiwi generates plans, it shouldn't repeat the same meal across
// the plans it suggests." Measured before the prompt rule shipped: a repeat in
// 4 of 5 stored multi-candidate batches (n = 5), every one a shelf meal. The
// rule is a prompt rule (aiPrompts.ts, the distinctness paragraphs); this file
// is the INSTRUMENT that says whether it took. A deterministic rebind is the
// follow-up ONLY if the logged rate stays above about 1 in 10 after the reseed.
//
// ⚠️ OBSERVE ONLY. Nothing here changes a response, and nothing here throws:
// `logCandidateRepeatCheck` wraps everything, so a bug in the check costs one
// warn line, never a generation. A check-and-retry was rejected: runAICall's
// one retry ends in a 502 when exhausted, and the streamed path has already
// put cards on screen by the time the set is known.
import type { WizardPlanCandidate } from "./ai/schemas/wizard";
import { logger } from "./logger";

/** lowercase · trimmed · whitespace collapsed · punctuation stripped (to a space, so "sheet-pan" and "sheet pan" agree). */
export function normalizeMealTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RepeatEntry {
  /** The real catalog Meal.id (id repeats) or the normalised title (title repeats). */
  key: string;
  /** The title as it appeared in the first candidate that carried it. */
  title: string;
  /** Distinct candidate indices the meal appears in, ascending. */
  candidates: number[];
}

export interface CandidateRepeatReport {
  candidateCount: number;
  /** Distinct Kiwi-chosen meals that appear in more than one candidate. */
  repeatCount: number;
  repeatedIds: RepeatEntry[];
  repeatedTitles: RepeatEntry[];
  /** Repeats matching a user-named meal — by design (PRD §6.5 Scenario C). */
  exempted: RepeatEntry[];
}

/**
 * A user-named meal appears in every candidate BY DESIGN. `explicitMeals` is
 * free text and the model reproduces it "in spirit", so the match is
 * case-insensitive containment either direction — "tacos" exempts "Beef Street
 * Tacos" and "Street tacos with lime" exempts a named "street tacos".
 */
function isExplicit(title: string, explicitMeals: string[]): boolean {
  const t = normalizeMealTitle(title);
  if (t.length === 0) return false;
  for (const raw of explicitMeals) {
    const e = normalizeMealTitle(raw);
    if (e.length === 0) continue;
    if (t.includes(e) || e.includes(t)) return true;
  }
  return false;
}

/**
 * Pure: candidates in (post-reconcile, so storeMealId is a real Meal.id),
 * report out. A slot's identity is its `storeMealId` when it is a shelf slot,
 * else its normalised title. `repeatedTitles` is computed over EVERY slot so a
 * fresh title that copies a shelf meal in another candidate still shows; a
 * title repeat whose occurrences are all the same repeated shelf id is the
 * same meal seen twice and is not counted a second time.
 */
export function computeCandidateRepeats(
  candidates: ReadonlyArray<WizardPlanCandidate>,
  explicitMeals: ReadonlyArray<string> = [],
): CandidateRepeatReport {
  const byId = new Map<string, { title: string; candidates: Set<number> }>();
  const byTitle = new Map<
    string,
    { title: string; candidates: Set<number>; ids: Set<string | undefined> }
  >();

  candidates.forEach((c, ci) => {
    const idBySlot = new Map<number, string>();
    for (const s of c.storeSlots ?? []) idBySlot.set(s.slotIndex, s.storeMealId);
    c.mealTitles.forEach((title, si) => {
      const id = idBySlot.get(si);
      if (id !== undefined) {
        const e = byId.get(id) ?? { title, candidates: new Set<number>() };
        e.candidates.add(ci);
        byId.set(id, e);
      }
      const key = normalizeMealTitle(title);
      if (key.length === 0) return;
      const t = byTitle.get(key) ?? {
        title,
        candidates: new Set<number>(),
        ids: new Set<string | undefined>(),
      };
      t.candidates.add(ci);
      t.ids.add(id);
      byTitle.set(key, t);
    });
  });

  const explicit = [...explicitMeals];
  const repeatedIds: RepeatEntry[] = [];
  const repeatedTitles: RepeatEntry[] = [];
  const exempted: RepeatEntry[] = [];

  for (const [key, e] of byId) {
    if (e.candidates.size < 2) continue;
    const entry = { key, title: e.title, candidates: [...e.candidates].sort((a, b) => a - b) };
    (isExplicit(e.title, explicit) ? exempted : repeatedIds).push(entry);
  }
  const repeatedIdKeys = new Set(repeatedIds.map((r) => r.key));
  const exemptedIdKeys = new Set(exempted.map((r) => r.key));
  for (const [key, t] of byTitle) {
    if (t.candidates.size < 2) continue;
    // Every occurrence is the same shelf meal already reported by id.
    if (t.ids.size === 1) {
      const [only] = t.ids;
      if (only !== undefined && (repeatedIdKeys.has(only) || exemptedIdKeys.has(only))) continue;
    }
    const entry = { key, title: t.title, candidates: [...t.candidates].sort((a, b) => a - b) };
    (isExplicit(t.title, explicit) ? exempted : repeatedTitles).push(entry);
  }

  return {
    candidateCount: candidates.length,
    repeatCount: repeatedIds.length + repeatedTitles.length,
    repeatedIds,
    repeatedTitles,
    exempted,
  };
}

export interface LogCandidateRepeatCheckInput {
  /** The route, as its other summary lines name it. */
  route: string;
  path: "buffered" | "stream";
  promptKey: string;
  userId: string;
  candidates: ReadonlyArray<WizardPlanCandidate>;
  /** Directed only — `parsedIntent.explicitMeals`. */
  explicitMeals?: ReadonlyArray<string>;
}

/**
 * One line per multi-candidate generation, event `wizard_candidate_repeat_check`:
 * info when clean, warn when a repeat exists. Fewer than two candidates is not
 * a multi-candidate generation and logs nothing — a single plan has nothing to
 * repeat against, and a clean line for it would dilute the rate the follow-up
 * decision reads. Never throws.
 */
export function logCandidateRepeatCheck(input: LogCandidateRepeatCheckInput): void {
  try {
    if (input.candidates.length < 2) return;
    const report = computeCandidateRepeats(input.candidates, input.explicitMeals ?? []);
    const line = {
      event: "wizard_candidate_repeat_check",
      route: input.route,
      path: input.path,
      promptKey: input.promptKey,
      userId: input.userId,
      candidateCount: report.candidateCount,
      repeatCount: report.repeatCount,
      repeatedIds: report.repeatedIds,
      repeatedTitles: report.repeatedTitles,
      exempted: report.exempted,
    };
    if (report.repeatCount > 0) {
      logger.warn(line, "BUG-249: a Kiwi-chosen meal appears in more than one candidate");
    } else {
      logger.info(line, "BUG-249: candidates carry no repeated meal");
    }
  } catch (err) {
    logger.warn(
      { event: "wizard_candidate_repeat_check_failed", route: input.route, err },
      "BUG-249: repeat check threw; generation unaffected",
    );
  }
}
