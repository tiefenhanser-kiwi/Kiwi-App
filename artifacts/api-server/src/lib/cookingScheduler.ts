// WS7-8b BUG-018 B2 — deterministic Cooking Sequencer core.
//
// Pure, I/O-free, AI-free. Steps in -> ordered steps + serve-anchored offsets
// out. This REPLACES the Sonnet `sequencer.step_ordering` call: PRD §13.5.4/5
// [LOCKED] already say the Sequencer "runs deterministically on existing step
// data" and "optimizes for aligning finish times" — the AI was doing arithmetic
// it is bad at (BUG-018 corn cold; D-WS7-164 shorter roast started first).
//
// ── The problem shape (Phase 0 finding, Hans-endorsed) ──────────────────────
// ONE cook = a single resource with unattended gaps. Active steps SERIALIZE;
// only unattended steps overlap. "All finish times equal" is NOT achievable and
// is NOT the target. The enforced invariant is: nothing finishes MATERIALLY
// EARLY (no cold food / wilted salad). A dish finishing a little late is fine
// (food is hot); a dish finishing early is the bug.
//
// ── Attended vs unattended (the load-bearing classification) ────────────────
// A step OCCUPIES the cook's hands (serializes) when ATTENDED:
//   - phaseType `prep` or `assemble` (hands-on by definition), OR
//   - phaseType `cook` AND isTimingSensitive (a watched sear/deglaze).
// A step FREES the cook (overlappable) when UNATTENDED:
//   - phaseType `preheat` / `rest` / `hold` (hands-free by definition), OR
//   - phaseType `cook` AND NOT isTimingSensitive (an unattended boil / roast /
//     braise / grill — the cook sets it going and walks away).
// The `cook & !isTimingSensitive` clause EXTENDS Hans's ruling-#4 passive set
// ({rest,preheat,hold}) on purpose: BUG-018's 30-min grill is phaseType `cook`
// and MUST be overlappable for the corn boil to run alongside it, or the fix
// fails. This is exactly the "duration != attention" ruling — a 30-min braise
// is unattended, a 3-min sear is not. isTimingSensitive is the discriminator
// B1 restored for precisely this.

/** The six Prisma StepPhase values, inlined so this module stays dependency-free. */
export type SchedulerPhase =
  | "prep"
  | "preheat"
  | "cook"
  | "rest"
  | "assemble"
  | "hold";

/** One input step (a persisted RecipeInstructionStep, minus columns we ignore). */
export interface SchedulerStep {
  stepIndex: number;
  estimatedMinutes: number; // already >= 1 at the loader boundary
  phaseType: SchedulerPhase;
  isTimingSensitive: boolean;
}

/** One input dish: its identity/title/order plus its steps in stepIndex order. */
export interface SchedulerDish {
  dishId: string;
  title: string;
  positionIndex: number;
  steps: SchedulerStep[];
}

/** One scheduled output step — mirrors the wire SequencedStep (serve-anchored). */
export interface ScheduledStep {
  dishId: string;
  originalStepIndex: number;
  sequenceIndex: number;
  // Serve-anchored: 0 = serve (the latest finish), negative = before serve.
  // NEVER wall-clock, never a timezone (ruling #2) — a future consumer supplies T.
  startOffsetMinutes: number;
  // Deterministic parallel cue, only on a genuine cross-dish transition into a
  // passive window. Optional — most steps have none.
  reason?: string;
}

export interface ScheduleResult {
  steps: ScheduledStep[];
  // Wall-clock minutes from cook-start (t=0) to the last finish (serve).
  totalEstimatedMinutes: number;
}

/**
 * True when the step frees the cook's hands, so another dish's step may overlap it.
 *
 * ⚠️ DO NOT "tidy" this back to just {rest, preheat, hold}. The `cook &&
 * !isTimingSensitive` clause is load-bearing and IS the BUG-018 fix. Hans's
 * repro is a 30-min GRILL — phaseType `cook`. If a grill counts as attended,
 * the corn boil serializes behind it and comes out cold: BUG-018 reappears.
 * `isTimingSensitive` (restored in B1 for exactly this) is the discriminator —
 * an unattended grill/boil/braise is overlappable; a watched 3-min sear is not.
 * Duration ≠ attention, enforced in code. Removing this clause silently
 * reintroduces the bug with a green build.
 */
function isUnattended(step: SchedulerStep): boolean {
  switch (step.phaseType) {
    case "preheat":
    case "rest":
    case "hold":
      return true; // hands-free by definition
    case "cook":
      return !step.isTimingSensitive; // unattended braise/boil/grill; watched sear is attended
    case "prep":
    case "assemble":
      return false; // hands-on by definition
    default:
      return false;
  }
}

// Present-tense gerund for a passive window, used to compose a natural cue.
const GERUND: Record<SchedulerPhase, string> = {
  cook: "cooks",
  preheat: "heats up",
  rest: "rests",
  hold: "stays warm",
  prep: "comes together",
  assemble: "comes together",
};

interface WorkStep {
  dishIdx: number;
  dishId: string;
  dishTitle: string;
  step: SchedulerStep;
  idealStart: number; // finish-aligned target start (cook-start frame)
  actualStart: number; // after single-cook serialization
  finish: number;
  unattended: boolean;
}

/**
 * Compute a deterministic cooking sequence.
 *
 * Approach:
 *  1. anchor = max dish duration (the dish that gates the meal). This is the
 *     serve time in the cook-start frame. Ignoring roleLabel entirely (Hans's
 *     ruling: the serve anchor is a scheduling concept, not a semantic one — a
 *     40-min side gates the meal exactly as hard as a 40-min entree).
 *  2. Finish-align: every dish must FINISH at the anchor, so dish i's steps
 *     start at (anchor - dishDuration_i) and run back-to-back. This alone fixes
 *     both regressions: the longer dish starts first (D-WS7-164) and a short
 *     side is pushed late enough not to finish early (BUG-018).
 *  3. Single-cook pass: walk steps in idealStart order; ATTENDED steps occupy
 *     the cook (serialize via a busy clock), UNATTENDED steps are kicked off
 *     when the cook is momentarily free but then run in the background. This can
 *     only push starts LATER than ideal, so no dish finishes before the anchor
 *     -> nothing finishes materially early. It also guarantees no step overlaps
 *     an isTimingSensitive step's active window (that window holds the cook).
 *  4. Emit in actualStart order with serve-anchored offsets + passive-window cues.
 */
export function scheduleCookingSequence(
  dishes: SchedulerDish[],
): ScheduleResult {
  // Guard: no dishes / no steps -> empty schedule (caller handles empties).
  const nonEmpty = dishes.filter((d) => d.steps.length > 0);
  if (nonEmpty.length === 0) {
    return { steps: [], totalEstimatedMinutes: 0 };
  }

  // 1. Per-dish duration + anchor.
  const dishDuration = nonEmpty.map((d) =>
    d.steps.reduce((sum, s) => sum + s.estimatedMinutes, 0),
  );
  const anchor = Math.max(...dishDuration);

  // 2. Finish-aligned ideal starts (each dish finishes at `anchor`).
  const work: WorkStep[] = [];
  nonEmpty.forEach((dish, dishIdx) => {
    let cursor = anchor - dishDuration[dishIdx]; // dish base start
    for (const step of dish.steps) {
      work.push({
        dishIdx,
        dishId: dish.dishId,
        dishTitle: dish.title,
        step,
        idealStart: cursor,
        actualStart: cursor, // provisional; fixed in pass 3
        finish: cursor + step.estimatedMinutes,
        unattended: isUnattended(step),
      });
      cursor += step.estimatedMinutes;
    }
  });

  // Priority order for the single-cook pass: earliest ideal start first, then
  // stable by dish position then stepIndex (fully deterministic tie-break).
  const priority = [...work].sort(
    (a, b) =>
      a.idealStart - b.idealStart ||
      a.dishIdx - b.dishIdx ||
      a.step.stepIndex - b.step.stepIndex,
  );

  // 3. Single-cook forward simulation.
  //    cookBusyUntil: the minute the cook's hands are next free.
  //    dishFreeAt[i]: the minute dish i's next step may begin (prev step done).
  let cookBusyUntil = 0;
  const dishFreeAt = new Array<number>(nonEmpty.length).fill(0);
  for (const w of priority) {
    // A step can't begin before its own dish's previous step finished, before
    // its finish-aligned ideal start, or before the cook is free to touch it
    // (even an unattended step needs a moment of hands to kick off).
    const start = Math.max(
      w.idealStart,
      dishFreeAt[w.dishIdx],
      cookBusyUntil,
    );
    w.actualStart = start;
    w.finish = start + w.step.estimatedMinutes;
    dishFreeAt[w.dishIdx] = w.finish;
    // Attended steps hold the cook for their whole duration; unattended steps
    // release the cook immediately after kickoff (they run in the background).
    if (!w.unattended) {
      cookBusyUntil = w.finish;
    }
  }

  // 4. Emit. Serve anchor = the actual latest finish (serialization may have
  //    pushed it past `anchor`; recompute so offsets are truthful).
  const serveAnchor = Math.max(...work.map((w) => w.finish));

  const ordered = [...work].sort(
    (a, b) =>
      a.actualStart - b.actualStart ||
      a.dishIdx - b.dishIdx ||
      a.step.stepIndex - b.step.stepIndex,
  );

  const steps: ScheduledStep[] = ordered.map((w, seqIdx) => {
    const entry: ScheduledStep = {
      dishId: w.dishId,
      originalStepIndex: w.step.stepIndex,
      sequenceIndex: seqIdx,
      startOffsetMinutes: w.actualStart - serveAnchor,
    };
    const cue = composeCue(w, ordered, seqIdx);
    if (cue) entry.reason = cue;
    return entry;
  });

  return { steps, totalEstimatedMinutes: serveAnchor };
}

/**
 * Compose a passive-window cue for a cross-dish transition: when this step
 * (dish X) starts while a DIFFERENT dish Y is mid-unattended-step, tell the cook
 * to use that free window. Deterministic + conservative — only fires on a real
 * dish switch into an open passive window, so most steps carry no cue.
 */
function composeCue(
  w: WorkStep,
  ordered: WorkStep[],
  seqIdx: number,
): string | undefined {
  if (seqIdx === 0) return undefined;
  const prev = ordered[seqIdx - 1];
  if (prev.dishId === w.dishId) return undefined; // same dish, no hand-off cue

  // Find any OTHER dish's unattended step still running when this one starts.
  const window = ordered.find(
    (o) =>
      o.dishId !== w.dishId &&
      o.unattended &&
      o.actualStart <= w.actualStart &&
      o.finish > w.actualStart,
  );
  if (!window) return undefined;

  const gerund = GERUND[window.step.phaseType] ?? "cooks";
  const cue = `While the ${window.dishTitle} ${gerund}, start on the ${w.dishTitle}.`;
  // Hard cap mirrors the wire schema's reason max (140).
  return cue.length <= 140 ? cue : undefined;
}
