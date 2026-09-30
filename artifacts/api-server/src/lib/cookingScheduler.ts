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
// is NOT the target. The enforced invariant is: nothing HOT finishes MATERIALLY
// EARLY (no cold food / wilted salad). A dish finishing a little late is fine
// (food is hot); a hot dish finishing early is the bug.
//
// ── Two later amendments to that invariant (WS9 BUG-337 / D-WS9-297) ────────
//  • A SERVED-COLD dish is exempt and is pulled FORWARD instead (ruling 3):
//    pico is meant to sit, and finish-aligning it was what left a 30-minute
//    marinade with 27 idle minutes. See `isServedCold`.
//  • "Late is fine" was only ever true BETWEEN dishes. WITHIN a dish, a step
//    that drifts from its own predecessor is a cooling steak, so a LATEST bound
//    now caps that lag (ruling 1). See LAG_AFTER_HEAT_REST.
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
// ── Swappable components: BASE + ONE path, never both (WS9 BUG-270) ─────────
// A store-filled dish can carry a swappable component (Block 3.7, D-WS9-066):
// its from-scratch steps are tagged `pathKey: "scratch"`, the 1–3 steps that
// use the bought product instead are tagged `pathKey: "bought"`, and everything
// else is base (null). The two paths are ALTERNATIVES — the prompt's own rule
// is "BASE + all SCRATCH steps = the full from-scratch dish; BASE + a
// component's BOUGHT steps = a real dish using that product". Until BUG-270
// this module walked every step it was handed, so a dual-path dish was
// scheduled as if one cook shredded the cabbage AND opened the bag: measured on
// the catalog, 1,655 dishes stored a time nobody cooks (a 53-minute quesadilla
// dish = base 20 + scratch 25 + bought 8, where the from-scratch cook does 45).
//
// The rule: a dish's schedule is BASE + the DEFAULT path. The default is
// from-scratch — the schema's "absent selection = scratch" and the prompt's
// primary recipe — so `bought` steps are dropped at THIS module's input, once,
// before classification, and every consumer (the save-time stamp, the backfill,
// Cook Mode's sequence) inherits it. Only the literal "bought" is excluded: an
// unrecognised value stays in and reads LONG, never short. This is not "store
// two times" (D-WS9-235 rules one derived pair per meal); showing the bought
// path's time when a user flips D-WS9-148's toggle is WS9B's decision.
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
  /**
   * D-WS9-297 ruling 2 — the step's own prose, read ONLY to say what a dish is
   * doing in a cue ("While the steak is resting"). Optional on purpose: the
   * timing derivation (`mealTiming.ts`) and every pre-existing fixture pass none,
   * and a cue is emitted text that moves no total, so an absent `text` changes
   * no number anywhere. Never parsed for quantities, order or duration.
   */
  text?: string | null;
}

/** One input dish: its identity/title/order plus its steps in stepIndex order. */
export interface SchedulerDish {
  dishId: string;
  title: string;
  positionIndex: number;
  steps: SchedulerStep[];
  /**
   * D-WS9-297 ruling 3 — MealDishLink.roleLabel, carried for the served-cold
   * predicate. See `isServedCold` for why it turned out not to discriminate;
   * kept on the input shape because the ruling names it and a later refinement
   * (a real servedTemperature column) would land here.
   */
  roleLabel?: string | null;
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
  // Since BUG-270 drops every `bought` step before classification, this is
  // reachable only for a pathKey outside the {scratch, bought} enum — kept as
  // the defensive guard it always was, not removed.
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

/** Knobs on the scheduler. Production passes none; every default is the shipped behaviour. */
export interface ScheduleOptions {
  /**
   * D-WS9-297 ruling 1 — the latest bound. Defaults TRUE. Set false only to
   * price the bound (which meals grow) or to drive the §BREAK test; no
   * production caller passes it.
   */
  enforceMaxLag?: boolean;
  /**
   * D-WS9-297 ruling 3 — pull served-cold dishes forward instead of
   * finish-aligning them. Defaults TRUE. Same two callers as above.
   */
  coldDishesForward?: boolean;
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
 *
 * WS9 D-WS9-239 (1b) — EXPORTED so parallelGroupDerive.ts (the firstDependent
 * → parallelGroup derivation) applies THIS predicate to a generator's output
 * rather than carrying a second copy. Widened to the two fields it reads.
 */
export function isUnattended(
  step: Pick<SchedulerStep, "phaseType" | "isTimingSensitive">,
): boolean {
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

// WS9 BUG-270 — the one pathKey value whose steps are NOT part of the default
// (from-scratch) recipe. Exported for the measurement scripts; the scheduler
// itself is the only runtime caller.
export const EXCLUDED_PATH_KEY = "bought";

// ── WS9 BUG-337 / D-WS9-297 ruling 1 — the latest bound, in minutes ─────────
// A step whose own dish-predecessor is a heat (`cook`) step must begin within
// this many minutes of it. `rest` is tighter than everything else because a rest
// that starts late is not a rest: the meat has already cooled, which is the
// whole defect BUG-337 names. Exported so the measurement scripts and the tests
// state the same numbers the scheduler enforces rather than copies of them.
export const LAG_AFTER_HEAT_REST = 2;
export const LAG_AFTER_HEAT_OTHER = 5;
/** Belt on the repair loop; `pull` is monotone decreasing, so this never binds in practice. */
const MAX_LAG_ITERATIONS = 8;

/**
 * The steps a cook actually does: base (null path) + ONE path per swappable
 * component. Order and stepIndex are preserved, so every emitted
 * `originalStepIndex` still names a persisted row.
 *
 * WS9 BUG-270 — applied ONCE, at `scheduleCookingSequence`'s input, so every
 * consumer inherits it (see the header). Exported so a script can measure
 * "what the scheduler will see" without re-implementing the predicate.
 *
 * ── D-WS9-277 RULE 3 / BUG-121 / BUG-322 (D-WS9-284 ruling 10) ──────────────
 *
 * Hans: "if no shortcut, or no from scratch, just show that's there. but to your
 * specific point, if only shortcut, show shortcut."
 *
 * This function used to drop `bought` UNCONDITIONALLY, and 10 components on dev
 * have a bought path and no scratch one. The failure that produced was not an
 * empty dish — every one of those dishes kept 7 to 11 of its steps and scheduled
 * normally. It was a SILENTLY INCOMPLETE RECIPE: Classic Chicken Noodle Soup
 * scheduled with no broth step at all, Broccoli Cheddar Soup with no broccoli
 * step. An empty dish is visible; a recipe missing the step that makes one of
 * its components is not.
 *
 * So the rule is per COMPONENT, not per step: a `bought` step is dropped only
 * when its own component has a scratch alternative to prefer.
 *
 * A `bought` step carrying NO componentKey is still dropped — it belongs to no
 * component, so there is nothing to ask the question about, and `storeFill`'s
 * `incomplete_tag` check already strips that shape at authoring time. Measured
 * on dev: 0 such rows, and 0 with a componentKey but no pathKey.
 */
export function selectDefaultPathSteps<
  T extends Pick<SchedulerStep, "pathKey" | "componentKey">,
>(steps: T[]): T[] {
  const componentsWithScratch = new Set<string>();
  for (const s of steps) {
    if (s.pathKey === "scratch" && s.componentKey) {
      componentsWithScratch.add(s.componentKey);
    }
  }
  return steps.filter((s) => {
    if ((s.pathKey ?? null) !== EXCLUDED_PATH_KEY) return true;
    if (!s.componentKey) return false;
    return !componentsWithScratch.has(s.componentKey);
  });
}

// ── WS9 BUG-337 / D-WS9-297 ruling 2 — WHAT THE DISH IS ACTUALLY DOING ──────
//
// The old table mapped `phaseType` → a third-person-singular verb and composed
// "While the <title> <verb>, start on the <other>." Measured on the 13-plan
// census, 115 of 193 cues were false or ungrammatical, in five ways:
//
//   69  a plural dish title with a singular verb — "While the Warm Corn
//       Tortillas stays warm". No table keyed on the phase can fix this,
//       because the number belongs to the TITLE.
//   18  the cue pointed FORWARD at a step the cook had not begun (see
//       composeCue's ordering guard).
//   14  "cooks" on a `cook` row whose own prose is not heat — "While the
//       Steamed Jasmine Rice cooks" where the step is "Combine the rinsed rice
//       and 2½ cups water…". The rice had been rinsed, nothing more.
//   13  "rests" on a marinate/soak/brine, which `rest` also covers.
//    1  "stays warm" on a dish being refrigerated — "While the Guacamole stays
//       warm", where the step is "Press plastic wrap onto the surface and
//       refrigerate".
//
// So: the connective is now the NUMBER-NEUTRAL progressive ("While the X is
// resting"), which kills all 69 plural cases at once and reads no worse for a
// singular title; and the STATE is read from the window step's own prose, with
// the phase as the fallback only. A `cook` row whose prose is neither heat nor a
// recognised passive state gets NO CUE — silence beats a confident lie.
type PassiveState = "cooking" | "heating up" | "resting" | "marinating" | "chilling" | "staying warm";

// Heat, named rather than indexed: `passiveStateOf` needs it twice (once as the
// last prose rule, once as the veto on the `cook` phase fallback), and a
// positional reference into the array below would rot the moment a rule is added.
const HEAT_PROSE =
  /\b(bak\w*|roast\w*|grill\w*|boil\w*|simmer\w*|braise\w*|steam\w*|sear\w*|sauté\w*|saute\w*|fry\w*|cook\w*|smok\w*|broil\w*|poach\w*|toast\w*|reduc\w*|char\w*|caramel\w*|melt\w*|warm\w*\s+(?:the\s+)?(?:tortillas|pan|skillet|oil))\b/i;

/** Prose → state. First match wins, so the order is the precedence. */
const STATE_FROM_PROSE: ReadonlyArray<{ re: RegExp; state: PassiveState }> = [
  { re: /\b(refrigerat\w*|chill\w*|in the fridge|ice bath)\b/i, state: "chilling" },
  { re: /\b(marinat\w*|brin\w*|soak\w*)\b/i, state: "marinating" },
  { re: /\b(rest|resting|rests)\b/i, state: "resting" },
  { re: /\b(preheat\w*|heat the oven|heats up)\b/i, state: "heating up" },
  { re: /\b(keep\w*\s+warm|stay\w*\s+warm|hold\w*\s+warm|tent\w*|wrap\w*\s+in\s+(?:a\s+)?(?:clean\s+)?(?:kitchen\s+)?(?:towel|foil))\b/i, state: "staying warm" },
  // Heat, last: a step may mention a pan and still be a marinade, and the
  // passive states above are the more specific claim.
  { re: HEAT_PROSE, state: "cooking" },
];

/** The phase's own claim, used only when the prose says nothing recognisable. */
const STATE_FROM_PHASE: Partial<Record<SchedulerPhase, PassiveState>> = {
  preheat: "heating up",
  rest: "resting",
  // NOTE: `hold` deliberately has NO fallback. "Staying warm" is the one state
  // that is actively wrong about a cold dish, and a `hold` row is just as often
  // a fridge as a warm oven. Without prose that says which, there is no cue.
  cook: "cooking",
};

/**
 * What the window dish is doing, or null when nothing can be said honestly.
 *
 * "Staying warm" is additionally gated on the dish not being a served-cold one:
 * a chilled guacamole in a `hold` step whose prose happens to say "cover and
 * keep" must not be described as warm.
 */
function passiveStateOf(step: SchedulerStep, text: string, coldDish: boolean): PassiveState | null {
  let state: PassiveState | null = null;
  if (text.length > 0) {
    for (const { re, state: s } of STATE_FROM_PROSE) {
      if (re.test(text)) { state = s; break; }
    }
  }
  const fromProse = state !== null;
  state ??= STATE_FROM_PHASE[step.phaseType] ?? null;
  if (state === null) return null;
  if (state === "staying warm" && coldDish) return "chilling";
  // A `cook` row whose prose matched nothing heat-like is the 14-case class:
  // the phase fallback would assert "cooking" about a rinse. Refuse it — but
  // only when there WAS prose to read. A caller that supplies no text (the
  // timing derivation, every pre-existing fixture) keeps the phase fallback, so
  // its numbers are untouched; cues are emitted text and move no total.
  if (state === "cooking" && !fromProse && text.length > 0) return null;
  return state;
}

// ── WS9 BUG-337 / D-WS9-297 ruling 3 — WHICH DISHES ARE SERVED COLD ─────────
//
// A cold dish is not finish-aligned: it is pulled forward into the earliest
// passive window that can hold it (see `scheduleOnce`). Hans's reason, via
// chat-Claude: a blind follower must have something to do during a 30-minute
// marinade, and pico is MEANT to sit. Measured: 15 passive windows ≥ 10 min sat
// idle across the census, worst a 60-minute pizza-dough rest with the Caesar
// romaine already startable.
//
// Keyed on roleLabel first (the structural signal) and the title second (the
// only signal most dishes carry). Deliberately a SHORT list of things that are
// unambiguously served cold — a false positive here serves something warm cold,
// which is worse than leaving a window idle.
const COLD_DISH_TITLE =
  /\b(salsa|pico de gallo|pico|guacamole|slaw|salad|dressing|vinaigrette|crema|raita|tzatziki|chutney|relish|dip|sour cream|aioli|remoulade|gremolata|chimichurri)\b/i;
/** A title that matches COLD_DISH_TITLE but is served hot anyway. */
const COLD_DISH_EXCEPTION = /\b(warm|hot|grilled|roasted|charred|fried|baked|wilted|toasted)\b/i;

/**
 * True when this dish is eaten cold, so finishing early is a feature.
 *
 * ⚠️ roleLabel IS NOT USED, AND THAT IS THE FINDING. The ruling says "by
 * roleLabel and dish title", but the DishRole enum is
 * main|side|sauce|topping|base|optional and NONE of those values implies
 * temperature: a `sauce` is gravy as often as it is crema, a `topping` is melted
 * cheese as often as it is pico. Threading it in and then ignoring it would be
 * worse than saying so. The title is the only signal the data actually carries,
 * and the exception list is what keeps "Warm Corn Tortillas" and "Grilled
 * Romaine Salad" out.
 */
export function isServedCold(dish: Pick<SchedulerDish, "title">): boolean {
  const title = dish.title ?? "";
  if (COLD_DISH_EXCEPTION.test(title)) return false;
  return COLD_DISH_TITLE.test(title);
}

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
 *
 * BUG-270, as amended by [grocery] B3 (D-WS9-277 Rule 3): ONE path per swappable
 * component is selected HERE, before anything else reads the steps
 * (classification included), so the schedule is never both alternatives of one
 * component. A `bought` step is dropped only when its own component HAS a
 * scratch alternative; a component whose only path is bought keeps its steps.
 *
 * ⚠️ THAT MEANS THE DROP CAN NO LONGER EMPTY A DISH — the predicate is
 * per-component and the scratch step it prefers is in the same dish, so whatever
 * is removed leaves something behind. A dish handed over with no steps at all is
 * still treated as empty (it does not appear in `dishDurations`); the comment
 * that said the DROP could produce one described the defect BUG-121 named.
 */
export function scheduleCookingSequence(
  dishes: SchedulerDish[],
  opts: ScheduleOptions = {},
): ScheduleResult {
  // D-WS9-297 ruling 1 — the bound is ON for every production caller. The flag
  // exists so a measurement script can price it (which meals grow, and by how
  // much) and so the §BREAK test can remove it without editing this file.
  const enforceMaxLag = opts.enforceMaxLag ?? true;
  const coldDishesForward = opts.coldDishesForward ?? true;
  // Guard: no dishes / no steps -> empty schedule (caller handles empties).
  const nonEmpty = dishes
    .map((d) => ({ ...d, steps: selectDefaultPathSteps(d.steps) }))
    .filter((d) => d.steps.length > 0);
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
  const untagged = scheduleOnce(nonEmpty, false, enforceMaxLag, coldDishesForward);
  if (!anyTag) return untagged; // byte-identical to the pre-D-WS9-239 path

  const tagged = scheduleOnce(nonEmpty, true, enforceMaxLag, coldDishesForward);
  // Rule 6 — the anomaly guard. A tie keeps the tagged schedule: it is the
  // order the recipe's own prose describes, and it costs nothing.
  if (tagged.totalEstimatedMinutes <= untagged.totalEstimatedMinutes) {
    return tagged;
  }
  // Report every window whose (valid) tag the guard set aside, then return the
  // untagged schedule — including its serial per-dish durations, so the dish
  // stamps stay consistent with the meal's.
  //
  // ⚠️ D-WS9-297 — THE GUARD COMPARES LIKE WITH LIKE. Both arms run with the
  // same `enforceMaxLag`, so this is still tags-vs-no-tags and never
  // bound-vs-no-bound. The bound is a CORRECTNESS constraint, not an
  // optimisation: it is never traded away for a shorter total, which is why it
  // sits inside each arm instead of beside them.
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
  enforceMaxLag: boolean,
  coldDishesForward: boolean,
): ScheduleResult {
  const ignoredTags: IgnoredTag[] = [];

  // 1. Per-dish walk (critical path) + anchor.
  const alone = nonEmpty.map((d) =>
    walkDishAlone(d, classifyDish(d, honourTags, ignoredTags)),
  );
  const anchor = Math.max(...alone.map((a) => a.duration));

  // ── WS9 BUG-337 / D-WS9-297 ruling 3 — COLD DISHES COME FORWARD ──────────
  //
  // Finish-alignment exists so nothing hot finishes early (BUG-018: cold corn).
  // Applied to EVERY dish it also pushes the pico and the guacamole late, which
  // is why a 30-minute marinade had 27 idle minutes with four prep steps already
  // startable: the work that could have filled the window had been deliberately
  // moved past it. Measured: 15 windows ≥ 10 min, worst a 60-minute dough rest
  // with the Caesar romaine waiting.
  //
  // A served-cold dish has no early-finish penalty — pico is MEANT to sit — so
  // it is not finish-aligned. Its base start is 0: it takes the earliest hands
  // the single-cook pass will give it, which is exactly the idle window. Hot
  // dishes are untouched, so BUG-018's fix is intact.
  //
  // This does not reorder anything by itself. It lowers the cold dish's priority
  // keys, and the pass still serialises the hands; a cold dish whose window
  // never opens simply lands where it always did.
  const coldDishIds = new Set(
    coldDishesForward ? nonEmpty.filter(isServedCold).map((d) => d.dishId) : [],
  );

  // 2. Finish-aligned ideal starts (each dish finishes at `anchor`).
  const work: WorkStep[] = [];
  nonEmpty.forEach((dish, dishIdx) => {
    // A cold dish starts as early as the hands allow; a hot one finishes at the anchor.
    const base = coldDishIds.has(dish.dishId) ? 0 : anchor - alone[dishIdx].duration;
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

  // ── WS9 BUG-337 / D-WS9-297 ruling 1 — THE LATEST BOUND ──────────────────
  //
  // Until this, the pass modelled only `earliest`: a step could begin once its
  // dish allowed it, its ideal start had arrived, and the hands were free.
  // Nothing bounded how LATE it could drift from the step before it, so food
  // sat in the pan for as long as another dish wanted the cook. Measured on the
  // 13-plan census: 12 of 27 rest steps waited more than 2 minutes after their
  // own heat step (worst 24 min) and 23 cook steps held more than 5 (worst 19).
  //
  // The Carne Asada repro, in full, because the mechanism is not obvious. The
  // steak's rest has idealStart 48 (its grill finishes at 48 in the dish-alone
  // frame). Four steps of SHORTER dishes have ideal starts of 42, 43, 45 and 47
  // — fractionally earlier, because finish-alignment pushes a short dish late
  // and those landed just below 48. They therefore win the priority sort, each
  // is attended, and between them they hold the hands to minute 70. The rest is
  // `max(48, 50, 70)` = 70: twenty minutes of a cooling steak, produced by four
  // steps that were each individually reasonable.
  //
  // The bound: a step whose own dish-predecessor is a HEAT step must start
  // within LAG_AFTER_HEAT_REST minutes of it if it is a rest, and
  // LAG_AFTER_HEAT_OTHER otherwise. `rest` gets the tighter number because a
  // rest that starts late is not a rest — the meat has already cooled.
  //
  // Enforced by PRIORITY REPAIR rather than by a new constraint in the walk.
  // A "don't start after T" rule has nowhere to go in a forward pass that only
  // ever pushes later; what has to change is WHO GETS THE HANDS FIRST. So the
  // pass runs, violations are collected, and each violating step's sort key is
  // pulled down to its predecessor's finish — which places it ahead of the
  // short-dish work that was stealing the window — and the pass runs again.
  //
  // TERMINATION: `pull` only ever DECREASES a key (`Math.min`), keys are
  // integers bounded below by 0, and the loop stops the moment a pass changes
  // nothing. MAX_LAG_ITERATIONS is a belt on top of that, not the argument for
  // termination. If violations survive the cap the schedule is emitted as-is:
  // that is the pre-bound behaviour for those steps, i.e. conservative, never
  // wrong in a new way.
  const priorityKey = new Map<WorkStep, number>();
  const keyOf = (w: WorkStep) => priorityKey.get(w) ?? w.idealStart;

  /** The step before this one in its own dish, or undefined for a rider/first. */
  const dishPredecessor = (w: WorkStep): WorkStep | undefined =>
    w.kind.kind === "rider" || w.stepIdx === 0
      ? undefined
      : work.find((o) => o.dishIdx === w.dishIdx && o.stepIdx === w.stepIdx - 1);

  /** The bound in minutes, or null when this step has no heat predecessor. */
  const maxLagOf = (w: WorkStep): number | null => {
    const prev = dishPredecessor(w);
    if (!prev || prev.step.phaseType !== "cook") return null;
    return w.step.phaseType === "rest" ? LAG_AFTER_HEAT_REST : LAG_AFTER_HEAT_OTHER;
  };

  const runPass = () => {
    let cookBusyUntil = 0;
    const placed = nonEmpty.map((d) => new Array<WorkStep | undefined>(d.steps.length));
    // Earliest key first, then stable by dish position then stepIndex (fully
    // deterministic tie-break). Within a dish this order always places a step's
    // dependencies first: a plain step's offset is past every prior finish, a
    // rider's is at or past its window's kickoff, and ties fall to stepIndex.
    // A repaired step carries a pulled-down key, never a pulled-up one, so the
    // within-dish guarantee is preserved: a step can only move ahead of work in
    // OTHER dishes.
    const priority = [...work].sort(
      (a, b) =>
        keyOf(a) - keyOf(b) ||
        a.idealStart - b.idealStart ||
        a.dishIdx - b.dishIdx ||
        a.step.stepIndex - b.step.stepIndex,
    );
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
  };

  // 3. Single-cook forward simulation, repaired until the latest bound holds.
  runPass();
  let lagIterations = 0;
  if (enforceMaxLag) {
    for (; lagIterations < MAX_LAG_ITERATIONS; lagIterations++) {
      let changed = false;
      for (const w of work) {
        const lag = maxLagOf(w);
        if (lag === null) continue;
        const prev = dishPredecessor(w)!;
        if (w.actualStart <= prev.finish + lag) continue;
        // Pull it to its PREDECESSOR'S KEY, not to the predecessor's finish.
        //
        // 🔴 `prev.finish` was the first attempt and it is not enough. The
        // Carne Asada rest's predecessor finishes at 60, so a key of 60 left it
        // still sorting BEHIND the tortilla sear, whose key is its own ideal
        // start of 47 — and the sear is attended, so it took the hands to 68 and
        // the rest landed 8 minutes late again. What the step needs is to be
        // adjacent to its predecessor in the PRIORITY ORDER, which means sharing
        // its key; the sort's stepIndex tie-break then keeps the predecessor
        // first, so the dependency order is preserved by construction.
        const want = Math.min(keyOf(w), keyOf(prev));
        if (want < keyOf(w)) {
          priorityKey.set(w, want);
          changed = true;
        }
      }
      if (!changed) break;
      runPass();
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
    const cue = composeCue(w, ordered, seqIdx, coldDishIds);
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
  coldDishIds: ReadonlySet<string>,
): string | undefined {
  if (seqIdx === 0) return undefined;
  const prev = ordered[seqIdx - 1];
  if (prev.dishId === w.dishId) return undefined; // same dish, no hand-off cue

  // Find any OTHER dish's unattended step still running when this one starts.
  //
  // ⚠️ D-WS9-297 ruling 2 — `sequenceIndex < seqIdx` IS LOAD-BEARING. The start
  // comparison alone is `<=`, so two steps at the SAME offset each satisfied it
  // about the other: step 10 was told to use step 11's window and step 11 to use
  // step 10's, and neither had begun when the cook read it. 18 of 193 cues.
  // A window must already be UNDERWAY in the order the cook actually reads.
  const window = ordered.find(
    (o, oIdx) =>
      oIdx < seqIdx &&
      o.dishId !== w.dishId &&
      o.unattended &&
      o.actualStart <= w.actualStart &&
      o.finish > w.actualStart,
  );
  if (!window) return undefined;

  const state = passiveStateOf(
    window.step,
    window.step.text ?? "",
    coldDishIds.has(window.dishId),
  );
  // Nothing honest to say about what that dish is doing → no cue. Silence is a
  // correct answer here; a confident wrong one is what BUG-337 is about.
  if (state === null) return undefined;

  // ⚠️ THE RULING'S OWN WORDING IS NOT NUMBER-NEUTRAL, so this is not it.
  // D-WS9-297 ruling 2 asks for "While the rice is cooking". `is` agrees with a
  // singular subject exactly as `stays` did: "While the Warm Corn Tortillas IS
  // staying warm" is the same 69-case defect in a new tense — it needs `are`.
  //
  // A PARTICIPIAL ABSOLUTE has no agreement at all, so it is right for both
  // numbers without anyone having to know which this title is:
  //   "With the rice cooking, start on the stir-fry."
  //   "With the Warm Corn Tortillas staying warm, start on the Carne Asada."
  // That matters more than the opening word: inflecting `is`/`are` would mean
  // guessing a title's number from its spelling, and the census checker already
  // needed an allowlist for couscous / hummus / asparagus to do that badly. This
  // form removes the question instead of answering it.
  const cue = `With the ${window.dishTitle} ${state}, start on the ${w.dishTitle}.`;
  // Hard cap mirrors the wire schema's reason max (140).
  return cue.length <= 140 ? cue : undefined;
}
