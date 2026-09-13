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
//
// ── Intra-dish overlap: `parallelGroup` (WS9 D-WS9-239, Phase 1a) ──────────
// Until D-WS9-239 a dish's own steps ran strictly back-to-back, so "preheat
// the oven 15 min" followed by "dice the onion" cost 15 + N minutes even
// though the recipe's own prose says "while the oven heats". Measured on the
// catalog (Phase 0/0b, ~1,200 public dinners): the serial-within-dish walk
// overstates the stored total by a median of ~20 minutes on the meals a
// tagger marked, and the mobile app shows that number to the shopper.
//
// A `parallelGroup` token names a WINDOW step and rides on later RIDER steps of
// the SAME dish (rule set measured in Phase 0b — do not redesign it here):
//   1. The token's FIRST occurrence in the dish is the window; the window must
//      be UNATTENDED by the predicate above.
//   2. Riders are the CONTIGUOUS same-token steps after the window. A rider may
//      start when the window is KICKED OFF, not when it finishes. Attended riders
//      still serialize on the cook; unattended riders are kicked off and run in
//      the background.
//   3. The first step after the group carrying no token (or a different one)
//      waits for max(finish) of the window and every rider.
//   4. INVALID TAGS ARE IGNORED — never honoured, never thrown. A step that
//      loses its tag is simply untagged, i.e. it waits: the number can only stay
//      the same or get MORE conservative. The invalid shapes are enumerated on
//      `IgnoredTagReason` below.
//   5. Active time is unchanged: Σ attended is the same sum regardless of overlap.
//   6. THE ANOMALY GUARD: the meal is scheduled TWICE — once honouring tags,
//      once ignoring them — and the SHORTER total is emitted. Phase 0 measured
//      one meal (of 160) that a VALID tag made 3 minutes LONGER: a dish shrank,
//      its finish-aligned start moved later into a busier stretch of the
//      single-cook pass. The guard makes "a tag can only help" true by
//      construction rather than by luck.
//   7. Tags never cross dishes: a token is classified per dish, so the same
//      token name in two dishes is two independent groups, never one.
// With no tags anywhere (the state of every row until 1c tags the catalog), the
// tag-aware passes reduce EXACTLY to the serial walk they replaced — the §5.1
// acceptance for Phase 1a was 1,202/1,202 derived totals byte-identical.
//
// This module stays dependency-free: it does not import a logger. Invalid tags
// come back on `ignoredTags` and the CALLER decides whether to log them.

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
  // WS9 D-WS9-239 — intra-dish overlap token (see the header). Optional and
  // nullable so every pre-existing caller/fixture is untouched: absent, null,
  // or an empty string all mean "untagged".
  parallelGroup?: string | null;
  // Block 3.7 (D-WS9-066) swappable-component tags, read here ONLY for two
  // tag-validity rules (same-component rest/hold, path agreement). Null/absent
  // = base (always in the recipe; rides with anything).
  componentKey?: string | null;
  pathKey?: string | null;
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

// WS9 D-WS9-239 — why a `parallelGroup` tag was NOT honoured (rule 4). Every
// reason is a tag the scheduler ignored; the step it names simply waited.
export type IgnoredTagReason =
  // The token contains whitespace or a list separator — more than one token on
  // a step, or a malformed one. A tag is ONE bare token.
  | "malformed_token"
  // The token's first occurrence in the dish is an ATTENDED step, so there is
  // no window to ride. Every occurrence of the token is dropped (a later
  // unattended occurrence is a rider that precedes its window, not a window).
  | "attended_window"
  // A `rest`/`hold` step immediately after a `cook` window, tagged to ride it,
  // where both carry the SAME componentKey: a rest cannot start when its own
  // cook is kicked off. Narrowed to same-component in Phase 0b — the unnarrowed
  // rule false-positived on a rest belonging to a different component.
  | "rest_rides_cook"
  // The rider's pathKey differs from the window's and neither is null (base is
  // null and rides with anything): a scratch step cannot ride a bought window.
  | "path_mismatch"
  // The token re-appears after its group closed (an untagged / different-token
  // / rejected step sat in between). Contiguity: honouring it would let a step
  // start before the untagged step that closed the group — the author's order.
  | "reopened_group"
  // A window with no surviving riders. Harmless (nothing rides it) but a tag
  // the scheduler did not use, so it is reported.
  | "lone_token"
  // The tags were all valid but honouring them made the MEAL longer (rule 6);
  // the untagged schedule was emitted instead. Reported once per window.
  | "anomaly_guard";

export interface IgnoredTag {
  dishId: string;
  stepIndex: number;
  token: string;
  reason: IgnoredTagReason;
}

export interface ScheduleResult {
  steps: ScheduledStep[];
  // Wall-clock minutes from cook-start (t=0) to the last finish (serve).
  totalEstimatedMinutes: number;
  // WS9 D-WS9-235 — HANDS-ON minutes: the sum of every ATTENDED step, i.e. the
  // time the cook is actually occupied. Unattended steps run in the background
  // and are excluded, which is why this is normally far below
  // totalEstimatedMinutes (a 55-minute bake costs 0 attended minutes).
  //
  // ⚠️ COMPUTED HERE, BESIDE isUnattended, ON PURPOSE. Hans's ruling is that
  // the derived numbers use THIS module's parallelism rules — "we did a lot of
  // work on this and what counts as parallel or not, so the rules are there".
  // Any caller that summed attended minutes itself would be a second copy of
  // the predicate, free to drift from the one the schedule is actually built
  // from. Callers read this field; they never re-derive it.
  activeEstimatedMinutes: number;
  // WS9 D-WS9-239 — each dish's duration ALONE (its critical path once tags
  // are honoured; the serial sum when it carries none), keyed by dishId. This
  // is the number `Dish.estimatedTimeMinutes` is stamped from: a caller that
  // summed a dish's steps itself would stamp a tagged single-dish meal's dish
  // LONGER than the meal. Only dishes with at least one step appear.
  dishDurations: Record<string, number>;
  // WS9 D-WS9-239 — every tag the schedule did not honour, with why (rule 4).
  // Empty on an untagged meal. Callers log these at warn; this module does not.
  ignoredTags: IgnoredTag[];
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

// ── D-WS9-239 tag classification (rule 4: invalid → untagged, reported) ─────

type StepKind =
  | { kind: "plain" }
  | { kind: "window" }
  | { kind: "rider"; windowIdx: number }; // windowIdx = ARRAY index into dish.steps

// A tag is one bare token. Whitespace or a list separator inside it means the
// model put more than one token on the step (or mangled one) — malformed.
const MALFORMED_TOKEN = /[\s,;|]/;

/** Trim the stored tag; absent / null / empty / whitespace-only = untagged. */
function rawToken(step: SchedulerStep): string | null {
  const t = step.parallelGroup;
  if (t === undefined || t === null) return null;
  const trimmed = t.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Classify one dish's steps into plain / window / rider per the D-WS9-239 rule
 * set, dropping every invalid tag into `ignored` (rule 4). Pure; per dish
 * (rule 7 — a token never links steps across dishes).
 *
 * Order of the rules matters and mirrors the Phase 0b derivation that produced
 * the measured numbers: attended-window drops the whole token first; then the
 * contiguous run after the window is walked, rejecting a same-component
 * rest/hold immediately after a cook window and a path-mismatched rider — each
 * rejection is a hole, and a hole CLOSES the group, so every later same-token
 * step is `reopened_group`; finally a window left with no riders is a
 * `lone_token`.
 */
function classifyDish(
  dish: SchedulerDish,
  honourTags: boolean,
  ignored: IgnoredTag[],
): StepKind[] {
  const steps = dish.steps;
  const kinds: StepKind[] = steps.map(() => ({ kind: "plain" }));
  if (!honourTags) return kinds;

  // 1. Tokens per step, malformed ones dropped.
  const tokens: (string | null)[] = steps.map((s, k) => {
    const t = rawToken(s);
    if (t !== null && MALFORMED_TOKEN.test(t)) {
      ignored.push({ dishId: dish.dishId, stepIndex: steps[k].stepIndex, token: t, reason: "malformed_token" });
      return null;
    }
    return t;
  });

  // 2. A token whose FIRST occurrence is attended has no window: drop it everywhere.
  const firstIdx = new Map<string, number>();
  tokens.forEach((t, k) => {
    if (t !== null && !firstIdx.has(t)) firstIdx.set(t, k);
  });
  for (const [t, w] of firstIdx) {
    if (!isUnattended(steps[w])) {
      tokens.forEach((tk, k) => {
        if (tk === t) {
          ignored.push({ dishId: dish.dishId, stepIndex: steps[k].stepIndex, token: t, reason: "attended_window" });
          tokens[k] = null;
        }
      });
      firstIdx.delete(t);
    }
  }

  // 3. Walk each window's contiguous run; a rejected rider is a hole that
  //    closes the group. Anything carrying the token after the group closed
  //    (a re-appearance) is dropped for contiguity.
  for (let k = 0; k < steps.length; k++) {
    const t = tokens[k];
    if (t === null) continue;
    if (firstIdx.get(t) !== k) continue; // not a window (riders are handled inside the walk)
    const w = k;
    const wStep = steps[w];
    let riders = 0;
    let j = w + 1;
    for (; j < steps.length && tokens[j] === t; j++) {
      const rStep = steps[j];
      // Same-component rest/hold immediately after a cook window (Phase 0b narrowing).
      if (
        j === w + 1 &&
        wStep.phaseType === "cook" &&
        (rStep.phaseType === "rest" || rStep.phaseType === "hold") &&
        (wStep.componentKey ?? null) === (rStep.componentKey ?? null)
      ) {
        ignored.push({ dishId: dish.dishId, stepIndex: rStep.stepIndex, token: t, reason: "rest_rides_cook" });
        tokens[j] = null;
        j++;
        break; // hole → the group closes here
      }
      // Path agreement: base (null) rides with anything; scratch never rides bought.
      const pw = wStep.pathKey ?? null;
      const pr = rStep.pathKey ?? null;
      if (pw !== null && pr !== null && pw !== pr) {
        ignored.push({ dishId: dish.dishId, stepIndex: rStep.stepIndex, token: t, reason: "path_mismatch" });
        tokens[j] = null;
        j++;
        break; // hole → the group closes here
      }
      kinds[j] = { kind: "rider", windowIdx: w };
      riders++;
    }
    // Every later occurrence of the token is a re-opened group → dropped.
    for (let m = j; m < steps.length; m++) {
      if (tokens[m] === t) {
        ignored.push({ dishId: dish.dishId, stepIndex: steps[m].stepIndex, token: t, reason: "reopened_group" });
        tokens[m] = null;
      }
    }
    if (riders === 0) {
      ignored.push({ dishId: dish.dishId, stepIndex: wStep.stepIndex, token: t, reason: "lone_token" });
      tokens[w] = null;
    } else {
      kinds[w] = { kind: "window" };
    }
  }
  return kinds;
}

// ── the dish alone (per-dish critical path + offsets) ───────────────────────

interface DishAlone {
  kinds: StepKind[];
  offsets: number[]; // start of each step, dish-start frame
  finishes: number[];
  duration: number; // critical path = max finish (== Σ when untagged)
}

/**
 * Walk one dish on its own: each step's earliest start given the dish's prior
 * steps, with the cook's hands modelled inside the dish (attended steps
 * serialize; an unattended step still needs a free hand to kick off, so it is
 * pushed past any attended interval it lands in). With no tags every step's
 * earliest start is the previous step's finish, so this is exactly the old
 * running-cursor walk and `duration` is the serial sum.
 */
function walkDishAlone(dish: SchedulerDish, kinds: StepKind[]): DishAlone {
  const steps = dish.steps;
  const offsets: number[] = [];
  const finishes: number[] = [];
  const attendedIntervals: [number, number][] = [];
  let cookBusy = 0;
  for (let k = 0; k < steps.length; k++) {
    const kind = kinds[k];
    let start: number;
    if (kind.kind === "rider") {
      start = offsets[kind.windowIdx]; // window KICKOFF, not finish
    } else {
      start = 0;
      for (let j = 0; j < k; j++) start = Math.max(start, finishes[j]);
    }
    if (isUnattended(steps[k])) {
      // Kickoff needs a free hand: push past every attended interval it lands in.
      let moved = true;
      while (moved) {
        moved = false;
        for (const [s, f] of attendedIntervals) {
          if (s <= start && start < f) {
            start = f;
            moved = true;
          }
        }
      }
    } else {
      start = Math.max(start, cookBusy);
    }
    offsets[k] = start;
    finishes[k] = start + steps[k].estimatedMinutes;
    if (!isUnattended(steps[k])) {
      cookBusy = finishes[k];
      attendedIntervals.push([start, finishes[k]]);
    }
  }
  return {
    kinds,
    offsets,
    finishes,
    duration: finishes.length ? Math.max(...finishes) : 0,
  };
}

interface WorkStep {
  dishIdx: number;
  dishId: string;
  dishTitle: string;
  stepIdx: number; // ARRAY index within its dish
  step: SchedulerStep;
  kind: StepKind;
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
 *     40-min side gates the meal exactly as hard as a 40-min entree). A dish's
 *     duration is its CRITICAL PATH from the dish-alone walk (D-WS9-239) —
 *     the serial sum when it carries no tags.
 *  2. Finish-align: every dish must FINISH at the anchor, so dish i's steps
 *     start at (anchor - dishDuration_i + offset_k). This alone fixes both
 *     regressions: the longer dish starts first (D-WS7-164) and a short side
 *     is pushed late enough not to finish early (BUG-018).
 *  3. Single-cook pass: walk steps in idealStart order; ATTENDED steps occupy
 *     the cook (serialize via a busy clock), UNATTENDED steps are kicked off
 *     when the cook is momentarily free but then run in the background. This can
 *     only push starts LATER than ideal, so no dish finishes before the anchor
 *     -> nothing finishes materially early. It also guarantees no step overlaps
 *     an isTimingSensitive step's active window (that window holds the cook).
 *  4. Emit in actualStart order with serve-anchored offsets + passive-window cues.
 *
 * D-WS9-239: steps 1–4 run twice — tags honoured, tags ignored — and the
 * shorter total wins (rule 6). The two runs are identical when nothing is tagged.
 */
export function scheduleCookingSequence(
  dishes: SchedulerDish[],
): ScheduleResult {
  // Guard: no dishes / no steps -> empty schedule (caller handles empties).
  const nonEmpty = dishes.filter((d) => d.steps.length > 0);
  if (nonEmpty.length === 0) {
    return {
      steps: [],
      totalEstimatedMinutes: 0,
      activeEstimatedMinutes: 0,
      dishDurations: {},
      ignoredTags: [],
    };
  }

  const anyTag = nonEmpty.some((d) => d.steps.some((s) => rawToken(s) !== null));
  const untagged = scheduleOnce(nonEmpty, false);
  if (!anyTag) return untagged; // byte-identical to the pre-D-WS9-239 path

  const tagged = scheduleOnce(nonEmpty, true);
  // Rule 6 — the anomaly guard. A tie keeps the tagged schedule: it is the
  // order the recipe's own prose describes, and it costs nothing.
  if (tagged.totalEstimatedMinutes <= untagged.totalEstimatedMinutes) {
    return tagged;
  }
  // Report every window whose (valid) tag the guard set aside, then return the
  // untagged schedule — including its serial per-dish durations, so the dish
  // stamps stay consistent with the meal's.
  const guarded: IgnoredTag[] = [...tagged.ignoredTags];
  for (const d of nonEmpty) {
    const kinds = classifyDish(d, true, []);
    kinds.forEach((k, i) => {
      if (k.kind === "window") {
        guarded.push({
          dishId: d.dishId,
          stepIndex: d.steps[i].stepIndex,
          token: rawToken(d.steps[i]) ?? "",
          reason: "anomaly_guard",
        });
      }
    });
  }
  return { ...untagged, ignoredTags: guarded };
}

function scheduleOnce(
  nonEmpty: SchedulerDish[],
  honourTags: boolean,
): ScheduleResult {
  const ignoredTags: IgnoredTag[] = [];

  // 1. Per-dish walk (critical path) + anchor.
  const alone = nonEmpty.map((d) =>
    walkDishAlone(d, classifyDish(d, honourTags, ignoredTags)),
  );
  const anchor = Math.max(...alone.map((a) => a.duration));

  // 2. Finish-aligned ideal starts (each dish finishes at `anchor`).
  const work: WorkStep[] = [];
  nonEmpty.forEach((dish, dishIdx) => {
    const base = anchor - alone[dishIdx].duration; // dish base start
    dish.steps.forEach((step, stepIdx) => {
      const idealStart = base + alone[dishIdx].offsets[stepIdx];
      work.push({
        dishIdx,
        dishId: dish.dishId,
        dishTitle: dish.title,
        stepIdx,
        step,
        kind: alone[dishIdx].kinds[stepIdx],
        idealStart,
        actualStart: idealStart, // provisional; fixed in pass 3
        finish: idealStart + step.estimatedMinutes,
        unattended: isUnattended(step),
      });
    });
  });

  // Priority order for the single-cook pass: earliest ideal start first, then
  // stable by dish position then stepIndex (fully deterministic tie-break).
  // Within a dish this order always places a step's dependencies first: a plain
  // step's offset is past every prior finish, a rider's is at or past its
  // window's kickoff, and ties fall to stepIndex.
  const priority = [...work].sort(
    (a, b) =>
      a.idealStart - b.idealStart ||
      a.dishIdx - b.dishIdx ||
      a.step.stepIndex - b.step.stepIndex,
  );

  // 3. Single-cook forward simulation.
  //    cookBusyUntil: the minute the cook's hands are next free.
  //    placed[i][k]: dish i's step k once scheduled (its actual start/finish).
  let cookBusyUntil = 0;
  const placed = nonEmpty.map((d) => new Array<WorkStep | undefined>(d.steps.length));
  for (const w of priority) {
    // A step can't begin before its own dish allows it — a rider at its
    // window's kickoff, anything else once every prior step of the dish has
    // finished — nor before its finish-aligned ideal start, nor before the cook
    // is free to touch it (even an unattended step needs a moment of hands to
    // kick off).
    const mine = placed[w.dishIdx];
    let earliest = 0;
    if (w.kind.kind === "rider") {
      earliest = mine[w.kind.windowIdx]?.actualStart ?? 0;
    } else {
      for (let j = 0; j < w.stepIdx; j++) {
        earliest = Math.max(earliest, mine[j]?.finish ?? 0);
      }
    }
    const start = Math.max(w.idealStart, earliest, cookBusyUntil);
    w.actualStart = start;
    w.finish = start + w.step.estimatedMinutes;
    mine[w.stepIdx] = w;
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

  // WS9 D-WS9-235 — attended minutes, from the SAME `unattended` flag the
  // schedule above was built from (set by isUnattended at window-build time).
  // Summed rather than measured off the timeline because attended steps
  // serialize by construction — cookBusyUntil advances by exactly this much —
  // so the sum and the occupied-timeline length are the same number.
  const activeEstimatedMinutes = work.reduce(
    (sum, w) => (w.unattended ? sum : sum + w.step.estimatedMinutes),
    0,
  );

  const dishDurations: Record<string, number> = {};
  nonEmpty.forEach((d, i) => {
    dishDurations[d.dishId] = alone[i].duration;
  });

  return {
    steps,
    totalEstimatedMinutes: serveAnchor,
    activeEstimatedMinutes,
    dishDurations,
    ignoredTags,
  };
}

/**
 * Compose a passive-window cue for a cross-dish transition: when this step
 * (dish X) starts while a DIFFERENT dish Y is mid-unattended-step, tell the cook
 * to use that free window. Deterministic + conservative — only fires on a real
 * dish switch into an open passive window, so most steps carry no cue.
 *
 * D-WS9-239 adds NO intra-dish cue on purpose: the step text already says
 * "while the potatoes bake" in its own words.
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
