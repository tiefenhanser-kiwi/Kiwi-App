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
  /**
   * SEQ-1 (BUG-592) — the step's words need the cook at the stove for all of it
   * (`needsTheCook`), whatever its two flags say. Set by `markHandsOn` at an everyday
   * meal's input; absent everywhere else, where the flags decide as before.
   */
  handsOn?: boolean;
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
  /**
   * PREP-3 (R7) — the dish's own ingredient names, read ONLY to tell another dish's
   * food from this dish's own ("the rice" of a fried rice is its own rice, not the
   * jasmine rice beside it). Optional: absent, a step names another dish only by a
   * word that is not this dish's own title's.
   */
  ingredientNames?: readonly string[];
  /**
   * THX-3d round 4 (BUG-496) — the racks this dish's pans take in a feast's oven (a sheet
   * pan 1, a 9×13 ½; ovenRacks.ts), from its steps, rows and servings. Read only on a
   * feast. Absent: half a rack (an unknown vessel). The bird is one rack by kind.
   */
  ovenRacks?: number | null;
  /**
   * THX-3d round 5 — the vessel those racks are (ovenRacks.ts): a "dish" (9×13, casserole)
   * holds well under foil; a "sheet" pan of roasted food needs its reheat to crisp again.
   */
  ovenVessel?: "sheet" | "dish" | "half" | "unknown" | null;
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
  /**
   * THX-3 (BUG-449) — a THANKSGIVING FEAST'S OVEN. Set by the feast callers only
   * (cookingSequence and mealTiming, on a `thanksgiving-feast` meal); every other
   * meal is scheduled byte-identically to before. See `planOven`.
   */
  feastOven?: boolean;
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
  /**
   * THX-3d (R4) — a feast's source steps the scheduler merged away (a duplicate
   * preheat), so the client does not append them after serve (WEB-4d reads it as the
   * response's `mergedSteps`). Present only on a feast.
   */
  mergedSteps?: { dishId: string; stepIndex: number }[];
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
 *
 * SEQ-1 (BUG-592) — and `handsOn`, the step's words read at an everyday meal's
 * input (`markHandsOn`). Absent, the two flags decide exactly as before.
 */
export function isUnattended(
  step: Pick<SchedulerStep, "phaseType" | "isTimingSensitive" | "handsOn">,
): boolean {
  switch (step.phaseType) {
    case "preheat":
      return !step.handsOn; // an oven heats itself; oil heating to shimmering is watched (SEQ-1)
    case "rest":
    case "hold":
      return true; // hands-free by definition
    case "cook":
      return !step.isTimingSensitive && !step.handsOn; // unattended braise/boil/grill; watched sear is attended
    case "prep":
    case "assemble":
      return false; // hands-on by definition
    default:
      return false;
  }
}

// ── SEQ-1 (BUG-592) — HANDS-ON MEANS HANDS-ON ───────────────────────────────────
//
// QA-COOK-1: "Heat a dry skillet …, then warm the flour tortillas one at a time for
// 20–30 seconds per side" is `cook` and not timing-sensitive, so the flags called it
// hands-free and the Sequencer put the lime-cutting beside it; "Heat the oil … until
// shimmering" is `preheat`, hands-free by definition. A cook reads the words. These
// need the cook at the stove for the whole step: one at a time, per side, a sear, oil
// to shimmering, stirring or whisking constantly, a flip, a toss, a tortilla or a
// bread warmed in a pan or over a flame. Not an oven step (a flip halfway through a
// bake is a moment of a long wait), not a step longer than HANDS_ON_MAX_MINUTES, and
// not one that goes on to wait by itself — a simmer, a boil, a soak (the sear is its
// first minutes; the rest is the wait the BUG-018 ruling keeps hands-free). "The
// seared chicken" is the food, not the work.
//
// Read once, at an everyday meal's input (`markHandsOn`), into `handsOn` — not inside
// isUnattended: the feasts are frozen and keep the two flags, and the timing stamp
// passes no text, so its numbers read the flags as before.
const HANDS_ON_WORDS = /\b(?:one at a time|a few at a time|per side|sear(?:s|ing)?|until (?:it )?shimmer(?:s|ing)|(?:stir|whisk)(?:ring|ing)? constantly|flip(?:s|ping)?|toss(?:es|ing)?)\b/i;
const BREAD_IN_A_PAN = /\b(?:warm|heat|toast|char)\w*\b[^.;]*\b(?:tortillas?|pitas?|naan|flatbreads?|breads?|rolls?|buns?|arepas?|chapatis?|rotis?)\b[^.;]*\b(?:skillet|griddle|pan|comal|flame|burner)\b|\b(?:skillet|griddle|pan|comal|flame|burner)\b[^.;]*\b(?:warm|heat|toast|char)\w*\b[^.;]*\b(?:tortillas?|pitas?|naan|flatbreads?|breads?)\b/i;
/** A step that goes on to wait by itself after its hands-on start. */
const THEN_WAITS = /\b(?:simmer\w*|braise\w*|cover(?:ed)? and (?:cook|simmer)|bring\b[^.;]*\bto a (?:rolling )?boil|reduce (?:the )?heat to low|soak\w*|slow cooker|pressure cook\w*|lid closed|close the lid)\b/i;
/** SEQ-1 (BUG-592) — the longest step whose hands-on words hold the cook for all of it. */
export const HANDS_ON_MAX_MINUTES = 15;

/** SEQ-1 (BUG-592) — the step's words need the cook at the stove for all of it. */
export function needsTheCook(step: Pick<SchedulerStep, "phaseType" | "estimatedMinutes" | "text">): boolean {
  const text = step.text ?? "";
  if (!text || (step.phaseType !== "cook" && step.phaseType !== "preheat") || isOvenStep({ phaseType: step.phaseType, text })) return false;
  if (step.estimatedMinutes > HANDS_ON_MAX_MINUTES || THEN_WAITS.test(text)) return false;
  return HANDS_ON_WORDS.test(text) || BREAD_IN_A_PAN.test(text);
}

// ── SEQ-1 (BUG-594) — NO KNIFE WORK INSIDE PAN WORK YOU CAN'T LEAVE ─────────────
//
// QA-COOK-1, 27 of 30 meals: the oil is shimmering, and the next step is to shred a
// cabbage. A hands-on stove step (isUnattended false: timing-sensitive, or `handsOn`)
// that leaves the food on the heat is PAN-LIVE: its dish's next step uses that pan, so
// it starts the moment the pan-live step ends (a latest bound of 0, the lag repair's
// own mechanism) and is the next step the cook reads. The cook's hands are held across
// the two, so board work lands before the pan goes on or after the pan work, never
// between. A step that takes the food off the heat (transfer, drain, set aside, to a
// plate) frees the pan. An oven step is never pan-live. Cook Mode's text only (the
// timing stamp passes none), and not a feast's.
const OFF_THE_HEAT = /\b(?:transfer\w*|remove\w* (?:it |them |the [\w ]+ )?(?:from|off) (?:the )?(?:heat|pan|skillet|wok|pot|griddle|grill)|off the heat|turn (?:off the heat|the heat off)|drain\w*|set (?:it |them |the [\w ]+ )?aside|(?:to|onto) a (?:plate|bowl|platter|cutting board|rack|serving dish)|serve\w*)\b/i;

/** SEQ-1 (BUG-594) — a hands-on stove step that leaves the food on the heat. */
export function panLive(step: Pick<SchedulerStep, "phaseType" | "isTimingSensitive" | "handsOn" | "text">): boolean {
  const text = step.text ?? "";
  if (!text || (step.phaseType !== "cook" && step.phaseType !== "preheat") || isUnattended(step)) return false;
  return !isOvenStep({ phaseType: step.phaseType, text }) && !OFF_THE_HEAT.test(text);
}

/** SEQ-1 (BUG-592) — each step's `handsOn`, from its words. An everyday meal's input only. */
export function markHandsOn(dishes: readonly SchedulerDish[]): SchedulerDish[] {
  return dishes.map((d) => ({ ...d, steps: d.steps.map((s) => (needsTheCook(s) ? { ...s, handsOn: true } : s)) }));
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
/** D-WS9-297 ruling 3 — the shortest passive window worth moving a cold dish into. */
const COLD_FORWARD_MIN_WINDOW = 10;

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

// ── SEQ-1 (BUG-596) — CUES TELL THE TRUTH ───────────────────────────────────────
//
// QA-COOK-1, 318 of 320 cue hits from the Sequencer: "With the Cilantro-Lime Rice
// marinating" — the rice was simmering. STATE_FROM_PROSE's `brin\w*` meant brine and
// matched "BRINg to a boil", so every pot brought to a boil was marinating; "the
// marinade" is not `marinat\w*`, so a marinade fell through to "resting"; and a dum
// that "cooks 25 minutes, then rests" was resting while it cooked. An everyday meal's
// cue now names what the dish is doing at that moment, from the window step's own
// words: a cook step is in the oven, simmering, steaming, in the slow cooker or (other
// heat) cooking — its heat first; a hands-free step is chilling, marinating, pickling,
// soaking, steaming, resting or sitting. Nothing recognisable: no cue (BUG-337's
// silence). A feast's cues are frozen (passiveStateOf, unchanged).
export type CookState = PassiveState | "simmering" | "in the oven" | "steaming" | "in the slow cooker" | "in the microwave" | "pickling" | "soaking" | "sitting";
const SIMMERING = /\b(?:simmer\w*|boil\w*|braise\w*|poach\w*|on the lowest heat|reduce (?:the )?heat to (?:low|medium-low))\b/i;
const STEAMING = /\bsteam\w*\b/i;
const SLOW_COOKER = /\b(?:slow cooker|crock-?pot)\b/i;
const MICROWAVE = /\bmicrowav\w*\b/i;
const MARINATING = /\b(?:marinat\w*|marinade|brine[ds]?|brining)\b/i;
const PICKLING = /\bpickl\w*\b/i;
const SOAKING = /\bsoak\w*\b/i;
const RESTING = /\b(?:rest|resting|rests)\b/i;
const SITTING = /\b(?:let (?:it |them |the [\w -]+ )?(?:sit|stand)|sits? at room temperature)\b/i;
const CHILLING = /\b(?:refrigerat\w*|chill\w*|in the fridge|ice bath)\b/i;
const WARMING = /\b(?:keep\w*\s+warm|stay\w*\s+warm|hold\w*\s+warm|tent\w*|wrap\w*\s+in\s+(?:a\s+)?(?:clean\s+)?(?:kitchen\s+)?(?:towel|foil))\b/i;

export function cookStateOf(step: SchedulerStep, text: string, coldDish: boolean, dishTitle = ""): CookState | null {
  if (!text) return passiveStateOf(step, text, coldDish);
  if (step.phaseType === "preheat") return "heating up";
  if (step.phaseType === "cook") {
    if (SLOW_COOKER.test(text)) return "in the slow cooker";
    if (MICROWAVE.test(text)) return "in the microwave";
    if (isOvenStep({ phaseType: step.phaseType, text })) return "in the oven";
    if (SIMMERING.test(text)) return "simmering";
    if (STEAMING.test(text)) return "steaming";
    return HEAT_PROSE.test(text) ? "cooking" : null;
  }
  if (CHILLING.test(text)) return "chilling";
  if (PICKLING.test(`${dishTitle} ${text}`)) return "pickling";
  if (MARINATING.test(text)) return "marinating";
  if (SOAKING.test(text)) return "soaking";
  if (STEAMING.test(text)) return "steaming";
  if (RESTING.test(text)) return "resting";
  if (SITTING.test(text)) return "sitting";
  if (WARMING.test(text)) return coldDish ? "chilling" : "staying warm";
  return null;
}

/**
 * SEQ-1 (BUG-596) — an everyday meal's cue is kept only while it is true as the step
 * starts: the dish it names has a hands-free step running then, begun earlier in the
 * order the cook reads (BUG-593 and BUG-595 move steps after the cues are written).
 * The keep-warm cue says nothing of the kind and is kept.
 */
export function everydayCuesAsServed(res: ScheduleResult, dishes: readonly SchedulerDish[]): ScheduleResult {
  const k = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const stepOf = new Map(dishes.flatMap((d) => d.steps.map((s) => [k(d.dishId, s.stepIndex), s] as const)));
  const titled = [...dishes].sort((a, b) => b.title.length - a.title.length);
  let changed = false;
  const steps = res.steps.map((e) => {
    if (!e.reason?.startsWith("With the ")) return e;
    const named = titled.find((d) => d.dishId !== e.dishId && e.reason!.startsWith(`With the ${d.title} `));
    const running = named && res.steps.some((o) => {
      if (o.dishId !== named.dishId || o.sequenceIndex >= e.sequenceIndex) return false;
      const s = stepOf.get(k(o.dishId, o.originalStepIndex));
      return !!s && isUnattended(s) && o.startOffsetMinutes <= e.startOffsetMinutes && e.startOffsetMinutes < o.startOffsetMinutes + s.estimatedMinutes;
    });
    if (running) return e;
    changed = true;
    const { reason: _reason, ...plain } = e;
    return plain;
  });
  return changed ? { ...res, steps } : res;
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
//
const COLD_DISH_TITLE =
  /\b(salsa|pico de gallo|pico|guacamole|slaw|salad|dressing|vinaigrette|crema|raita|tzatziki|chutney|relish|dip|sour cream|aioli|remoulade|gremolata|chimichurri)\b/i;
/** A title that matches COLD_DISH_TITLE but is served hot anyway. */
const COLD_DISH_EXCEPTION = /\b(warm|hot|grilled|roasted|charred|fried|baked|wilted|toasted)\b/i;
// THX-2S (BUG-397, partly) — a feast's cranberry and desserts: never scheduled
// as hot dishes to be finish-aligned with the turkey. Narrower than bare words,
// measured on the dev catalog (3,094 public-meal dishes): "cranberry" only as a
// SAUCE (relish is above) — "Cranberry Stuffed Acorn Squash" is hot; "crisp"
// only as the dish's last word — "Crisp-Tender Green Beans" is hot; "pie" and
// "bars" as words, minus the savoury pies (HOT_PIE).
const DESSERT_OR_CRANBERRY_TITLE = /\bcranberry\b[\w\s'-]*\bsauce\b|\b(pie|bars)\b|\bcrisp\s*$/i;
/** THX-2S — the savoury pies "pie" would otherwise catch ("Leftover Turkey Pot Pie"). */
const HOT_PIE = /\b(pot pie|shepherd'?s pie|cottage pie|tamale pie|frito pie|meat pie|pork pie|chicken pie|pizza pie)\b/i;

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
  if (COLD_DISH_EXCEPTION.test(title) || HOT_PIE.test(title)) return false;
  return COLD_DISH_TITLE.test(title) || DESSERT_OR_CRANBERRY_TITLE.test(title);
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

// ── PREP-3 3b — A SOAK IS A HOLD, LIKE A MARINADE ────────────────────────────────────
//
// hh4-mixed Monday: "If using wooden skewers, submerge all 8 in cold water now and let them
// soak for at least 30 minutes" (2 minutes of hands), and the skewers were threaded 25
// minutes later. A soak the step does not wait out itself (its minutes are fewer than the
// soak's) holds the first later step of its dish that names what soaks: it starts once
// the soak is over. (The noodles soaked "20–25 minutes" in a 25-minute step wait it out.)
const SOAK = /\bsoak\w*\b[^.;]*?\b(?:for\s+)?(?:at least\s+)?(\d+)(?:\s*(?:–|-|to)\s*\d+)?\s*(?:minutes?|mins?)\b/i;
const SOAKED = /\b(skewers?|noodles?|beans?|rice|chiles?|chilies|breadcrumbs?|potato(?:es)?|cashews?|lentils?|mushrooms?|raisins?)\b/i;
/** Array index of the step that waits → the soaking step's index and the soak's minutes. */
export function soakHolds(dish: Pick<SchedulerDish, "steps">): Map<number, { from: number; minutes: number }> {
  const out = new Map<number, { from: number; minutes: number }>();
  dish.steps.forEach((s, k) => {
    const m = SOAK.exec(s.text ?? "");
    if (!m || s.phaseType === "rest" || s.phaseType === "hold" || s.estimatedMinutes >= Number(m[1])) return;
    const thing = SOAKED.exec(s.text ?? "")?.[1];
    if (!thing) return;
    const named = new RegExp(`\\b${escapeRe(thing.toLowerCase().replace(/(?:(?<=o)es|s)$/, ""))}`, "i");
    const next = dish.steps.findIndex((o, j) => j > k && named.test(o.text ?? ""));
    if (next > k && !out.has(next)) out.set(next, { from: k, minutes: Number(m[1]) });
  });
  return out;
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
  const soaks = soakHolds(dish);
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
    const soak = soaks.get(k);
    if (soak) start = Math.max(start, finishes[soak.from] + soak.minutes);
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
  // THX-4 (BUG-529) — a feast's take-outs are set aside for the whole day's passes (none
  // takes hands it might not need) and the one the day keeps comes back at serving.
  if (opts.feastOven && dishes.some((d) => d.steps.some((s) => TAKE_OUT_STEP.test(s.text ?? "")))) {
    return withTakeOut(scheduleTheDay(dishes.map((d) => ({ ...d, steps: d.steps.filter((s) => !TAKE_OUT_STEP.test(s.text ?? "")) })), opts), dishes);
  }
  // SEQ-1 — the cook's reading of the words, on an everyday meal (the feasts are frozen).
  if (opts.feastOven) return scheduleTheDay(dishes, opts);
  const marked = markHandsOn(dishes);
  return everydayCuesAsServed(hotAtServing(breadAtServing(marked, (d) => scheduleTheDay(d, opts)), marked), marked);
}

// ── SEQ-1 (BUG-595) — HOT DISHES DON'T WAIT UNCOVERED ───────────────────────────
//
// QA-COOK-1, 25 of 30 meals: a hot dish comes off the heat and sits while the rest of
// the meal is cooked — Al Pastor's pork rested at T−16 and was served at T 0, the
// Fajita Bowl's chicken at T−32. The core pass aligns every dish to finish together,
// but the cook's hands push the others later and leave the first one early. So, on
// the meal as finally scheduled, a hot dish that finishes more than HOT_HOLD_MAX
// minutes before serving has its last heat run moved as late as the hands allow:
// its last heat step with the pan run or preheat it starts with, and everything after
// it in the dish (the rest, the slice, the plating), one block, ending at serving. Its
// dish's earlier steps still come first, a cook step before it still bounds it
// (LAG_AFTER_HEAT_OTHER), and a dish that uses its food still gets it first. The
// longest wait goes first. Where no slot is late enough, the next step the cook reads
// says to keep it warm (`keepWarmCue`): Cook Mode shows the meal's own steps, so the
// Sequencer cannot add one. Not a dish served cold, left to cool, or already kept warm
// by its own words. Not a feast's (its warm steps are written into it).
export const HOT_HOLD_MAX = 10;
/** A cold food that does not wait well once it is out: it browns or wilts. */
const BROWNS_OR_WILTS = /\b(?:avocados?|guacamole|lettuce|greens|arugula|romaine|whipped)\b/i;
/** A dish's own words that keep it warm after its heat. */
const KEPT_WARM = /\b(?:keep\w* (?:it |them |everything |the [\w -]+ )?warm|stay\w* warm|lowest heat|warm oven|tent\w*|cover(?:ed)? (?:loosely )?with foil|(?:let|leave) (?:it |them |the [\w ]+ )?(?:stand|sit|steam|rest),? covered|covered,? off the heat|wrap\w* (?:them |it |the [\w ]+ )?in (?:a )?(?:clean )?(?:kitchen )?(?:towel|foil))\b/i;

/** SEQ-1 (BUG-595) — the cue that keeps a hot dish warm: a lid on the lowest heat in its pan, foil off it. */
export function keepWarmCue(title: string, offThePan: boolean): string | undefined {
  const cue = offThePan ? `Tent the ${title} with foil until serving.` : `Keep the ${title} covered over the lowest heat until serving.`;
  return cue.length <= 140 ? cue : undefined;
}

function hotAtServing(res: ScheduleResult, dishes: readonly SchedulerDish[]): ScheduleResult {
  if (res.steps.length === 0) return res;
  const input = dishes.map((d) => ({ ...d, steps: selectDefaultPathSteps(d.steps) })).filter((d) => d.steps.length > 0);
  const key = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const stepOf = new Map(input.flatMap((d) => d.steps.map((s) => [key(d.dishId, s.stepIndex), s] as const)));
  const dishOf = new Map(input.flatMap((d) => d.steps.map((s) => [key(d.dishId, s.stepIndex), d] as const)));
  const end = res.totalEstimatedMinutes;
  const all = res.steps.map((e) => key(e.dishId, e.originalStepIndex));
  const pos = new Map(res.steps.map((e) => [key(e.dishId, e.originalStepIndex), e.startOffsetMinutes + end]));
  const dur = (k: string) => stepOf.get(k)?.estimatedMinutes ?? 0;
  const attended = (k: string) => { const s = stepOf.get(k); return !!s && !isUnattended(s); };
  const placedOf = (d: SchedulerDish) => d.steps.filter((s) => pos.has(key(d.dishId, s.stepIndex)));
  const uses = dishUses(input);
  /** A step's earliest start by what it waits for: its dish's steps before it, and a dish it uses. */
  const floorOf = (k: string, at: ReadonlyMap<string, number>): number => {
    const d = dishOf.get(k)!;
    const p = placedOf(d);
    const i = p.findIndex((s) => key(d.dishId, s.stepIndex) === k);
    let f = -Infinity;
    // A rider of a hands-free window (D-WS9-239) waits for the window to start, not to end.
    const token = p[i].parallelGroup?.trim() || null;
    const w = token ? p.findIndex((s) => (s.parallelGroup?.trim() || null) === token) : -1;
    const rides = w >= 0 && w < i && isUnattended(p[w]) && p.slice(w, i).every((s) => (s.parallelGroup?.trim() || null) === token);
    for (const [j, s] of p.slice(0, i).entries()) {
      const start = at.get(key(d.dishId, s.stepIndex))!;
      f = Math.max(f, rides && j >= w ? start : start + s.estimatedMinutes);
    }
    for (const u of uses.filter((x) => x.dishId === d.dishId && d.steps[x.stepIdx] && key(d.dishId, d.steps[x.stepIdx].stepIndex) === k)) {
      const o = input.find((x) => x.dishId === u.usesDishId)!;
      const done = key(o.dishId, o.steps[u.doneIdx].stepIndex);
      if (at.has(done)) f = Math.max(f, at.get(done)! + dur(done));
    }
    return f;
  };
  type Hot = { d: SchedulerDish; keys: string[]; finish: number; offThePan: boolean };
  const hot: Hot[] = [];
  for (const d of input) {
    if (isServedCold(d)) continue;
    const placed = placedOf(d);
    const L = placed.map((s) => s.phaseType).lastIndexOf("cook");
    if (L < 0 || !placed[L].text || COOLS.test(placed[L].text ?? "")) continue;
    if (placed.slice(L).some((s) => KEPT_WARM.test(s.text ?? "") || /\b(?:refrigerat|chill)/i.test(s.text ?? ""))) continue;
    // Finished: the last heat step and the rests right after it.
    let f = L;
    while (f + 1 < placed.length && placed[f + 1].phaseType === "rest") f++;
    const finish = pos.get(key(d.dishId, placed[f].stepIndex))! + placed[f].estimatedMinutes;
    if (end - finish <= HOT_HOLD_MAX) continue;
    // The run: back through the pan run (BUG-594), and through the heat steps right
    // before it (the latest bound ties them: the fajitas' oil, peppers, chicken and toss
    // are one session at the pan), never a long hands-free one (the slow cooker holds).
    const live: boolean[] = [];
    placed.forEach((s, k) => { live[k] = panLive(s) || (k > 0 && live[k - 1] && !isUnattended(s) && !OFF_THE_HEAT.test(s.text ?? "")); });
    let from = L;
    while (from > 0) {
      const b = placed[from - 1];
      const gap = pos.get(key(d.dishId, placed[from].stepIndex))! - (pos.get(key(d.dishId, b.stepIndex))! + b.estimatedMinutes);
      const heat = (b.phaseType === "cook" || (b.phaseType === "preheat" && !isOvenStep(b))) && !(isUnattended(b) && b.estimatedMinutes > HOT_HOLD_MAX);
      if (!live[from - 1] && !(heat && gap <= LAG_AFTER_HEAT_OTHER)) break;
      from--;
    }
    hot.push({ d, keys: placed.slice(from, f + 1).map((s) => key(d.dishId, s.stepIndex)), finish, offThePan: placed.slice(L).some((s) => OFF_THE_HEAT.test(s.text ?? "")) || isOvenStep(placed[L]) });
  }
  if (hot.length === 0) return res;
  const fixed = new Set(input.flatMap((d) => {
    const from = breadRunFrom(d);
    return from === null ? [] : d.steps.slice(from).map((s) => key(d.dishId, s.stepIndex));
  }));
  const dayStart = Math.min(...pos.values());
  /**
   * What may make room: a dish's work before its first heat step, and a cold dish's (a
   * hot dish's heat and what follows it is another dish's serving time — moving one hot
   * dish late must not leave the next one early).
   */
  const canWait = new Set(input.flatMap((d) => {
    const firstHeat = d.steps.findIndex((s) => s.phaseType === "cook" || s.phaseType === "preheat");
    return d.steps.slice(0, firstHeat < 0 ? d.steps.length : firstHeat).map((s) => key(d.dishId, s.stepIndex));
  }));
  /** A dish with no heat: its closing assemble steps that set out what browns or wilts (the guacamole, the dressed greens). */
  const setOut = new Set(input.filter((d) => !d.steps.some((s) => s.phaseType === "cook")).flatMap((d) => {
    let c = d.steps.length;
    while (c > 0 && d.steps[c - 1].phaseType === "assemble") c--;
    return d.steps.slice(c).filter((s) => BROWNS_OR_WILTS.test(s.text ?? "")).map((s) => key(d.dishId, s.stepIndex));
  }));
  const cues = new Map<string, string>();
  let changed = false;
  for (const h of [...hot].sort((a, b) => a.finish - b.finish)) {
    const block = new Set(h.keys);
    const len = h.keys.reduce((n, k) => n + dur(k), 0);
    const was = pos.get(h.keys[0])!;
    const p = placedOf(h.d);
    const last = p.findIndex((s) => key(h.d.dishId, s.stepIndex) === h.keys[h.keys.length - 1]);
    const first = p.findIndex((s) => key(h.d.dishId, s.stepIndex) === h.keys[0]);
    const after = p[last + 1] ? key(h.d.dishId, p[last + 1].stepIndex) : null;
    const before = p[first - 1];
    let latest = Math.min(end, after ? pos.get(after)! : end) - len;
    if (before?.phaseType === "cook") latest = Math.min(latest, pos.get(key(h.d.dishId, before.stepIndex))! + before.estimatedMinutes + LAG_AFTER_HEAT_OTHER);
    // A dish that uses this one's food gets it first.
    for (const u of uses.filter((x) => x.usesDishId === h.d.dishId)) {
      const ud = input.find((x) => x.dishId === u.dishId)!;
      const uk = key(ud.dishId, ud.steps[u.stepIdx].stepIndex);
      if (pos.has(uk)) latest = Math.min(latest, pos.get(uk)! - len);
    }
    /**
     * The block at t, and the work it displaces placed again, in order, at the earliest
     * moment its dish and the hands allow (carveLate's trade, as a small list pass): never
     * later than it was, never before the day starts. A bread run (BUG-593) and a set-out
     * that browns or wilts do not move. Null when that cannot be done.
     */
    const tryAt = (t: number): Map<string, number> | null => {
      const next = new Map(pos);
      let a = t;
      for (const k of h.keys) { next.set(k, a); a += dur(k); }
      const region = all.filter((k) => !block.has(k) && pos.get(k)! >= was && pos.get(k)! < t + len).sort((x, y) => pos.get(x)! - pos.get(y)!);
      const regionSet = new Set(region);
      const busy: [number, number][] = [
        ...all.filter((k) => !regionSet.has(k) && attended(k)).map((k) => [next.get(k)!, next.get(k)! + dur(k)] as [number, number]),
      ];
      for (const k of region) {
        const stays = fixed.has(k) || setOut.has(k) || !canWait.has(k);
        let s = stays ? pos.get(k)! : Math.max(floorOf(k, next), dayStart);
        for (let guard = 0, moved = true; moved && guard <= busy.length; guard++) {
          moved = false;
          for (const [b0, b1] of busy) {
            if (attended(k) ? s < b1 && b0 < s + dur(k) : b0 <= s && s < b1) { s = b1; moved = true; }
          }
        }
        if (s > pos.get(k)! || (stays && s !== pos.get(k))) return null;
        next.set(k, s);
        if (attended(k)) busy.push([s, s + dur(k)]);
      }
      for (const k of [...region, ...h.keys]) if (floorOf(k, next) > next.get(k)!) return null;
      const hands = all.filter((k) => attended(k) && !block.has(k)).map((k) => [next.get(k)!, next.get(k)! + dur(k)] as const);
      for (const k of h.keys) {
        const s = next.get(k)!;
        if (attended(k) ? hands.some(([b0, b1]) => s < b1 && b0 < s + dur(k)) : hands.some(([b0, b1]) => b0 <= s && s < b1)) return null;
      }
      return next;
    };
    let best: Map<string, number> | null = null;
    // (Only a move that brings it within HOT_HOLD_MAX: half a move reorders the meal for nothing.)
    for (let t = latest; t > was && end - (h.finish + t - was) <= HOT_HOLD_MAX && !best; t--) best = tryAt(t);
    if (best) {
      for (const [k, v] of best) pos.set(k, v);
      changed = true;
    }
    // Still waiting too long: the next step the cook reads after it says to keep it warm.
    const lastKey = h.keys[h.keys.length - 1];
    const doneAt = pos.get(lastKey)! + dur(lastKey);
    if (end - doneAt > HOT_HOLD_MAX) {
      const next = all.filter((k) => !block.has(k) && pos.get(k)! >= doneAt).sort((a, b) => pos.get(a)! - pos.get(b)!)[0];
      const cue = keepWarmCue(h.d.title, h.offThePan);
      if (next && cue) cues.set(next, cue);
    }
  }
  if (!changed && cues.size === 0) return res;
  const steps = res.steps
    .map((e) => {
      const k = key(e.dishId, e.originalStepIndex);
      const now = pos.get(k)! - end;
      const cue = cues.get(k);
      if (now === e.startOffsetMinutes && !cue) return e;
      const { reason: _reason, ...plain } = e;
      return { ...plain, ...(cue ? { reason: cue } : {}), startOffsetMinutes: now };
    })
    .sort((a, b) => a.startOffsetMinutes - b.startOffsetMinutes || a.sequenceIndex - b.sequenceIndex)
    .map((e, i) => ({ ...e, sequenceIndex: i }));
  return { ...res, steps };
}

// ── SEQ-1 (BUG-593) — BREAD IS A SERVE-TIME DISH ────────────────────────────────
//
// QA-COOK-1, the fajitas: the tortillas were warmed first, at T−28, and wrapped in a
// towel; the chicken was seared after them and the cook served cold tortillas. A
// dish whose last heat step warms, toasts or bakes a bread (tortillas, pita, naan,
// garlic bread, buns) ends with its BREAD RUN — that step, the pan run or preheat it
// starts with, and what follows it (the wrap, the stack-and-cut, the set-out) — and
// the run is the meal's last heat: it ends no more than BREAD_HOLD_MAX minutes before
// serving. So the meal is scheduled without it first, and the run goes as late as the
// cook's hands allow, ending as the rest of the meal does or after it. What serves the
// meal follows it: a step of another dish that uses the bread (the tacos filled), and
// the other dishes' closing plating ("scatter the cilantro … and serve immediately")
// while it fits in BREAD_HOLD_MAX. Not a feast's; the timing stamp passes no words,
// so it never has a bread run.
export const BREAD_HOLD_MAX = 3;
/** Minutes the bread going last may add to the meal. */
export const BREAD_LATE_SLACK = 5;
/** A hands-free heat step longer than this (a braise, the slow cooker) is not part of the bread's session. */
const BREAD_SESSION_MAX = 10;
const BREAD_FOOD = /\b(?:tortillas?|pitas?|naan|flatbreads?|bread(?!\s+(?:crumbs?|cubes?|pieces))|(?<!(?:spring|egg|cinnamon|sushi) )rolls?|buns?|crostini|tostadas?|arepas?|chapatis?|rotis?|baguettes?|focaccia|biscuits?)\b/i;
/** The part of a step that describes other work done alongside it. */
const ALONGSIDE = /[,;.]?\s*\b(?:while|meanwhile)\b[\s\S]*$/i;

/** SEQ-1 (BUG-593) — where a dish's bread run starts (array index), or null when its last heat step warms no bread. */
export function breadRunFrom(dish: Pick<SchedulerDish, "steps">): number | null {
  const steps = dish.steps;
  const last = steps.map((s) => s.phaseType).lastIndexOf("cook");
  // (Its own work: "simmer 45 minutes; while it simmers, … warm the tortillas" is a stew;
  // and served warm: croutons "transferred to a plate to cool" are not.)
  const text = steps[last]?.text ?? "";
  if (last < 0 || !BREAD_FOOD.test(text.replace(ALONGSIDE, "")) || COOLS.test(text)) return null;
  // Back through the run on its pan (BUG-594: Birria's tortillas are dipped, laid on
  // the griddle, filled and folded) and the heat steps right before it — the cooking
  // the bread closes: the turkey burgers' mushrooms, patties and cheese before the buns
  // toast in the same pan (moved without them, the patties were cooked an hour early) —
  // never a long hands-free one; then the preheat that starts it.
  const live: boolean[] = [];
  steps.forEach((s, k) => { live[k] = panLive(s) || (k > 0 && live[k - 1] && !isUnattended(s) && !OFF_THE_HEAT.test(s.text ?? "")); });
  let from = last;
  for (;;) {
    const b = steps[from - 1];
    const heat = !!b && (b.phaseType === "cook" || (b.phaseType === "preheat" && !isOvenStep(b))) && !(isUnattended(b) && b.estimatedMinutes > BREAD_SESSION_MAX);
    if (!b || !(live[from - 1] || heat)) break;
    from--;
  }
  if (from > 0 && steps[from - 1].phaseType === "preheat") from--;
  return from;
}

function breadAtServing(dishes: SchedulerDish[], schedule: (d: SchedulerDish[]) => ScheduleResult): ScheduleResult {
  const input = dishes.map((d) => ({ ...d, steps: selectDefaultPathSteps(d.steps) })).filter((d) => d.steps.length > 0);
  const whole = schedule(dishes);
  // Only a bread the meal as scheduled finishes early (the garlic bread already bakes in
  // the soup's last minutes, and stays there).
  const key = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const breadFrom = new Map<string, number>();
  for (const d of input) {
    const from = breadRunFrom(d);
    if (from === null) continue;
    const heat = d.steps[d.steps.map((s) => s.phaseType).lastIndexOf("cook")];
    const e = whole.steps.find((x) => x.dishId === d.dishId && x.originalStepIndex === heat.stepIndex);
    if (e && -(e.startOffsetMinutes + heat.estimatedMinutes) > BREAD_HOLD_MAX) breadFrom.set(d.dishId, from);
  }
  if (breadFrom.size === 0) return whole;
  const byId = new Map(input.map((d) => [d.dishId, d]));
  const run = input.flatMap((d) => (breadFrom.has(d.dishId) ? d.steps.slice(breadFrom.get(d.dishId)).map((s) => ({ d, s })) : []));
  const post = (() => {
    let n = 0;
    for (const d of input) {
      const from = breadFrom.get(d.dishId);
      if (from === undefined) continue;
      const last = d.steps.map((s) => s.phaseType).lastIndexOf("cook");
      n = Math.max(n, d.steps.slice(last + 1).reduce((m, s) => m + s.estimatedMinutes, 0));
    }
    return n;
  })();
  // What serves the meal, after the bread: each other dish's steps from one that uses the bread…
  const after = new Map<string, number>();
  for (const u of dishUses(input)) {
    if (!breadFrom.has(u.usesDishId) || breadFrom.has(u.dishId)) continue;
    after.set(u.dishId, Math.min(after.get(u.dishId) ?? Infinity, u.stepIdx));
  }
  // …and its closing plating, a hot dish's "serve immediately" first, while it fits.
  let budget = BREAD_HOLD_MAX - post - [...after].reduce((n, [id, k]) => n + byId.get(id)!.steps.slice(k).reduce((m, s) => m + s.estimatedMinutes, 0), 0);
  const plating = input
    .filter((d) => !breadFrom.has(d.dishId) && !after.has(d.dishId))
    .flatMap((d) => {
      let c = d.steps.length;
      while (c > 0 && d.steps[c - 1].phaseType === "assemble" && !WAITS.test(d.steps[c - 1].text ?? "")) c--;
      return c < d.steps.length && c > 0 ? [{ d, c, minutes: d.steps.slice(c).reduce((m, s) => m + s.estimatedMinutes, 0), now: SERVE_NOW.test(d.steps[d.steps.length - 1].text ?? "") }] : [];
    })
    .sort((a, b) => Number(b.now) - Number(a.now) || a.minutes - b.minutes);
  for (const p of plating) {
    if (p.minutes > budget) continue;
    after.set(p.d.dishId, p.c);
    budget -= p.minutes;
  }
  const closing = input.flatMap((d) => (after.has(d.dishId) && !breadFrom.has(d.dishId) ? d.steps.slice(after.get(d.dishId)).map((s) => ({ d, s })) : []));
  const rest = input
    .map((d) => ({ ...d, steps: d.steps.slice(0, breadFrom.get(d.dishId) ?? after.get(d.dishId) ?? d.steps.length) }))
    .filter((d) => d.steps.length > 0);

  // The meal without them, then the bread run as late as the hands allow, then what serves it.
  const first = rest.length > 0 ? schedule(rest) : { steps: [], totalEstimatedMinutes: 0, activeEstimatedMinutes: 0, dishDurations: {}, ignoredTags: [] };
  const T = first.totalEstimatedMinutes;
  const stepOf = new Map(input.flatMap((d) => d.steps.map((s) => [key(d.dishId, s.stepIndex), s] as const)));
  const abs = new Map(first.steps.map((e) => [key(e.dishId, e.originalStepIndex), e.startOffsetMinutes + T]));
  const busy: [number, number][] = first.steps
    .map((e) => stepOf.get(key(e.dishId, e.originalStepIndex)))
    .flatMap((s, i) => (s && !isUnattended(s) ? [[first.steps[i].startOffsetMinutes + T, first.steps[i].startOffsetMinutes + T + s.estimatedMinutes] as [number, number]] : []));
  const len = run.reduce((n, x) => n + x.s.estimatedMinutes, 0);
  const ready = Math.max(0, ...run.map(({ d }) => Math.max(0, ...d.steps.filter((s) => abs.has(key(d.dishId, s.stepIndex))).map((s) => abs.get(key(d.dishId, s.stepIndex))! + s.estimatedMinutes))));
  const fits = (t: number) => {
    let at = t;
    for (const { s } of run) {
      const clash = isUnattended(s) ? busy.some(([b0, b1]) => b0 <= at && at < b1) : busy.some(([b0, b1]) => at < b1 && b0 < at + s.estimatedMinutes);
      if (clash) return false;
      at += s.estimatedMinutes;
    }
    return true;
  };
  let t = Math.max(T - len, ready);
  while (!fits(t)) t++;
  const placed: { e: ScheduledStep; at: number }[] = [];
  let at = t;
  for (const x of [...run, ...closing]) {
    if (x === closing[0]) at = Math.max(at, T);
    placed.push({ e: { dishId: x.d.dishId, originalStepIndex: x.s.stepIndex, sequenceIndex: 0, startOffsetMinutes: 0 }, at });
    at += x.s.estimatedMinutes;
  }
  const end = Math.max(T, at);
  // Not at any price: when the bread can only go last by lengthening the meal more than
  // BREAD_LATE_SLACK (the turkey burgers' buns close a 20-minute session at the pan that
  // could not overlap the fries: +30), the meal stays as scheduled.
  if (end > whole.totalEstimatedMinutes + BREAD_LATE_SLACK) return whole;
  const steps = [
    ...first.steps.map((e) => ({ e: { ...e }, at: e.startOffsetMinutes + T, late: false })),
    ...placed.map((p) => ({ ...p, late: true })),
  ]
    .sort((a, b) => a.at - b.at || Number(a.late) - Number(b.late) || a.e.sequenceIndex - b.e.sequenceIndex)
    .map((x, i) => ({ ...x.e, sequenceIndex: i, startOffsetMinutes: x.at - end }));
  return {
    steps,
    totalEstimatedMinutes: end,
    activeEstimatedMinutes: first.activeEstimatedMinutes + [...run, ...closing].reduce((n, x) => n + (isUnattended(x.s) ? 0 : x.s.estimatedMinutes), 0),
    dishDurations: whole.dishDurations,
    ignoredTags: whole.ignoredTags,
  };
}

/**
 * THX-4 (BUG-529) — ONE TAKE-OUT, WHEN A SIDE IS LEFT IN THE OVEN. A side is left in when
 * no step of its own follows its last oven step on the day (a rest, a plating, a slice):
 * Classic's casseroles behind the oven-off, and — the oven still on — New Twist's,
 * Small's and Vegetarian's stuffings. The take-out comes from the dish whose oven-off the
 * day keeps, else from the left-in side whose oven ends last; it starts once every
 * left-in side's oven has ended and before its own dish's next step, at the latest moment
 * the hands are free within WARM_GAP of serving (else the latest free one; else right
 * before the serve step, the day growing by its minute). Every other take-out is merged
 * away (the client must not append it); with nothing left in, all of them are.
 */
function withTakeOut(res: ScheduleResult, dishes: readonly SchedulerDish[]): ScheduleResult {
  const k = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const stepOf = new Map(dishes.flatMap((d) => d.steps.map((s) => [k(d.dishId, s.stepIndex), s] as const)));
  const textOf = (e: { dishId: string; originalStepIndex: number }) => stepOf.get(k(e.dishId, e.originalStepIndex))?.text ?? "";
  const dur = (e: { dishId: string; originalStepIndex: number }) => stepOf.get(k(e.dishId, e.originalStepIndex))?.estimatedMinutes ?? 0;
  const merged = new Map((res.mergedSteps ?? []).map((m) => [k(m.dishId, m.stepIndex), m] as const));
  const takeOuts = dishes.flatMap((d) => d.steps.filter((s) => TAKE_OUT_STEP.test(s.text ?? "")).map((s) => ({ d, s })));
  const serve = res.steps.find((e) => FEAST_SERVE_STEP.test(textOf(e)));
  const bird = feastRoastDish(dishes);
  // Each oven side's last oven step on the day, and whether a step of its own takes it out.
  const sides = dishes.flatMap((d) => {
    if (d.dishId === bird?.dishId || DESSERT_DISH.test(d.title)) return [];
    const placed = res.steps.filter((e) => e.dishId === d.dishId).sort((a, b) => a.originalStepIndex - b.originalStepIndex);
    const oven = placed.filter((e) => { const s = stepOf.get(k(e.dishId, e.originalStepIndex)); return !!s && isOvenStep(s) && s.phaseType !== "preheat"; }).pop();
    if (!oven) return [];
    const out = placed.some((e) => e.originalStepIndex > oven.originalStepIndex && e !== serve && !OVEN_OFF_STEP.test(textOf(e)) && !KEEP_WARM_STEP.test(textOf(e)));
    return [{ d, ovenEnd: oven.startOffsetMinutes + dur(oven), leftIn: !out }];
  });
  const left = sides.filter((x) => x.leftIn);
  const off = res.steps.find((e) => OVEN_OFF_STEP.test(textOf(e)));
  const nextAfter = (d: SchedulerDish, i: number) => d.steps.filter((s) => s.stepIndex > i).sort((a, b) => a.stepIndex - b.stepIndex)[0];
  const hostOff = off ? takeOuts.find(({ d, s }) => d.dishId === off.dishId && nextAfter(d, off.originalStepIndex) === s) : undefined;
  const hostLeft = [...left].sort((a, b) => b.ovenEnd - a.ovenEnd).map((x) => takeOuts.find(({ d }) => d.dishId === x.d.dishId)).find((t) => t);
  const keep = serve && left.length > 0 ? hostOff ?? hostLeft : undefined;
  for (const { d, s } of takeOuts) if (s !== keep?.s) merged.set(k(d.dishId, s.stepIndex), { dishId: d.dishId, stepIndex: s.stepIndex });
  let out: ScheduleResult = res;
  if (keep && serve) {
    const own = res.steps.filter((e) => e.dishId === keep.d.dishId);
    const prev = own.filter((e) => e.originalStepIndex < keep.s.stepIndex).sort((a, b) => b.originalStepIndex - a.originalStepIndex)[0];
    const next = own.filter((e) => e.originalStepIndex > keep.s.stepIndex && e !== serve).sort((a, b) => a.originalStepIndex - b.originalStepIndex)[0];
    const L = keep.s.estimatedMinutes;
    const lo = Math.max(prev ? prev.startOffsetMinutes + dur(prev) : -Infinity, ...left.map((x) => x.ovenEnd));
    const hi = Math.min(next ? next.startOffsetMinutes : Infinity, serve.startOffsetMinutes) - L;
    // (The lid, the knob and a side's own rest take no hands.)
    const busy = res.steps.filter((e) => { const s = stepOf.get(k(e.dishId, e.originalStepIndex)); return !!s && !isUnattended(s) && ![REST_AFTER_OVEN, KEEP_WARM_STEP, OVEN_OFF_STEP].some((re) => re.test(s.text ?? "")); });
    const free = (t: number) => !busy.some((e) => t < e.startOffsetMinutes + dur(e) && e.startOffsetMinutes < t + L);
    let t: number | null = null;
    for (let at = hi; at >= Math.max(lo, serve.startOffsetMinutes - WARM_GAP) && t === null; at--) if (free(at)) t = at;
    // No free minute that late: as late as it can be, beside the platings — a moment, as
    // the lid and the knob are (an earlier free minute plates the side cold, BUG-521; a
    // later serve breaks the carve's cap, D-WS9-322).
    t ??= hi >= lo ? hi : lo;
    const entry: ScheduledStep = { dishId: keep.d.dishId, originalStepIndex: keep.s.stepIndex, sequenceIndex: 0, startOffsetMinutes: t };
    const steps = [...res.steps, entry]
      .sort((a, b) => a.startOffsetMinutes - b.startOffsetMinutes || (a === entry ? 1 : 0) - (b === entry ? 1 : 0) || a.sequenceIndex - b.sequenceIndex)
      .map((e, i) => ({ ...e, sequenceIndex: i }));
    // Its minute is the cook's (an assemble step).
    out = feastCuesAsServed({ ...res, steps, activeEstimatedMinutes: res.activeEstimatedMinutes + L }, dishes);
  }
  const all = [...merged.values()];
  return { ...out, ...(all.length > 0 ? { mergedSteps: all } : {}) };
}

function scheduleTheDay(
  dishes: SchedulerDish[],
  opts: ScheduleOptions = {},
): ScheduleResult {
  const core = scheduleCookingSequenceCore(dishes, opts);
  if (core.steps.length === 0) return core;
  const input = dishes.map((d) => ({ ...d, steps: selectDefaultPathSteps(d.steps) })).filter((d) => d.steps.length > 0);
  // THX-3d round 2 (M) — a morning step and what leads to it, in the first free window.
  // THX-3d round 3 (U) — what is served hot, as late as the hands allow.
  const morning = heldMorningFirst(core, input, { lead: !opts.feastOven });
  if (!opts.feastOven) return serveLate(morning, input, false);
  const result = serveLate(morning, input, true);
  // THX-3d (R4) — the steps merged away, for the client (it must not append them).
  const kept = new Set(mergeFeastPreheats(input).dishes.flatMap((d) => d.steps.map((s) => `${d.dishId}#${s.stepIndex}`)));
  const mergedSteps = input.flatMap((d) => d.steps.filter((s) => !kept.has(`${d.dishId}#${s.stepIndex}`)).map((s) => ({ dishId: d.dishId, stepIndex: s.stepIndex })));
  // THX-3d round 4 (BUG-497 item 7) — the carve as late as the hands allow.
  // THX-3d round 5 (BUG-521) — then a side kept warm is plated at serving (the carve again
  // when that moved it), and the warm steps are decided on the day as it finally stands.
  const carved = carveLate(feastServeOrder(result, input), input);
  const plated = feastPlatedAtServing(carved, input);
  // THX-3d round 2 (J) — the warm steps that are not needed today go with them.
  const warm = feastWarmSteps(plated === carved ? carved : carveLate(plated, input), input);
  const all = [...mergedSteps, ...(core.mergedSteps ?? []), ...warm.dropped].filter((m, i, a) => a.findIndex((x) => x.dishId === m.dishId && x.stepIndex === m.stepIndex) === i);
  return { ...feastCuesAsServed(warm.result, input), ...(all.length > 0 ? { mergedSteps: all } : {}) };
}

/**
 * THX-4 (BUG-529, part 3) — A CUE SAYS WHAT IS HAPPENING WHEN THE STEP IS DONE. The core
 * pass words each cue from its own timeline ("With the Sweet Potato Casserole cooking,
 * start on …"); the feast's later passes move steps (serve late, the carve, the
 * plating) and a moved step's cue goes with it, but a step that stays keeps a cue whose
 * window has moved away. Classic's serve step at T−2 read "With the Sweet Potato
 * Casserole cooking": the casserole's bake had ended at T−19, its oven off since. So, on
 * the day as it finally stands, a cue is kept only when the dish it names has a
 * hands-free step running as the step starts (started before it in the order the cook
 * reads); otherwise it goes. Silence over a wrong claim (BUG-337).
 */
export function feastCuesAsServed(res: ScheduleResult, dishes: readonly SchedulerDish[]): ScheduleResult {
  const k = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const stepOf = new Map(dishes.flatMap((d) => d.steps.map((s) => [k(d.dishId, s.stepIndex), s] as const)));
  const titled = [...dishes].sort((a, b) => b.title.length - a.title.length);
  let changed = false;
  const steps = res.steps.map((e) => {
    if (!e.reason) return e;
    const named = titled.find((d) => d.dishId !== e.dishId && e.reason!.startsWith(`With the ${d.title} `));
    const running = named && res.steps.some((o) => {
      if (o.dishId !== named.dishId || o.sequenceIndex >= e.sequenceIndex) return false;
      const s = stepOf.get(k(o.dishId, o.originalStepIndex));
      return !!s && isUnattended(s) && o.startOffsetMinutes <= e.startOffsetMinutes && e.startOffsetMinutes < o.startOffsetMinutes + s.estimatedMinutes;
    });
    if (running) return e;
    changed = true;
    const { reason: _reason, ...plain } = e;
    return plain;
  });
  return changed ? { ...res, steps } : res;
}

// ── THX-3d round 3 (U) — SERVED HOT, AT SERVING TIME ─────────────────────────────────
//
// Weeknight Tuesday warmed its tortillas, then the pico de gallo was finished, and the
// tortillas sat ten minutes before "Spoon the filling into the warm tortillas … and serve
// immediately": a dish whose last step serves it now (SERVE_NOW) ends with its run from
// its last cook step aligned to serve, the other dishes finishing as it starts — in the
// core pass (scheduleOnceCore, serveNowFrom), not a feast's.
//
// New Twist's smashed potatoes were taken out of the oven a minute after "Turn the oven
// off and leave the sides inside … to keep warm". So, after a feast's schedule, a side's
// steps after its warm step (the keep-warm or the oven-off) — the plating, the garnish —
// move as late as the cook's hands allow before the rest of the meal is done, never
// before what precedes them in their dish, and serving is never moved: a run that does
// not fit later, or would end earlier than it did, stays where it was. Latest-ending
// first. A meal with nothing to move is returned untouched.

export const SERVE_NOW = /\bserve (?:it |them )?(?:immediately|right away|warm|hot)\b|\bwhile (?:still )?(?:warm|hot)\b/i;
/**
 * PREP-3 (R6) — a closing step that waits on purpose: it chills, rests or keeps warm.
 * ("the chilled romaine" and "the rest of the dressing" do not wait.)
 */
const WAITS = /\b(?:refrigerat\w*|chill(?!ed\b)\w*|cool\w*|rest(?!\s+of\b)\w*|let (?:it |them )?(?:stand|sit)|set aside|keep (?:it |them )?warm|until ready to serve|cover and)\b/i;
/** PREP-3 (R6) — a cook step whose food is left to cool ("transfer to a plate to cool"): nothing after it is held hot. */
const COOLS = /\b(?:to cool|let (?:it |them )?cool|cool (?:completely|slightly|for))\b/i;

// ── PREP-3 (R7) — A DISH THAT USES ANOTHER DISH WAITS FOR IT ─────────────────────────
//
// Weeknight Friday spooned the meatballs into the toasted rolls at T−7 and broiled them,
// while "Beef and Pork Meatballs in Marinara" simmered "until cooked through" to T+0:
// every dish was aligned to serving on its own, and nothing said the subs needed the
// meatballs. A step that USES another dish's food — a verb that puts food somewhere
// ("Spoon 3–4 meatballs … into each roll", "Ladle the chili into each potato") naming
// the other dish's food by its title's nouns — starts after that dish is done (its last
// cook step and the rests after it), and that dish finishes as the step would start.
// Not a use: a food of the step's own dish ("the rice" of a fried rice), its own title's
// word, or a food named beside something else ("alongside the chicken", "sharing the
// oven with the meatloaf", "while the meatballs simmer"). Two dishes that each use the
// other wait for neither.

const USE_VERB = /\b(?:spoon|ladle|add|top|layer|fill|stuff|place|arrange|pour|drizzle|spread|divide|dip|tuck|nestle|stir in|fold in|scatter|pile|load|build|assemble|transfer)\b/gi;
/** Before the food: words that make it a neighbour, a time or an oven-mate, not a use. */
const NOT_A_USE = /\b(?:alongside|beside|next to|with|while|as|until|after|before|like|from|than|onto the same|in the same)\s+(?:the\s+|a\s+|an\s+)?(?:[\w-]+\s+){0,2}$/i;
/**
 * …further back, a neighbour or what the food is for ("alongside the chili dogs and creamy
 * coleslaw", "as the base for the Kung Pao Chicken", "for topping the tacos"). Never
 * "with": "top with mango salsa and lime crema" is the use.
 */
const NOT_A_USE_FAR = /\b(?:alongside|beside|next to|as|for)\s+(?:the\s+|a\s+|an\s+)?(?:[\w-]+\s+){0,4}$/i;
/** Title words that name no food of the dish's own (seasonings, cooking words, the plate). */
const TITLE_NOT_FOOD = /^(?:garlic|lemon|lime|herb|herbs|butter|salt|pepper|spice|spices|sauce|style|classic|simple|easy|quick|fresh|homemade|side|plate|platter|bowl|bowls|board|night|dinner|toppings?|fixings|extra|crispy|melted|warm|toasted|steamed|seasoned|roasted|grilled|baked|fried|sauteed|sautéed|charred|creamy|chunky|tangy|smoky|spicy|sweet|cold|hot|mixed|green|white|red|black|brown|roast)$/i;
const singularWord = (w: string) => w.toLowerCase().replace(/(?:(?<=[sxz]|ch|sh|o)es|s)$/, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The nouns a dish's title calls its food: each part's last word ("Meatballs", "Marinara"). */
export function titleFoods(title: string): string[] {
  return [...new Set(
    title.split(/\s+(?:with|and|in|on|over|&)\s+|,\s*|:\s*/i)
      .map((part) => part.trim().split(/\s+/).pop() ?? "")
      .map((w) => w.replace(/[^A-Za-zÀ-ÿ'-]/g, ""))
      .filter((w) => w.length >= 4 && !TITLE_NOT_FOOD.test(w))
      .map(singularWord),
  )];
}

export interface DishUse {
  /** The dish whose step uses the other's food, and that step's position in it. */
  dishId: string;
  stepIdx: number;
  /** The dish it uses, and the position of the step after which that dish is done. */
  usesDishId: string;
  doneIdx: number;
  food: string;
}

/** The step after which a dish is done: its last cook step and the rests right after it. */
function doneIndexOf(dish: SchedulerDish): number {
  const lastCook = dish.steps.map((s) => s.phaseType).lastIndexOf("cook");
  if (lastCook < 0) return dish.steps.length - 1;
  let k = lastCook;
  while (k + 1 < dish.steps.length && dish.steps[k + 1].phaseType === "rest") k++;
  return k;
}

export function dishUses(dishes: readonly SchedulerDish[]): DishUse[] {
  const out: DishUse[] = [];
  for (const d of dishes) {
    const own = new Set([
      ...(d.ingredientNames ?? []).flatMap((n) => n.toLowerCase().split(/[\s,()/-]+/).map(singularWord)),
      ...d.title.toLowerCase().split(/[\s,()/:-]+/).map(singularWord),
    ]);
    for (const o of dishes) {
      if (o.dishId === d.dishId) continue;
      const foods = titleFoods(o.title).filter((f) => !own.has(f));
      if (foods.length === 0) continue;
      d.steps.forEach((s, stepIdx) => {
        const text = s.text ?? "";
        for (const clause of text.split(/[.;]/)) {
          for (const v of clause.matchAll(USE_VERB)) {
            // ("…refrigerate until ready to drizzle over the tacos": not yet.)
            if (/\bready to\s+$/i.test(clause.slice(0, v.index))) continue;
            const after = clause.slice(v.index! + v[0].length, v.index! + v[0].length + 60);
            for (const f of foods) {
              // (Its drippings, juices or bones are the pan's: the feast's DRIPPINGS rule times those.)
              const m = new RegExp(`\\b${escapeRe(f)}(?:e?s)?\\b(?!\\s+(?:drippings|juices?|fat|bones|carcass|stock|pan)\\b)`, "i").exec(after);
              if (!m) continue;
              if (NOT_A_USE.test(after.slice(0, m.index)) || NOT_A_USE_FAR.test(after.slice(0, m.index))) continue;
              if (!out.some((u) => u.dishId === d.dishId && u.stepIdx === stepIdx && u.usesDishId === o.dishId)) {
                out.push({ dishId: d.dishId, stepIdx, usesDishId: o.dishId, doneIdx: doneIndexOf(o), food: f });
              }
            }
          }
        }
      });
    }
  }
  // Each uses the other: neither waits (the birria and its consommé, the tacos dipped in both).
  return out.filter((u) => !out.some((x) => x.dishId === u.usesDishId && x.usesDishId === u.dishId));
}

export function serveLate(res: ScheduleResult, dishes: readonly SchedulerDish[], feast: boolean): ScheduleResult {
  const key = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const stepOf = new Map(dishes.flatMap((d) => d.steps.map((s) => [key(d.dishId, s.stepIndex), s] as const)));
  const total = res.totalEstimatedMinutes;
  const start = new Map(res.steps.map((e) => [key(e.dishId, e.originalStepIndex), e.startOffsetMinutes + total]));
  const runs: { keys: string[]; before: string | null }[] = [];
  for (const d of dishes) {
    const placed = [...d.steps].filter((s) => start.has(key(d.dishId, s.stepIndex))).sort((a, b) => a.stepIndex - b.stepIndex);
    if (placed.length < 2) continue;
    let from = -1;
    if (feast && !DESSERT_DISH.test(d.title)) {
      const warm = placed.findIndex((s) => KEEP_WARM_STEP.test(s.text ?? "") || OVEN_OFF_STEP.test(s.text ?? ""));
      if (warm >= 0 && warm < placed.length - 1) from = warm + 1;
    }
    // PREP-3 (R6) — a weeknight's closing run of assemble steps (the toss, the plate-up),
    // when nothing before it is held hot: after prep, or after food left to cool (hh4-mixed
    // Thursday toasted the croutons, "transfer to a plate to cool", and its timing-sensitive
    // toast had pulled the toss and the plating to T−16, before the salmon's run at T−9).
    // A run after a hot cook step or a rest is the core pass's (plateLateFrom). Text only.
    if (!feast && !SERVE_NOW.test(placed[placed.length - 1].text ?? "")) {
      let c = placed.length;
      while (c > 0 && placed[c - 1].phaseType === "assemble") c--;
      const prev = placed[c - 1];
      const run = placed.slice(c);
      const cold = prev && (prev.phaseType === "prep" || (prev.phaseType === "cook" && COOLS.test(prev.text ?? "")));
      if (c > 0 && run.length > 0 && cold && run.every((s) => s.text && !WAITS.test(s.text))) from = c;
    }
    if (from <= 0) continue;
    const keys = placed.slice(from).filter((s) => !FEAST_SERVE_STEP.test(s.text ?? "")).map((s) => key(d.dishId, s.stepIndex));
    if (keys.length > 0) runs.push({ keys, before: key(d.dishId, placed[from - 1].stepIndex) });
  }
  if (runs.length === 0) return res;
  const minutes = (k: string) => stepOf.get(k)?.estimatedMinutes ?? 0;
  const attended = (k: string) => { const s = stepOf.get(k); return !!s && !isUnattended(s); };
  // THX-3d round 5 (BUG-521) — in a feast, a side's own rest, the lid and the knob take no
  // hands, as in carveLate: Vegetarian's "Let the mac and cheese rest 5 minutes" had pushed
  // the potatoes' and the sprouts' plating earlier — to T−17 at 10 servings, past the 15
  // minutes a keep-warm covers. (A weeknight's closing run never holds such a step.)
  const noHands = (k: string) => feast && [REST_AFTER_OVEN, KEEP_WARM_STEP, OVEN_OFF_STEP].some((re) => re.test(stepOf.get(k)?.text ?? ""));
  const moving = new Set(runs.flatMap((r) => r.keys));
  // Serving: the end of everything that is not a serve step or a dessert after it.
  const others = res.steps.filter((e) => !FEAST_SERVE_STEP.test(stepOf.get(key(e.dishId, e.originalStepIndex))?.text ?? ""));
  const end = Math.max(...others.filter((e) => !moving.has(key(e.dishId, e.originalStepIndex))).map((e) => start.get(key(e.dishId, e.originalStepIndex))! + minutes(key(e.dishId, e.originalStepIndex))), ...runs.map((r) => start.get(r.keys[r.keys.length - 1])! + minutes(r.keys[r.keys.length - 1])));
  const busy: [number, number][] = res.steps
    .map((e) => key(e.dishId, e.originalStepIndex))
    .filter((k) => !moving.has(k) && attended(k) && !noHands(k))
    .map((k) => [start.get(k)!, start.get(k)! + minutes(k)]);
  const fits = (t: number, keys: readonly string[]) => {
    let at = t;
    for (const k of keys) {
      const m = minutes(k);
      const clash = attended(k) ? busy.some(([s, f]) => at < f && s < at + m) : busy.some(([s, f]) => s <= at && at < f);
      if (clash) return false;
      at += m;
    }
    return true;
  };
  const placedAt = new Map<string, number>();
  for (const r of [...runs].sort((a, b) => (start.get(b.keys[0]) ?? 0) - (start.get(a.keys[0]) ?? 0))) {
    const len = r.keys.reduce((n, k) => n + minutes(k), 0);
    const was = start.get(r.keys[0])!;
    const floor = r.before ? start.get(r.before)! + minutes(r.before) : was;
    let t = end - len;
    while (t > was && !fits(t, r.keys)) t--;
    const lastKey = r.keys[r.keys.length - 1];
    if (t <= was || t < floor || t + len < start.get(lastKey)! + minutes(lastKey)) {
      // THX-3d round 5 (BUG-521) — a run that stays keeps its hands (Classic's gravy, left
      // at T−3, had the potatoes' plating put on top of it); its rest, lid and knob none.
      for (const k of r.keys) if (attended(k) && !noHands(k)) busy.push([start.get(k)!, start.get(k)! + minutes(k)]);
      continue;
    }
    let at = t;
    for (const k of r.keys) {
      placedAt.set(k, at);
      if (attended(k) && !noHands(k)) busy.push([at, at + minutes(k)]);
      at += minutes(k);
    }
  }
  if (placedAt.size === 0) return res;
  const steps = res.steps
    .map((e) => {
      const k = key(e.dishId, e.originalStepIndex);
      const moved = placedAt.get(k);
      if (moved === undefined) return e;
      const { reason: _reason, ...rest } = e;
      return { ...rest, startOffsetMinutes: moved - total };
    })
    .sort((a, b) => a.startOffsetMinutes - b.startOffsetMinutes || a.sequenceIndex - b.sequenceIndex)
    .map((e, i) => ({ ...e, sequenceIndex: i }));
  return { ...res, steps };
}

// ── THX-3d round 2 (M) — THE MORNING CUT, IN THE FIRST FREE WINDOW ───────────────────
//
// Hans, Oct 22: a cut held for cook day is done "in the morning", and waits — in the pot
// of cold water on the stove, off, or tossed in its oil in the fridge (heldMorning.ts
// words it; its last words are the marker, HELD_MORNING_STEP). So it is not timed to the
// pot: a dish's steps up to and including its last morning step move, as one block, to
// the earliest moment the cook's hands are free for that long — from the start of the
// day, before the dish's next step. When the hands are never free that early the block
// opens the day instead. Only the day's own steps count (make-ahead and thaw runs are
// the Hub's). A meal without a morning step is returned untouched.
//
// A weeknight dinner is no day-long session: its morning step is Cook Mode's FIRST step
// (Hans: "the note becomes that day's first Cook Mode step"), so for any meal but a
// feast (`lead`) every block opens the day.

/** How a morning step's food waits — its last words (heldMorning.ts writes them). */
export const HOLD_BOILED = "and leave the pot on the stove, off, until it's time to cook";
export const HOLD_TOSSED = "they can sit, covered, in the fridge for a few hours";
export const HOLD_BROWNS = "keep them in cold water until it's time to cook";
export const HOLD_GARNISH = "keep it covered in a small container in the fridge until serving";
export const HOLD_OTHER = "keep it covered in the fridge until it's time to cook";
/** The same, for a food said in the plural ("the broccoli florets"). */
export const HOLD_OTHER_PLURAL = "keep them covered in the fridge until it's time to cook";
/** A morning step: it ends with one of those. */
export const HELD_MORNING_STEP =
  /(?:leave the pot on the stove, off, until it's time to cook|they can sit, covered, in the fridge for a few hours|keep them in cold water until it's time to cook|keep it covered in a small container in the fridge until serving|keep (?:it|them) covered in the fridge until it's time to cook)\.\s*$/i;

const AHEAD_RUN_START = /^\s*(?:make ahead|thaw) \(/i;
const ON_THE_DAY = /^\s*on [a-z]+day:/i;

/** Each dish's morning chain: its day's steps up to and including its last morning step, and the step after it ("dishId#stepIndex" keys). */
export function morningChains(dishes: readonly SchedulerDish[]): { keys: string[]; minutes: number; next: string }[] {
  const key = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const chains: { keys: string[]; minutes: number; next: string }[] = [];
  for (const d of dishes) {
    let inRun = false;
    const day = [...d.steps]
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .filter((s) => {
        if (AHEAD_RUN_START.test(s.text ?? "")) inRun = true;
        else if (ON_THE_DAY.test(s.text ?? "")) inRun = false;
        return !inRun;
      });
    const last = day.reduce((m, s, i) => (HELD_MORNING_STEP.test(s.text ?? "") ? i : m), -1);
    if (last < 0 || last === day.length - 1) continue;
    chains.push({ keys: day.slice(0, last + 1).map((s) => key(d.dishId, s.stepIndex)), minutes: day.slice(0, last + 1).reduce((n, s) => n + s.estimatedMinutes, 0), next: key(d.dishId, day[last + 1].stepIndex) });
  }
  return chains;
}

export function heldMorningFirst(res: ScheduleResult, dishes: readonly SchedulerDish[], opts: { lead?: boolean } = {}): ScheduleResult {
  const key = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const entryOf = new Map(res.steps.map((e) => [key(e.dishId, e.originalStepIndex), e]));
  const stepOf = new Map(dishes.flatMap((d) => d.steps.map((s) => [key(d.dishId, s.stepIndex), s] as const)));
  const chains = morningChains(dishes).filter((c) => c.keys.every((k) => entryOf.has(k)) && entryOf.has(c.next));
  if (chains.length === 0) return res;
  const total = res.totalEstimatedMinutes;
  const moving = new Set(chains.flatMap((c) => c.keys));
  const start = new Map(res.steps.map((e) => [key(e.dishId, e.originalStepIndex), e.startOffsetMinutes + total]));
  const staying = res.steps.filter((e) => !moving.has(key(e.dishId, e.originalStepIndex)));
  const busy: [number, number][] = staying
    .map((e) => ({ e, s: stepOf.get(key(e.dishId, e.originalStepIndex)) }))
    .filter((x) => x.s && !isUnattended(x.s))
    .map((x) => [start.get(key(x.e.dishId, x.e.originalStepIndex))!, start.get(key(x.e.dishId, x.e.originalStepIndex))! + x.s!.estimatedMinutes]);
  const dayStart = Math.min(...staying.map((e) => start.get(key(e.dishId, e.originalStepIndex))!));
  const free = (t: number, m: number) => busy.every(([b0, b1]) => b1 <= t || b0 >= t + m);
  const leaders: (typeof chains)[number][] = [];
  const placed = new Map<string, number>();
  const lay = (c: (typeof chains)[number], at: number) => {
    let t = at;
    for (const k of c.keys) {
      placed.set(k, t);
      t += stepOf.get(k)!.estimatedMinutes;
    }
  };
  for (const c of chains) {
    const deadline = start.get(c.next)!;
    const at = opts.lead ? undefined : [dayStart, ...busy.map(([, b1]) => b1)].filter((t) => t >= dayStart).sort((a, b) => a - b).find((t) => t + c.minutes <= deadline && free(t, c.minutes));
    if (at === undefined) leaders.push(c);
    else {
      lay(c, at);
      busy.push([at, at + c.minutes]);
    }
  }
  let t = dayStart - leaders.reduce((n, c) => n + c.minutes, 0);
  for (const c of leaders) {
    lay(c, t);
    t += c.minutes;
  }
  const abs = (e: ScheduledStep) => placed.get(key(e.dishId, e.originalStepIndex)) ?? start.get(key(e.dishId, e.originalStepIndex))!;
  const shift = Math.max(0, -Math.min(...res.steps.map(abs)));
  const end = total + shift;
  const steps = res.steps
    .map((e) => {
      const moved = placed.has(key(e.dishId, e.originalStepIndex));
      const { reason: _reason, ...rest } = e;
      return { ...(moved ? rest : e), startOffsetMinutes: Math.round(abs(e) + shift - end) };
    })
    .sort((a, b) => a.startOffsetMinutes - b.startOffsetMinutes || a.sequenceIndex - b.sequenceIndex)
    .map((e, i) => ({ ...e, sequenceIndex: i }));
  return { ...res, steps, totalEstimatedMinutes: end };
}

// ── THX-3d round 2 (J) — NOTHING COLD, NOTHING FORGOTTEN IN THE OVEN ─────────────────
//
// Hans's lens: nothing sits cold. Every stovetop side carries a code-written "Cover and
// keep warm over the lowest heat." after its last hot step, and every oven side a "Turn
// the oven off and leave the sides inside …" after its last oven step (scripts/thx2
// thx2Warm, never AI). Which ones Cook Mode shows is decided HERE, on the day's own
// schedule, so a swapped or added dish is judged the same way: a keep-warm only when its
// side's hot step ends more than WARM_GAP minutes before serving; ONE oven-off, the side
// whose oven finishes last, and only when that is more than WARM_GAP before serving. The
// rest are merged away (mergedSteps: the client must not append them).
export const KEEP_WARM_TEXT = "Cover and keep warm over the lowest heat.";
export const KEEP_WARM_STEP = /^\s*Cover and keep warm over the lowest heat\.\s*$/i;
export const OVEN_OFF_TEXT = "Turn the oven off and leave the sides inside, covered loosely with foil, to keep warm.";
export const OVEN_OFF_STEP = /^\s*Turn the oven off and leave the sides inside\b/i;
/**
 * THX-4 (BUG-529) — WHAT GOES INTO THE TURNED-OFF OVEN COMES OUT. Classic's green bean
 * and sweet potato casseroles went into the off oven at T−19 "to keep warm", and no step
 * took them out: the serve step named them, and the cook had to guess. Every oven-off is
 * followed by this code-written step (scripts/thx2 thx2Warm). It is the oven-off's
 * plating — served at serving, as BUG-521 serves a keep-warm's — and it goes with its
 * oven-off when the day drops that one ("the sides": every side left inside).
 */
export const TAKE_OUT_TEXT = "Take the sides out of the oven.";
export const TAKE_OUT_STEP = /^\s*Take the sides out of the oven\b/i;
/** Minutes before serving that a side may finish without a warm step. */
export const WARM_GAP = 15;
/** A step that plates the dish (round 3, U): the keep-warm comes before it (thx2Warm), and round 5 serves it late. */
export const PLATING_STEP = /\b(?:serving (?:bowl|dish|platter)|platter|gravy boat)\b/i;
/** A side's own rest out of the oven: "Let the stuffing rest 5 minutes." */
const REST_AFTER_OVEN = /^\s*Let (?:the [^.;]+?|it|them) rest \d+(?:\s*(?:–|-|to)\s*\d+)? minutes\.?\s*$/i;

// ── THX-3d round 4 (BUG-497 item 7) — THE CARVED BIRD WAITS NO MORE THAN 10 MINUTES ──
//
// Carved as its rest ended, Small's breast waited 22 minutes on the platter and Classic's
// turkey 20 while the sides finished. The carve lands later instead — the bird keeps
// resting, whole and tented, which holds its heat — at the latest moment the cook's hands
// are free before serving. Where they are never free late enough, it waits as little as
// they allow (the content says to tent it: thx2Next carveTentEdits).
export const CARVED_WAIT_MAX = 10;

export function carveLate(res: ScheduleResult, dishes: readonly SchedulerDish[]): ScheduleResult {
  const bird = feastRoastDish(dishes);
  if (!bird) return res;
  const d = dishes.find((x) => x.dishId === bird.dishId)!;
  const rest = d.steps.findIndex((s, i) => i > bird.lastOven && s.phaseType === "rest");
  const carve = rest >= 0 ? d.steps.slice(rest + 1).find((s) => !FEAST_SERVE_STEP.test(s.text ?? "")) : undefined;
  const e = carve && res.steps.find((x) => x.dishId === d.dishId && x.originalStepIndex === carve.stepIndex);
  if (!carve || !e) return res;
  const stepOf = new Map(dishes.flatMap((x) => x.steps.map((s) => [`${x.dishId}#${s.stepIndex}`, s] as const)));
  const serve = res.steps.find((x) => FEAST_SERVE_STEP.test(stepOf.get(`${x.dishId}#${x.originalStepIndex}`)?.text ?? ""));
  const serveAt = serve ? serve.startOffsetMinutes : 0;
  if (serveAt - (e.startOffsetMinutes + carve.estimatedMinutes) <= CARVED_WAIT_MAX) return res;
  const L = carve.estimatedMinutes;
  const c0 = e.startOffsetMinutes;
  const c1 = c0 + L;
  const stepFor = (x: ScheduledStep) => stepOf.get(`${x.dishId}#${x.originalStepIndex}`);
  // (The lid, the knob and a side's own rest take no hands, as in the pass.)
  const attended = (x: ScheduledStep) => { const s = stepFor(x); return !!s && !isUnattended(s) && !REST_AFTER_OVEN.test(s.text ?? "") && !KEEP_WARM_STEP.test(s.text ?? "") && !OVEN_OFF_STEP.test(s.text ?? ""); };
  const fixed = (x: ScheduledStep) => {
    const s = stepFor(x);
    if (!s || x.dishId === d.dishId) return true;
    const title = dishes.find((y) => y.dishId === x.dishId)?.title ?? "";
    return isOvenStep(s) || isReheatStep(s) || ALREADY_IN.test(s.text ?? "") || PUT_IN_ONE.test(s.text ?? "") || FEAST_SERVE_STEP.test(s.text ?? "") || DESSERT_DISH.test(title);
  };
  /** The carve at t, the work that started between its old end and its new end moved earlier by its minutes; null when that breaks a dish's order or moves an oven step. */
  const tryAt = (t: number): ScheduledStep[] | null => {
    const shifted = new Set(res.steps.filter((x) => x !== e && x.startOffsetMinutes >= c1 && x.startOffsetMinutes < t + L));
    if ([...shifted].some((x) => fixed(x) && (attended(x) || x.startOffsetMinutes < t + L))) {
      // An oven step or a put-in in the way stays put: the moved work must not need its moment.
      for (const x of [...shifted]) if (fixed(x)) shifted.delete(x);
      if (res.steps.some((x) => x !== e && fixed(x) && attended(x) && x.startOffsetMinutes < t + L && t < x.startOffsetMinutes + (stepFor(x)?.estimatedMinutes ?? 0))) return null;
    }
    const startOf = (x: ScheduledStep) => (x === e ? t : shifted.has(x) ? x.startOffsetMinutes - L : x.startOffsetMinutes);
    for (const x of shifted) {
      const s = stepFor(x)!;
      const own = res.steps.filter((y) => y.dishId === x.dishId && y.originalStepIndex < x.originalStepIndex);
      if (own.some((y) => startOf(y) + (stepFor(y)?.estimatedMinutes ?? 0) > startOf(x))) return null;
      if (attended(x) && res.steps.some((y) => y !== x && attended(y) && startOf(y) < startOf(x) + s.estimatedMinutes && startOf(x) < startOf(y) + (stepFor(y)?.estimatedMinutes ?? 0))) return null;
    }
    // A step left behind that a moved step of its dish now finishes too early for stays in order (it was already after it).
    if (res.steps.some((y) => y !== e && attended(y) && !shifted.has(y) && startOf(y) < t + L && t < startOf(y) + (stepFor(y)?.estimatedMinutes ?? 0))) return null;
    const { reason: _reason, ...plain } = e;
    return res.steps.map((x) => (x === e ? { ...plain, startOffsetMinutes: t } : shifted.has(x) ? { ...x, startOffsetMinutes: x.startOffsetMinutes - L } : x));
  };
  /**
   * THX-3d round 5 (D-WS9-322 (1): the cap is hard) — failing the trade, each step in the
   * carve's way is placed on its own: the latest free moment before the carve after its
   * dish's previous step, else the first after the carve that ends by serving and before
   * its dish's next step. New Twist at 4 servings: the gravy's seasoning could not move a
   * whole carve's length earlier (its keep-warm sits right before it); it goes after.
   */
  const dur = (x: ScheduledStep) => stepFor(x)?.estimatedMinutes ?? 0;
  const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
  const tryPlace = (t: number, extra = 0): ScheduledStep[] | null => {
    const pos = new Map(res.steps.map((x) => [x, x.startOffsetMinutes] as const));
    pos.set(e, t);
    // (Serving `extra` minutes later: the serve step and what follows it move with it.)
    const later = (y: ScheduledStep) => extra > 0 && y.startOffsetMinutes >= serveAt;
    const blockers = res.steps
      .filter((x) => x !== e && attended(x) && !later(x) && overlaps(t, t + L, x.startOffsetMinutes, x.startOffsetMinutes + dur(x)))
      .sort((a, b) => a.startOffsetMinutes - b.startOffsetMinutes);
    if (blockers.some(fixed)) return null;
    const handsFree = (x: ScheduledStep, at: number) => res.steps.every((y) => y === x || later(y) || !attended(y) || !overlaps(at, at + dur(x), pos.get(y)!, pos.get(y)! + dur(y)));
    for (const x of blockers) {
      const own = res.steps.filter((y) => y.dishId === x.dishId && y !== x);
      const predEnd = Math.max(-Infinity, ...own.filter((y) => y.originalStepIndex < x.originalStepIndex).map((y) => pos.get(y)! + dur(y)));
      const succStart = Math.min(Infinity, ...own.filter((y) => y.originalStepIndex > x.originalStepIndex && !later(y)).map((y) => pos.get(y)!));
      let placed: number | null = null;
      for (let at = t - dur(x); at >= predEnd && at > c0 - 60 && placed === null; at--) if (handsFree(x, at)) placed = at;
      for (let at = t + L; placed === null && at + dur(x) <= serveAt + extra && at + dur(x) <= succStart; at++) if (handsFree(x, at)) placed = at;
      if (placed === null) return null;
      pos.set(x, placed);
    }
    const { reason: _reason, ...plain } = e;
    // Offsets stay serve-anchored: what moved later keeps its own, the rest move earlier.
    const at = (x: ScheduledStep) => (later(x) ? x.startOffsetMinutes : pos.get(x)! - extra);
    return res.steps.map((x) => (x === e ? { ...plain, startOffsetMinutes: t - extra } : at(x) !== x.startOffsetMinutes ? { ...x, startOffsetMinutes: at(x) } : x));
  };
  // The earliest slot that brings the wait within CARVED_WAIT_MAX (the least work moved);
  // THX-3d round 5 (BUG-521, D-WS9-322 (1)) — failing that, serving moves later by the
  // fewest minutes that let the steps in the carve's way go after it (New Twist at 4
  // servings: 12 minutes of plating after a carve that may end no more than 10 before
  // serving, once two platings no longer share the cook's hands); failing that too, the
  // latest slot there is.
  let best: ScheduledStep[] | null = null;
  let grown = 0;
  for (let t = Math.max(c0 + 1, serveAt - L - CARVED_WAIT_MAX); t <= serveAt - L && !best; t++) best = tryAt(t) ?? tryPlace(t);
  for (let extra = 1; extra <= CARVED_WAIT_MAX && !best; extra++) {
    for (let t = Math.max(c0 + 1, serveAt + extra - L - CARVED_WAIT_MAX); t <= serveAt + extra - L && !best; t++) {
      best = tryPlace(t, extra);
      if (best) grown = extra;
    }
  }
  for (let t = serveAt - L - CARVED_WAIT_MAX - 1; t > c0 && !best; t--) best = tryAt(t) ?? tryPlace(t);
  if (!best) return res;
  const steps = best
    .sort((a, b) => a.startOffsetMinutes - b.startOffsetMinutes || a.sequenceIndex - b.sequenceIndex)
    .map((x, i) => ({ ...x, sequenceIndex: i }));
  return { ...res, steps, totalEstimatedMinutes: res.totalEstimatedMinutes + grown };
}

export function feastWarmSteps(res: ScheduleResult, dishes: readonly SchedulerDish[]): { result: ScheduleResult; dropped: { dishId: string; stepIndex: number }[] } {
  const none = { result: res, dropped: [] };
  const w = warmDecisions(res, dishes);
  if (!w) return none;
  const plated = keptWarmAtItsEnd(platedAtServing(res, dishes, w.kept, w.serve), dishes, w.kept);
  if (w.drop.size === 0 && plated === res) return none;
  const steps = plated.steps.filter((e) => !w.drop.has(`${e.dishId}#${e.originalStepIndex}`)).map((e, i) => ({ ...e, sequenceIndex: i }));
  return { result: { ...plated, steps }, dropped: [...w.drop].map((k) => ({ dishId: k.split("#")[0], stepIndex: Number(k.split("#")[1]) })) };
}

/**
 * THX-3d round 5 (BUG-521) — a kept keep-warm is the lid and the knob as its pot comes
 * off the boil: it starts as its dish's step before it ends (it takes no hands; carveLate
 * moves that step and not it — Classic's gravy simmered to T−19 and was covered at T−6).
 */
function keptWarmAtItsEnd(res: ScheduleResult, dishes: readonly SchedulerDish[], kept: readonly ScheduledStep[]): ScheduleResult {
  const k = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const stepOf = new Map(dishes.flatMap((d) => d.steps.map((s) => [k(d.dishId, s.stepIndex), s] as const)));
  const keys = new Set(kept.filter((e) => KEEP_WARM_STEP.test(stepOf.get(k(e.dishId, e.originalStepIndex))?.text ?? "")).map((e) => k(e.dishId, e.originalStepIndex)));
  let changed = false;
  const steps = res.steps.map((e) => {
    if (!keys.has(k(e.dishId, e.originalStepIndex))) return e;
    const prev = res.steps.filter((x) => x.dishId === e.dishId && x.originalStepIndex < e.originalStepIndex).sort((a, b) => b.originalStepIndex - a.originalStepIndex)[0];
    const end = prev ? prev.startOffsetMinutes + (stepOf.get(k(prev.dishId, prev.originalStepIndex))?.estimatedMinutes ?? 0) : null;
    if (end === null || end >= e.startOffsetMinutes) return e;
    changed = true;
    const { reason: _reason, ...plain } = e;
    return { ...plain, startOffsetMinutes: end };
  });
  if (!changed) return res;
  return { ...res, steps: steps.sort((a, b) => a.startOffsetMinutes - b.startOffsetMinutes || a.sequenceIndex - b.sequenceIndex).map((e, i) => ({ ...e, sequenceIndex: i })) };
}

/**
 * THX-3d round 5 (BUG-521) — the day plated at serving, its warm steps not yet dropped:
 * scheduleCookingSequence carves again after it (the plating may move the carve) and
 * decides the warm steps on the day as it finally stands (the carve had moved Classic's
 * gravy five minutes earlier after its keep-warm was dropped).
 */
export function feastPlatedAtServing(res: ScheduleResult, dishes: readonly SchedulerDish[]): ScheduleResult {
  const w = warmDecisions(res, dishes);
  return w ? platedAtServing(res, dishes, w.kept, w.serve) : res;
}

/** The warm steps the day drops (keys) and those it keeps, with the serve step; null when it has none. */
function warmDecisions(res: ScheduleResult, dishes: readonly SchedulerDish[]): { drop: Set<string>; kept: ScheduledStep[]; serve: ScheduledStep | null } | null {
  const byDish = new Map(dishes.map((d) => [d.dishId, d]));
  const at = new Map(res.steps.map((e) => [`${e.dishId}#${e.originalStepIndex}`, e.startOffsetMinutes]));
  const textOf = (dishId: string, stepIndex: number) => byDish.get(dishId)?.steps.find((s) => s.stepIndex === stepIndex)?.text ?? "";
  const warm = res.steps.filter((e) => KEEP_WARM_STEP.test(textOf(e.dishId, e.originalStepIndex)) || OVEN_OFF_STEP.test(textOf(e.dishId, e.originalStepIndex)));
  if (warm.length === 0) return null;
  const serve = res.steps.find((e) => FEAST_SERVE_STEP.test(textOf(e.dishId, e.originalStepIndex)));
  const serveAt = serve ? serve.startOffsetMinutes : 0;
  /** The end of the dish's last step before this one that `pick` accepts. */
  const endBefore = (dishId: string, stepIndex: number, pick: (s: SchedulerStep) => boolean): number | null => {
    const d = byDish.get(dishId);
    if (!d) return null;
    const prev = [...d.steps].filter((s) => s.stepIndex < stepIndex && pick(s) && at.has(`${dishId}#${s.stepIndex}`)).sort((a, b) => b.stepIndex - a.stepIndex)[0];
    return prev ? at.get(`${dishId}#${prev.stepIndex}`)! + prev.estimatedMinutes : null;
  };
  const drop = new Set<string>();
  for (const e of warm.filter((x) => KEEP_WARM_STEP.test(textOf(x.dishId, x.originalStepIndex)))) {
    const end = endBefore(e.dishId, e.originalStepIndex, (s) => s.phaseType === "cook");
    if (end === null || serveAt - end <= WARM_GAP) drop.add(`${e.dishId}#${e.originalStepIndex}`);
  }
  const offs = warm
    .filter((x) => OVEN_OFF_STEP.test(textOf(x.dishId, x.originalStepIndex)))
    .map((e) => ({ e, end: endBefore(e.dishId, e.originalStepIndex, (s) => isOvenStep(s) && s.phaseType !== "preheat") }));
  const lastOut = offs.reduce<(typeof offs)[number] | null>((b, o) => (o.end !== null && (b === null || (b.end ?? -Infinity) < o.end) ? o : b), null);
  for (const o of offs) {
    if (o === lastOut && o.end !== null && serveAt - o.end > WARM_GAP) {
      // THX-3d round 4 (BUG-497 item 2) — a side left in the turned-off oven needs no rest
      // after it ("Let the stuffing rest 5 minutes" after 25 minutes in it): every side
      // whose oven work is done by then rests there ("leave the sides inside").
      const offAt = o.e.startOffsetMinutes;
      for (const d of dishes) {
        const lastOvenEnd = endBefore(d.dishId, Infinity, (s) => isOvenStep(s) && s.phaseType !== "preheat");
        if (lastOvenEnd === null || lastOvenEnd > offAt) continue;
        for (const s of d.steps) {
          const sAt = at.get(`${d.dishId}#${s.stepIndex}`);
          if (sAt !== undefined && sAt >= offAt && REST_AFTER_OVEN.test(s.text ?? "")) drop.add(`${d.dishId}#${s.stepIndex}`);
        }
      }
      continue;
    }
    drop.add(`${o.e.dishId}#${o.e.originalStepIndex}`);
  }
  return { drop, kept: warm.filter((e) => !drop.has(`${e.dishId}#${e.originalStepIndex}`)), serve: serve ?? null };
}

/**
 * THX-3d round 5 (BUG-521) — a side kept warm is plated at serving, not as it is kept warm.
 * Classic's mashed potatoes were covered over the lowest heat at T−31 and went into the
 * serving bowl at T−30, to sit there 28 minutes: serveLate found no free hands later (the
 * gravy's simmer, the carve and the gravy's finish fill T−28 to serving). A kept warm
 * step's plating (its first later step that puts the dish in its serving vessel, and the
 * dish's steps after it) that starts more than WARM_GAP before serving goes to the latest
 * moment the hands are free within WARM_GAP of serving; failing that, right before the
 * serve step, which moves later by its minutes (the desserts after it with it). Only the
 * plating: a dev copy written before round 3's keep-warm rule kept warm BEFORE the drain,
 * and the drain and mash are not moved to serving with it. A day with nothing plated early
 * is returned untouched.
 */
function platedAtServing(res: ScheduleResult, dishes: readonly SchedulerDish[], kept: readonly ScheduledStep[], serve: ScheduledStep | null): ScheduleResult {
  if (!serve || kept.length === 0) return res;
  const k = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const stepOf = new Map(dishes.flatMap((d) => d.steps.map((s) => [k(d.dishId, s.stepIndex), s] as const)));
  const dur = (e: ScheduledStep) => stepOf.get(k(e.dishId, e.originalStepIndex))?.estimatedMinutes ?? 0;
  const attended = (e: ScheduledStep) => { const s = stepOf.get(k(e.dishId, e.originalStepIndex)); return !!s && !isUnattended(s); };
  const pos = new Map(res.steps.map((e) => [e, e.startOffsetMinutes] as const));
  let total = res.totalEstimatedMinutes;
  let changed = false;
  for (const w of [...kept].sort((a, b) => a.startOffsetMinutes - b.startOffsetMinutes)) {
    const after = res.steps
      .filter((e) => e.dishId === w.dishId && e.originalStepIndex > w.originalStepIndex && e !== serve)
      .sort((a, b) => a.originalStepIndex - b.originalStepIndex);
    // THX-4 (BUG-529) — an oven-off's take-out is its plating.
    const plates = after.findIndex((e) => { const t = stepOf.get(k(e.dishId, e.originalStepIndex))?.text ?? ""; return PLATING_STEP.test(t) || TAKE_OUT_STEP.test(t); });
    const run = plates < 0 ? [] : after.slice(plates);
    const serveAt = pos.get(serve)!;
    if (run.length === 0 || serveAt - pos.get(run[0])! <= WARM_GAP) continue;
    const len = run.reduce((n, e) => n + dur(e), 0);
    const others = res.steps.filter((e) => !run.includes(e) && attended(e));
    const handsFree = (t: number) => {
      let at = t;
      for (const e of run) {
        if (attended(e) && others.some((o) => at < pos.get(o)! + dur(o) && pos.get(o)! < at + dur(e))) return false;
        at += dur(e);
      }
      return true;
    };
    let t: number | null = null;
    for (let at = serveAt - len; at >= serveAt - WARM_GAP && t === null; at--) if (handsFree(at)) t = at;
    if (t === null) {
      // Before the serve step: everything that starts before it moves earlier by the run's
      // minutes (the day grows by them; serve stays the end).
      for (const e of res.steps) if (!run.includes(e) && pos.get(e)! < serveAt) pos.set(e, pos.get(e)! - len);
      total += len;
      t = serveAt - len;
    }
    for (const e of run) { pos.set(e, t); t += dur(e); }
    changed = true;
  }
  if (!changed) return res;
  const steps = res.steps
    .map((e) => (pos.get(e) === e.startOffsetMinutes ? e : (({ reason: _reason, ...plain }) => ({ ...plain, startOffsetMinutes: pos.get(e)! }))(e)))
    .sort((a, b) => a.startOffsetMinutes - b.startOffsetMinutes || a.sequenceIndex - b.sequenceIndex)
    .map((e, i) => ({ ...e, sequenceIndex: i }));
  return { ...res, steps, totalEstimatedMinutes: total };
}

// ── THX-3d (R4) — THE SERVE STEP, THEN DESSERT ──────────────────────────────────
//
// Hans, October 21: "pies get cut after the feast is on the table. like the last step
// in the cooking. cranberry sauce is a cold dish that goes out when everything else is
// served." The feast has ONE serve step, code-written after the carve (patch.ts,
// `feastServeText`), naming every dish on the table; it is placed after everything
// else finishes, and that is serve (T 0). A dessert's steps after its last oven step
// (slice the pie, scoop the crisp) follow it, one after another, at T 0 and later.

/** A dessert, by its title. */
export const DESSERT_DISH = /\b(pies?|tarts?|crisps?|cobblers?|cakes?|cheesecakes?|bars|crumbles?|puddings?)\b/i;
/** The code-written serve step: "Serve the Herb-Roasted Whole Turkey with the …". */
export const FEAST_SERVE_STEP = /^\s*Serve the .+ with the .+\.\s*$/i;

/** The serve step's words: the main dish with every other dish on the table. */
export function feastServeText(main: string, others: readonly string[]): string {
  const list = others.length <= 1 ? others.join("") : `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}`;
  return `Serve the ${main} with the ${list}.`;
}

/** THX-3d (R4) — the serve step last, then the desserts' after-oven steps from serve on. */
export function feastServeOrder(res: ScheduleResult, dishes: readonly SchedulerDish[]): ScheduleResult {
  const key = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;
  const stepOf = new Map<string, { step: SchedulerStep; dish: SchedulerDish; i: number; pos: number }>();
  dishes.forEach((d, pos) => d.steps.forEach((s, i) => stepOf.set(key(d.dishId, s.stepIndex), { step: s, dish: d, i, pos })));
  const lastOven = new Map(dishes.map((d) => [d.dishId, d.steps.reduce((m, s, i) => (isOvenStep(s) && !isReheatStep(s) ? i : m), -1)]));
  const total = res.totalEstimatedMinutes;
  const rows = res.steps.map((e) => {
    const at = stepOf.get(key(e.dishId, e.originalStepIndex));
    const dessert = !!at && DESSERT_DISH.test(at.dish.title) && at.i > (lastOven.get(e.dishId) ?? -1);
    return { e, at, dessert, start: e.startOffsetMinutes + total, minutes: at?.step.estimatedMinutes ?? 0 };
  });
  const main = rows.filter((r) => !r.dessert);
  const serve = main.find((r) => FEAST_SERVE_STEP.test(r.at?.step.text ?? ""));
  const dessert = rows.filter((r) => r.dessert);
  if (!serve && dessert.length === 0) return res;
  if (serve) serve.start = Math.max(0, ...main.filter((r) => r !== serve).map((r) => r.start + r.minutes));
  const end = Math.max(...main.map((r) => r.start + r.minutes));
  let t = end;
  for (const r of dessert.sort((a, b) => (a.at?.pos ?? 0) - (b.at?.pos ?? 0) || (a.at?.i ?? 0) - (b.at?.i ?? 0))) {
    r.start = t;
    t += r.minutes;
  }
  const ordered = [...main, ...dessert].sort((a, b) => a.start - b.start || Number(a.dessert) - Number(b.dessert) || a.e.sequenceIndex - b.e.sequenceIndex);
  return {
    ...res,
    steps: ordered.map((r, i) => ({ ...r.e, sequenceIndex: i, startOffsetMinutes: Math.round(r.start - end) })),
    totalEstimatedMinutes: Math.round(end),
  };
}

function scheduleCookingSequenceCore(
  dishes: SchedulerDish[],
  opts: ScheduleOptions = {},
): ScheduleResult {
  // D-WS9-297 ruling 1 — the bound is ON for every production caller. The flag
  // exists so a measurement script can price it (which meals grow, and by how
  // much) and so the §BREAK test can remove it without editing this file.
  const enforceMaxLag = opts.enforceMaxLag ?? true;
  // THX-3d (R4) — not in a feast: the cranberry sauce goes out with everything else,
  // never at the start (its serving is the feast's one serve step).
  const coldDishesForward = opts.coldDishesForward ?? !opts.feastOven;
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

  // THX-3c (BUG-463) — a feast's oven: one preheat per temperature, then one
  // temperature at a time (see `mergeFeastPreheats` / `planOvenBlocks`).
  let feast: FeastOven | null = null;
  let heldDropped: { dishId: string; stepIndex: number }[] = [];
  if (opts.feastOven) {
    const merged = mergeFeastPreheats(nonEmpty);
    nonEmpty.splice(0, nonEmpty.length, ...merged.dishes);
    feast = { blocks: null, heatedBy: merged.heatedBy };
    // THX-3d round 5 (D-WS9-322) — which held sides hold today (see heldSidesToday).
    const held = heldSidesToday(nonEmpty);
    nonEmpty.splice(0, nonEmpty.length, ...held.dishes);
    heldDropped = held.dropped;
    feast.pre = held.pre;
    feast.mainLast = held.mainLast;
  }
  const anyTag = nonEmpty.some((d) => d.steps.some((s) => rawToken(s) !== null));
  const oven = opts.feastOven ? planOven(nonEmpty) : null;
  if (feast && !oven) {
    const bird = feastRoastDish(nonEmpty);
    feast.bird = bird;
    feast.blocks = planOvenBlocks(nonEmpty, bird?.dishId ?? null);
  }
  const blocks = feast;
  // THX-3d round 5 — a held side's hold and reheat not needed today are merged away too.
  const withHeld = (r: ScheduleResult): ScheduleResult => (heldDropped.length > 0 ? { ...r, mergedSteps: [...(r.mergedSteps ?? []), ...heldDropped] } : r);
  const untagged = withHeld(scheduleArm(nonEmpty, false, enforceMaxLag, coldDishesForward, oven, blocks));
  if (!anyTag) return untagged; // byte-identical to the pre-D-WS9-239 path

  const tagged = withHeld(scheduleArm(nonEmpty, true, enforceMaxLag, coldDishesForward, oven, blocks));
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

/**
 * WS9 BUG-337 / D-WS9-297 ruling 3 — one arm of the tag guard, with the cold
 * dishes moved into a passive window.
 *
 * ── WHY THIS IS TWO PASSES AND NOT A BASE OF ZERO ──────────────────────────
 *
 * 🔴 THE FIRST IMPLEMENTATION SET A COLD DISH'S BASE TO 0 ("as early as the
 * hands allow") AND MADE THE METRIC WORSE. Measured on the 54-meal corpus: idle
 * window minutes went 2,137 → 2,206, and 14 of the 16 meals it touched got
 * LONGER (a Tortellini + Caesar meal 37 → 45, +21.6%). The reason is that base 0
 * does not put the salad in a window — it puts the salad FIRST, ahead of the
 * point where any window opens, so the hot dishes start later and the whole meal
 * slides. The ruling says "pulled into the nearest passive window ≥ 10 min", and
 * that is a different instruction from "pulled to the front".
 *
 * A window's position is not known until the hot dishes have been placed, so:
 *   pass 1  schedule with every dish finish-aligned — this DISCOVERS the windows
 *   pass 2  re-schedule with each cold dish based at the earliest window that is
 *           actually earlier than where finish-alignment had put it
 * and the shorter total wins, exactly as rule 6 does for tags. That makes ruling
 * 3 free by construction rather than by luck: a cold dish whose window never
 * opens, or whose move would cost minutes, simply stays where it was.
 */
// ── THX-3 (BUG-449) — A FEAST'S OVEN ────────────────────────────────────────
//
// Hans, October 19: "the step to put it in the oven comes after the turkey has
// rested and is on the table." That order was the client's dish-by-dish fallback
// (his dev plan held the catalog meal itself, which the sequencer 404s), but
// measured on the real path the scheduler was wrong the other way: it has no oven
// at all, so Classic's stuffing went in at 350°F seven minutes before the 325°F
// bird came out, and Make-Ahead's two casseroles preheated to 350°F and 375°F
// twenty-seven minutes before it did.
//
// The rule (THX-3): THE OVEN FREES WHEN THE BIRD COMES OUT. A dish that needs the
// oven starts then — during the rest — and lands at serving time; the rest, the
// carve and the pan sauce never hold the oven. Feasts only (ruled October 20).
//
//   • The HOLDER is the dish with the longest single oven `cook` step, and only
//     when that step is a real roast (≥ OVEN_HOLD_MIN). A vegetarian feast's
//     45-minute stuffing does not lock out its Wellington.
//   • An OVEN STEP is a preheat, cook or prep step whose prose puts it in the oven
//     ("oven", "bake", "roast at" — not a "roasting pan" on burners, not a "baking
//     dish" to serve from).
//   • Pass 1 schedules with the floor. The sides now finish later than the bird
//     did, so pass 2 serves at pass 1's serve time: every dish finish-aligns to it
//     (the gravy, the potatoes), except the bird, whose start is pinned (its roast
//     ends where it did) and whose tail after the rest — the carve — is aligned to
//     serve. The bird rests longer; nothing waits on a cold platter.
// (THX-3d 3b — "the roasted turkey" is a noun phrase, not the oven: production's
// Make-Ahead gravy, "Stir in any pan drippings from the roasted turkey", held the oven
// after the bird and was given "Turn the oven off and leave the sides inside".)
const OVEN_WORDS = /\b(?:oven|bake[sd]?)\b|\bbaking\b(?!\s+(?:dish|sheet|pan|powder|soda))|\broast(?:s|ing)?\b(?!\s*pan)(?!ing\s+pan)|(?<!\b(?:the|any|from)\s)\broasted\b(?!\s*pan)/i;

export interface OvenPlan {
  holderDishId: string;
  /** The holder's last oven step (array index): the oven frees when it finishes. */
  holderLastOven: number;
  /** The holder's first step after its post-oven rest, aligned to serve in pass 2. */
  tailFrom: number;
  /**
   * THX-3d (R4) — the holder step after which the other dishes' oven steps may start:
   * the code-written "Raise the oven to 350°F and put in …" while the bird still
   * roasts, else the bird's last oven step (it comes out).
   */
  freesAt: number;
  /** dishId → array indexes of its oven steps (holder included). */
  ovenSteps: Map<string, Set<number>>;
}

interface OvenRun {
  plan: OvenPlan;
  /** Pass 2: the serve time every non-holder dish finish-aligns to. */
  anchor?: number;
  /** Pass 2: the holder's base from pass 1. */
  holderBase?: number;
  /**
   * THX-3d (R4) — pass 2: the bases of the sides the raise step puts in the oven, so
   * their first oven step starts as the raise finishes (they finish before the bird's
   * rest ends, as the raise was timed to), not finish-aligned to serve.
   */
  sideBases?: Map<string, number>;
  /** THX-3d round 2 (I) — a named side's steps before its first bake end before the raise starts (the pecan topping, the panko). */
  sidePre?: Map<string, { firstOven: number; lead: number }>;
  /**
   * THX-3d round 4 (BUG-496) — pass 2: the earliest each side the raise does not name can
   * go in, by the racks (placeInRacks). Its steps before it follow it (the smashed
   * potatoes are smashed as they go in, not 45 minutes before).
   */
  floors?: Map<string, number>;
}

/** True when a step puts food in (or heats) the oven, by its phase and prose. */
export function isOvenStep(step: Pick<SchedulerStep, "phaseType" | "text">): boolean {
  if (step.phaseType !== "preheat" && step.phaseType !== "cook" && step.phaseType !== "prep") return false;
  return OVEN_WORDS.test(step.text ?? "");
}

// ── THX-3d (R4) — THE HOLDER IS THE MAIN ROAST, BY KIND ──────────────────────
//
// THX-3 picked the holder by minutes (a single oven `cook` step of 90 or more), and
// New Twist's spatchcock turkey roasts 85: nothing held its oven, the stuffing went in
// first and was served two and a half hours before the meal, and the gravy was made
// from "the roasting pan" while the bird was still in it. Production's Small split its
// breast's roast into 40 + 70 minutes, and no single step reached 90. So the holder is
// the dish that IS the roast — a bird, a ham, a rib or tenderloin, by its title — with
// an oven cook step on the day; of several, the one with the most oven minutes.
const ROAST_DISH = /\b(turkey|chickens?|ducks?|goose|hens?|capon|ham|prime rib|tenderloin)\b/i;
const NOT_A_ROAST = /\b(gravy|stock|broth|stuffing|dressing|soup|sandwich(?:es)?|pot pie|salad|enchiladas?|casserole|chili)\b/i;
/** THX-3d (R4) — a side this much cooler than the bird cannot bake in its oven as it comes out (thx2Oven MAX_SHIFT_F). */
export const BIRD_HOTTER_F = 25;
/** THX-3d (R4) — a step that works from the bird's pan: it waits until the bird is out. */
export const DRIPPINGS = /\b(drippings|roasting pan|pan juices)\b/i;
/**
 * THX-3d (R4) — the code-written raise step: "Raise the oven to 350°F and put in …".
 * THX-3d round 3 (T) — or, at the bird's own temperature, "Put the … in the oven with
 * the turkey." (New Twist at 400°F): the sides go in while the bird roasts either way.
 */
export const RAISE_AND_PUT_IN = /^\s*(?:Raise the oven to \d{3}\s*°\s*F and put in\b|Put the .+ in the oven with the \w)/i;

// ── THX-3d round 4 (BUG-496) — TWO RACKS ─────────────────────────────────────
//
// A home oven has two racks: the bird's pan takes one, and the other holds one sheet pan
// or two 9×13s (ovenRacks.ts says what each dish takes). At every instant the dishes in
// the oven take no more than OVEN_RACKS. What does not fit waits: the raise names only
// the sides that fit beside the bird, and says which go in when the bird comes out ("…
// and put in the Sage and Onion Stuffing and Green Bean Casserole; the Sweet Potato
// Casserole goes in when the turkey comes out." — thx2Thursday); any other side goes in
// when there is room (placeInRacks, then the pass's own check). A held side's reheat
// waits for room too.
export const OVEN_RACKS = 2;
/** The bird's roasting pan (or sheet pan): a rack of its own. */
export const BIRD_RACKS = 1;
/** A dish whose vessel no step names. */
const UNKNOWN_RACKS = 0.5;

/** THX-3d round 4 — the raise step's put-in list: the words before its "; the … goes in when …". */
export function raiseHead(text: string): string {
  const i = text.indexOf(";");
  return i < 0 ? text : text.slice(0, i);
}
/** THX-3d round 4 (A3) — the sides the raise step says go in when the bird comes out. */
const WAITS_FOR_BIRD = /;\s*(.+?)\s+go(?:es)? in when the [\w ]+? comes out\b/i;
export function raiseWaits(text: string): string {
  return WAITS_FOR_BIRD.exec(text)?.[1] ?? "";
}

/** A stretch of the oven in use: [from, to) taking `racks`. */
export interface RackUse { from: number; to: number; racks: number }

/** The most racks in use at any instant of [from, to). */
export function racksInUse(uses: readonly RackUse[], from: number, to: number): number {
  const live = uses.filter((u) => u.from < to && from < u.to);
  const points = [from, ...live.map((u) => u.from).filter((t) => t > from && t < to)];
  return Math.max(0, ...points.map((t) => live.filter((u) => u.from <= t && t < u.to).reduce((n, u) => n + u.racks, 0)));
}

/** The earliest start at or after `t` where `racks` fit beside `uses` for `minutes`. */
export function rackFloor(uses: readonly RackUse[], t: number, minutes: number, racks: number, capacity = OVEN_RACKS): number {
  const need = Math.min(racks, capacity);
  const candidates = [t, ...uses.map((u) => u.to).filter((x) => x > t)].sort((a, b) => a - b);
  for (const c of candidates) if (racksInUse(uses, c, c + Math.max(1, minutes)) + need <= capacity + 1e-9) return c;
  return candidates[candidates.length - 1];
}

/** One dish (or reheat) to place: its racks, its minutes in the oven, its earliest start. */
export interface RackItem { id: string; racks: number; minutes: number; earliest: number }

/** Each item, in the order given, at the earliest start where it fits beside what is already in. */
export function placeInRacks(items: readonly RackItem[], inUse: readonly RackUse[], capacity = OVEN_RACKS): Map<string, number> {
  const uses = [...inUse];
  const out = new Map<string, number>();
  for (const it of items) {
    const t = rackFloor(uses, it.earliest, it.minutes, it.racks, capacity);
    out.set(it.id, t);
    uses.push({ from: t, to: t + it.minutes, racks: Math.min(it.racks, capacity) });
  }
  return out;
}

/**
 * A dish's stays in the oven, as array-index ranges: each run of consecutive oven steps
 * (a preheat is not in the oven; a reheat starts a stay of its own). The bird's is one:
 * from its first roast to its last oven step.
 */
export function ovenStays(dish: Pick<SchedulerDish, "steps">, bird: { lastOven: number } | null = null): { from: number; to: number }[] {
  const inOven = (s: SchedulerStep) => s.phaseType !== "preheat" && isOvenStep(s);
  if (bird) {
    const first = dish.steps.findIndex((s, i) => i <= bird.lastOven && s.phaseType === "cook" && isOvenStep(s));
    return first < 0 ? [] : [{ from: first, to: bird.lastOven }];
  }
  const out: { from: number; to: number }[] = [];
  dish.steps.forEach((s, i) => {
    if (!inOven(s)) return;
    const last = out[out.length - 1];
    if (last && last.to === i - 1 && !isReheatStep(s)) last.to = i;
    else out.push({ from: i, to: i });
  });
  return out;
}

/** The racks a dish takes: the bird's pan one, else what its vessel says. */
export function dishRacks(dish: Pick<SchedulerDish, "ovenRacks">, isBird: boolean): number {
  return isBird ? BIRD_RACKS : dish.ovenRacks ?? UNKNOWN_RACKS;
}

// ── THX-3d round 5 (D-WS9-322, chat-Claude's ruling) — HOLD THE FORGIVING THING ─────
//
// "A cook can hold a casserole or a pan of roasted vegetables under foil for an hour and
// nobody notices; a carved turkey waiting 56 minutes is cold, and a Wellington 40 minutes
// early is soft." Round 4 sent what did not fit after the bird, in a row (New Twist at its
// own 10 servings: two 2-pan sides one after another, the carved bird tented 56 minutes).
// Now what does not fit the rest window beside the sides that keep it bakes BEFORE the
// bird goes in, is held, and returns for 10 minutes while the bird rests; and in blocks,
// the main dish finishes last — the sprouts that cannot share its oven bake before it,
// held and reheated. The content writes those two steps (cover, return for 10 minutes)
// wherever the meal's own servings need them (thx2Thursday, thx2Oven heldDishSteps); a
// smaller household's pans may fit together, so the day decides here: a held side that
// fits beside the others has its two steps merged away and goes in with them.

/** A dish's code-written hold and reheat (array indexes), or null. */
export function heldStepsOf(dish: Pick<SchedulerDish, "steps">): { hold: number; reheat: number } | null {
  const hold = dish.steps.findIndex((s) => HOLD_COVERED_STEP.test((s.text ?? "").trim()));
  if (hold < 0) return null;
  const reheat = dish.steps.findIndex((s, i) => i > hold && isReheatStep(s));
  return reheat < 0 ? null : { hold, reheat };
}

/** The dishes as today's racks hold them: held steps dropped where the side fits with the others. */
export function heldSidesToday(dishes: readonly SchedulerDish[]): {
  dishes: SchedulerDish[];
  dropped: { dishId: string; stepIndex: number }[];
  pre: Set<string>;
  mainLast: { main: string; before: Set<string> } | null;
} {
  const pre = new Set<string>();
  const drop = new Set<string>();
  let mainLast: { main: string; before: Set<string> } | null = null;
  const plan = planOven(dishes);
  const fits = (racks: number, free: number) => racks <= free + 1e-9;
  if (plan) {
    const holder = dishes.find((d) => d.dishId === plan.holderDishId)!;
    const raise = holder.steps[plan.freesAt]?.text ?? "";
    const head = RAISE_AND_PUT_IN.test(raise) ? raiseHead(raise) : "";
    const waits = raiseWaits(raise);
    const sides = dishes.filter((d) => d.dishId !== holder.dishId && ovenStays(d).length > 0);
    // In the oven as the bird comes out: the raise's sides that are not held (they finish
    // as the rest ends), and the sides the raise says go in then.
    const stillIn = sides.filter((d) => head.includes(d.title) && !heldStepsOf(d)).reduce((n, d) => n + dishRacks(d, false), 0);
    let free = OVEN_RACKS - stillIn - sides.filter((d) => waits !== "" && waits.includes(d.title)).reduce((n, d) => n + dishRacks(d, false), 0);
    const held = sides.filter((d) => !head.includes(d.title) && heldStepsOf(d));
    const run = (d: SchedulerDish) => { const st = ovenStays(d)[0]; return d.steps.slice(st.from, st.to + 1).reduce((n, x) => n + x.estimatedMinutes, 0); };
    for (const d of [...held].sort((a, b) => run(a) - run(b) || a.positionIndex - b.positionIndex)) {
      if (fits(dishRacks(d, false), free)) { free -= dishRacks(d, false); drop.add(d.dishId); }
      else pre.add(d.dishId);
    }
  } else {
    const bird = feastRoastDish(dishes);
    const blocks = planOvenBlocks(dishes, bird?.dishId ?? null);
    if (blocks) {
      const last = Math.max(...blocks.blockOf.values());
      const inLast = dishes.filter((d) => blocks.blockOf.get(d.dishId) === last);
      const main = inLast.find((d) => /\bmain\b/i.test(d.roleLabel ?? ""));
      const held = inLast.filter((d) => d !== main && heldStepsOf(d));
      if (main && held.length > 0) {
        const all = inLast.reduce((n, d) => n + dishRacks(d, d.dishId === bird?.dishId), 0);
        if (fits(all, OVEN_RACKS)) for (const d of held) drop.add(d.dishId);
        else mainLast = { main: main.dishId, before: new Set(held.map((d) => d.dishId)) };
      }
    }
  }
  const dropped: { dishId: string; stepIndex: number }[] = [];
  const out = dishes.map((d) => {
    if (!drop.has(d.dishId)) return d;
    const h = heldStepsOf(d)!;
    dropped.push({ dishId: d.dishId, stepIndex: d.steps[h.hold].stepIndex }, { dishId: d.dishId, stepIndex: d.steps[h.reheat].stepIndex });
    return { ...d, steps: d.steps.filter((_, i) => i !== h.hold && i !== h.reheat) };
  });
  return { dishes: out, dropped, pre, mainLast };
}

/** The LAST oven temperature a step names (250–550°F): "425°F … then reduce the oven to 325°F" is 325. */
export function lastOvenTempOfText(text: string | null | undefined): number | null {
  let out: number | null = null;
  for (const m of (text ?? "").matchAll(/(\d{3})\s*°\s*F/g)) {
    const t = Number(m[1]);
    if (t >= 250 && t <= 550) out = t;
  }
  return out;
}

/** The dish that is the feast's main roast, by kind (see ROAST_DISH), or null. */
export function feastRoastDish(dishes: readonly SchedulerDish[]): { dishId: string; lastOven: number } | null {
  let best: { dishId: string; lastOven: number; minutes: number } | null = null;
  for (const d of dishes) {
    if (!ROAST_DISH.test(d.title) || NOT_A_ROAST.test(d.title)) continue;
    let minutes = 0;
    let lastOven = -1;
    d.steps.forEach((s, i) => {
      if (!isOvenStep(s)) return;
      lastOven = i;
      if (s.phaseType === "cook") minutes += s.estimatedMinutes;
    });
    if (minutes === 0) continue;
    if (!best || minutes > best.minutes) best = { dishId: d.dishId, lastOven, minutes };
  }
  return best ? { dishId: best.dishId, lastOven: best.lastOven } : null;
}

/**
 * The feast's oven, or null when no dish is the roast — or when the roast ends more than
 * BIRD_HOTTER_F hotter than a side's oven step (New Twist: the spatchcock at 425°F, the stuffing at 350°F):
 * then the oven runs temperature blocks (planOvenBlocks), the bird's last, and the
 * sides bake first, held covered and returned to its oven while it rests.
 */
export function planOven(dishes: readonly SchedulerDish[]): OvenPlan | null {
  const roast = feastRoastDish(dishes);
  if (!roast) return null;
  const ovenSteps = new Map<string, Set<number>>();
  for (const d of dishes) {
    const set = new Set<number>();
    d.steps.forEach((s, i) => { if (isOvenStep(s)) set.add(i); });
    if (set.size > 0) ovenSteps.set(d.dishId, set);
  }
  const hd = dishes.find((d) => d.dishId === roast.dishId)!;
  const birdTemp = [...ovenSteps.get(hd.dishId)!].map((i) => lastOvenTempOfText(hd.steps[i].text)).filter((t): t is number => t !== null).pop() ?? null;
  if (birdTemp !== null) {
    for (const d of dishes) {
      if (d.dishId === hd.dishId) continue;
      for (const i of ovenSteps.get(d.dishId) ?? []) {
        const t = ovenTempOfText(d.steps[i].text);
        if (t !== null && t < birdTemp - BIRD_HOTTER_F && !isReheatStep(d.steps[i])) return null;
      }
    }
  }
  const lastOven = roast.lastOven;
  const rest = hd.steps.findIndex((s, i) => i > lastOven && s.phaseType === "rest");
  const raise = hd.steps.findIndex((s, i) => i < lastOven && RAISE_AND_PUT_IN.test(s.text ?? ""));
  return {
    holderDishId: hd.dishId,
    holderLastOven: lastOven,
    tailFrom: rest >= 0 && rest + 1 < hd.steps.length ? rest + 1 : Infinity,
    ovenSteps,
    freesAt: raise >= 0 ? raise : lastOven,
  };
}

// ── THX-3c (BUG-463) — ONE OVEN, ONE TEMPERATURE AT A TIME ───────────────────
//
// The Vegetarian feast has no bird to hold the oven, so nothing ordered it: its
// Wellington (425°F), stuffing and mac and cheese (375°F) and sprouts (425°F) were
// all in the oven at once, at two temperatures. Make-Ahead preheated the same oven
// to 350°F twice, a minute apart. The rule (Hans's, via THX-3c):
//
//   • ONE PREHEAT PER TEMPERATURE. A step that does nothing but preheat ("On
//     Thursday: Preheat the oven to 375°F.") is dropped when another dish's step
//     preheats to the same temperature; a preheat that also does work (Mac and
//     Cheese's "Preheat… Mix the panko…") is the one kept. A dish that lost its
//     preheat puts nothing in the oven before the kept one has run.
//   • ONE TEMPERATURE AT A TIME (no bird to hold the oven). The oven dishes are
//     grouped by temperature. Groups of dishes that HOLD WELL COVERED (stuffing,
//     casseroles, mac and cheese) bake first; a group with a dish best STRAIGHT FROM
//     THE OVEN (pastry, a Wellington, roasted vegetables) bakes last, at its own
//     temperature. Each earlier group finishes its oven work before the next group's
//     first oven step — its preheat, the temperature change — begins.
//   With a bird, the sides after it already share one temperature (THX-3b, in the
//   content), and only the preheat rule applies.

/** An oven temperature a step names (250–550°F); an internal temperature (165°F) is not one. */
export function ovenTempOfText(text: string | null | undefined): number | null {
  for (const m of (text ?? "").matchAll(/(\d{3})\s*°\s*F/g)) {
    const t = Number(m[1]);
    if (t >= 250 && t <= 550) return t;
  }
  return null;
}

/** A step that does nothing but preheat: "On Thursday: Preheat the oven to 375°F." */
const PURE_PREHEAT = /^\s*(?:On [A-Za-z]+day:\s*)?(?:Pre)?heat (?:the )?oven to \d{3}\s*°\s*F\.?\s*$/i;
/** A dish best straight from the oven: pastry, a Wellington, roasted vegetables. */
const SERVE_HOT = /\b(wellington|pastry|pot pie|biscuits?|popovers?|souffl[eé]|roast(?:ed)?\s+(?!turkey|chicken|beef|pork|lamb|duck))/i;

export interface OvenBlocks {
  /** dishId → its block (0 = first in the oven); absent for a dish outside the blocks. */
  blockOf: Map<string, number>;
  /** dishId → array indexes of its oven steps (the code-written reheat excluded). */
  ovenSteps: Map<string, Set<number>>;
  /** dishId → array index of its code-written reheat, aligned to serve. */
  reheatOf: Map<string, number>;
}

// ── THX-3c (BUG-463, chat-Claude's ruling) — THE HELD DISHES, COVERED AND REHEATED ──
//
// A dish that bakes in an earlier block comes out as the oven changes temperature
// and waits for the rest of the meal. Two steps, WRITTEN IN CODE (scripts/thx2
// patch.ts, never AI), follow its last oven step: cover it with foil to keep it warm,
// and — while the last oven dish rests — return it, uncovered, to the hot oven for
// 10 minutes, landing at serving time. The reheat is recognised by its own words.
export const REHEAT_MINUTES = 10;
/** How far ahead of everything else a block change's own run is sorted (minutes). */
const PRIORITY_LEAD = 10_000;
// THX-3d round 2 (K) — "Return the Herb Stuffing, uncovered, …" now; THX-3c wrote "Return it".
const REHEAT_STEP = /\breturn (?:it|the .+?),? uncovered,? to the \d{3}\s*°\s*F oven for \d+ minutes\b/i;

/** The code-written hold step's text. THX-3d round 2 (O) — "while the oven heats" only
 *  when the oven's temperature changes next (New Twist's stuffing came out at 350°F with
 *  the potatoes still baking at 350°F). */
export function holdCoveredText(dishTitle: string, ovenChangesNext = true): string {
  // THX-3d round 3 (U) — the pronoun agrees with the name: "the Smashed Potatoes … them".
  const head = dishTitle.trim().split(/\s+/).pop() ?? "";
  const them = /s$/i.test(head) && !/(?:ss|us|is)$/i.test(head);
  return `Cover the ${dishTitle} with foil to keep ${them ? "them" : "it"} warm${ovenChangesNext ? " while the oven heats for the next dish" : ""}.`;
}
/** A code-written hold step, either wording. */
export const HOLD_COVERED_STEP = /^Cover the (.+?) with foil to keep (?:it|them) warm(?: while the oven heats for the next dish)?\.$/;

/** The code-written reheat step's text, at the last block's temperature. */
export function reheatText(dishTitle: string, tempF: number): string {
  // THX-3d round 2 (K) — the step names its dish: Cook Mode shows another dish's step before it.
  return `Return the ${dishTitle}, uncovered, to the ${tempF}°F oven for ${REHEAT_MINUTES} minutes, until hot again.`;
  // THX-3d (R4) — no "; serve": the feast serves once, in its one serve step.
}

/** True for the code-written reheat step. */
export function isReheatStep(step: Pick<SchedulerStep, "text">): boolean {
  return REHEAT_STEP.test(step.text ?? "");
}

/** What the single-cook pass needs about a feast's oven beyond the bird. */
export interface FeastOven {
  blocks: OvenBlocks | null;
  /** THX-3d (R4) — the roast in a blocks-mode feast (a bird hotter than its sides): its drippings gate the gravy. */
  bird?: { dishId: string; lastOven: number } | null;
  /** dishId → the kept preheat (another dish's step) its oven steps wait for. */
  heatedBy: Map<string, { dishId: string; stepIndex: number }>;
  /** THX-3d round 5 (D-WS9-322) — beside a bird: the held sides that bake before it goes in. */
  pre?: Set<string>;
  /** THX-3d round 5 (D-WS9-322) — in blocks: the main dish, and the held dishes of its block that bake before it. */
  mainLast?: { main: string; before: Set<string> } | null;
}

/**
 * One preheat per temperature: the dishes with every redundant pure-preheat step
 * dropped. The kept step is the first preheat that also does work, else the first.
 */
export function mergeFeastPreheats(dishes: readonly SchedulerDish[]): { dishes: SchedulerDish[]; heatedBy: FeastOven["heatedBy"] } {
  const byTemp = new Map<number, { dishId: string; stepIndex: number; pure: boolean }[]>();
  for (const d of dishes) {
    for (const s of d.steps) {
      if (s.phaseType !== "preheat" || !isOvenStep(s)) continue;
      const t = ovenTempOfText(s.text);
      if (t === null) continue;
      byTemp.set(t, [...(byTemp.get(t) ?? []), { dishId: d.dishId, stepIndex: s.stepIndex, pure: PURE_PREHEAT.test(s.text ?? "") }]);
    }
  }
  const drop = new Set<string>();
  const heatedBy: FeastOven["heatedBy"] = new Map();
  for (const list of byTemp.values()) {
    if (list.length < 2) continue;
    const kept = list.find((x) => !x.pure) ?? list[0];
    for (const x of list) {
      if (x === kept || !x.pure) continue;
      drop.add(`${x.dishId}#${x.stepIndex}`);
      if (x.dishId !== kept.dishId) heatedBy.set(x.dishId, { dishId: kept.dishId, stepIndex: kept.stepIndex });
    }
  }
  // THX-3d round 2 (I) — a dish with no preheat of its own at its temperature waits for
  // the oven's: New Twist's stuffing went into a cold oven at T−219, the potatoes'
  // 350°F preheat (the only one) ran at T−209.
  for (const d of dishes) {
    if (heatedBy.has(d.dishId)) continue;
    const own = new Set(d.steps.filter((s) => s.phaseType === "preheat").map((s) => ovenTempOfText(s.text)));
    const t = d.steps.filter((s) => s.phaseType !== "preheat" && isOvenStep(s) && !isReheatStep(s)).map((s) => ovenTempOfText(s.text)).find((x): x is number => x !== null);
    if (t === undefined || own.has(t)) continue;
    const kept = (byTemp.get(t) ?? []).find((x) => x.dishId !== d.dishId && !drop.has(`${x.dishId}#${x.stepIndex}`));
    if (kept) heatedBy.set(d.dishId, { dishId: kept.dishId, stepIndex: kept.stepIndex });
  }
  if (drop.size === 0) return { dishes: [...dishes], heatedBy };
  return { dishes: dishes.map((d) => ({ ...d, steps: d.steps.filter((s) => !drop.has(`${d.dishId}#${s.stepIndex}`)) })), heatedBy };
}

/** The oven blocks of a feast with no bird to hold its oven, or null when one temperature serves. */
export function planOvenBlocks(dishes: readonly SchedulerDish[], birdDishId: string | null = null): OvenBlocks | null {
  const ovenSteps = new Map<string, Set<number>>();
  const tempOf = new Map<string, number>();
  const reheatOf = new Map<string, number>();
  for (const d of dishes) {
    const set = new Set<number>();
    d.steps.forEach((s, i) => {
      if (isReheatStep(s)) { reheatOf.set(d.dishId, i); return; }
      if (!isOvenStep(s)) return;
      set.add(i);
      const t = ovenTempOfText(s.text);
      if (t !== null && !tempOf.has(d.dishId)) tempOf.set(d.dishId, t);
    });
    if (set.size > 0) ovenSteps.set(d.dishId, set);
  }
  const temps = [...new Set(tempOf.values())];
  if (temps.length < 2) return null;
  // THX-3d (R4) — a bird hotter than its sides is served straight from its oven: its block is last.
  const hot = (t: number) => dishes.some((d) => tempOf.get(d.dishId) === t && (d.dishId === birdDishId || SERVE_HOT.test(d.title) || d.steps.some((s) => /\bpuff pastry\b/i.test(s.text ?? ""))));
  // Hold-well groups first, then the straight-from-the-oven ones; cooler first within each.
  const order = [...temps].sort((a, b) => Number(hot(a)) - Number(hot(b)) || a - b);
  const blockOf = new Map<string, number>();
  for (const [id, t] of tempOf) blockOf.set(id, order.indexOf(t));
  return { blockOf, ovenSteps, reheatOf };
}

/**
 * The bases that sequence the blocks: the last block finish-aligns to serve, and each
 * earlier block's dishes end their last oven step where the next block's first oven
 * step begins (computed on the dish-alone walks, latest block first).
 */
function ovenBlockBases(
  dishes: readonly SchedulerDish[],
  alone: readonly { duration: number; offsets: number[] }[],
  anchor: number,
  blocks: OvenBlocks,
): Map<string, number> {
  const bases = new Map<string, number>();
  const last = Math.max(...blocks.blockOf.values());
  let nextOvenStart = Infinity;
  for (let b = last; b >= 0; b--) {
    let start = Infinity;
    dishes.forEach((d, i) => {
      if (blocks.blockOf.get(d.dishId) !== b) return;
      const ov = [...(blocks.ovenSteps.get(d.dishId) ?? [])];
      if (ov.length === 0) return;
      const lastIdx = Math.max(...ov);
      const endOfOven = alone[i].offsets[lastIdx] + d.steps[lastIdx].estimatedMinutes;
      const aligned = anchor - alone[i].duration;
      const base = Number.isFinite(nextOvenStart) ? Math.min(aligned, nextOvenStart - endOfOven) : aligned;
      bases.set(d.dishId, base);
      start = Math.min(start, base + alone[i].offsets[Math.min(...ov)]);
    });
    if (Number.isFinite(start)) nextOvenStart = start;
  }
  return bases;
}

function scheduleWithOven(
  nonEmpty: SchedulerDish[],
  honourTags: boolean,
  enforceMaxLag: boolean,
  coldBases: ReadonlyMap<string, number> | null,
  plan: OvenPlan,
  feast: FeastOven | null = null,
): ScheduleResult {
  const first = scheduleOnceCore(nonEmpty, honourTags, enforceMaxLag, coldBases, { plan }, feast);
  // The holder's base in pass 1: its first step's start, in the cook-start frame.
  const holder = nonEmpty.find((d) => d.dishId === plan.holderDishId)!;
  const hd = first.steps.filter((s) => s.dishId === plan.holderDishId);
  const holderStart = Math.min(...hd.map((s) => s.startOffsetMinutes)) + first.totalEstimatedMinutes;
  const walked = walkDishAlone(holder, classifyDish(holder, honourTags, []));
  // THX-3d round 5 — with a side baking before the bird, its base is read off its roast:
  // its steps before the roast run that much earlier (scheduleOnceCore), its roast does not.
  const firstRoastIdx = holder.steps.findIndex((s) => s.phaseType === "cook" && isOvenStep(s));
  const roastEntry = firstRoastIdx >= 0 ? hd.find((s) => s.originalStepIndex === holder.steps[firstRoastIdx].stepIndex) : undefined;
  const holderBase = feast?.pre?.size && roastEntry ? roastEntry.startOffsetMinutes + first.totalEstimatedMinutes - walked.offsets[firstRoastIdx] : holderStart - walked.offsets[0];
  // When the oven frees, in that frame: the holder's last oven step's finish.
  const lastOven = hd.find((s) => s.originalStepIndex === holder.steps[plan.holderLastOven].stepIndex)!;
  const ovenOut = lastOven.startOffsetMinutes + first.totalEstimatedMinutes + holder.steps[plan.holderLastOven].estimatedMinutes;
  // Serve = the oven freeing, plus the longest thing still to happen after it: a
  // side's run from its first oven step to its end, or the bird's own rest and carve.
  // (Not pass 1's serve time: its single-cook pass had already pushed serve late,
  // and aligning to it left the stuffing ten minutes idle after the bird was out.)
  const holderTail = holder.steps.slice(plan.holderLastOven + 1).reduce((s, x) => s + x.estimatedMinutes, 0);
  // THX-3d (R4) — with a raise step the sides go in while the bird still roasts: their
  // run counts from the raise's finish, which is before the bird comes out.
  const raised = hd.find((s) => s.originalStepIndex === holder.steps[plan.freesAt].stepIndex)!;
  const freeAt = raised.startOffsetMinutes + first.totalEstimatedMinutes + holder.steps[plan.freesAt].estimatedMinutes;
  // THX-3d (R4) — the sides the raise step names go in as it finishes.
  // THX-3d round 4 — named in its put-in list, not in its "; the … goes in when the turkey comes out".
  const raiseText = holder.steps[plan.freesAt]?.text ?? "";
  const sideBases = new Map<string, number>();
  const sidePre = new Map<string, { firstOven: number; lead: number }>();
  if (RAISE_AND_PUT_IN.test(raiseText)) {
    for (const d of nonEmpty) {
      const ov = plan.ovenSteps.get(d.dishId);
      if (d.dishId === plan.holderDishId || !ov || ov.size === 0 || !raiseHead(raiseText).includes(d.title)) continue;
      const w = walkDishAlone(d, classifyDish(d, honourTags, []));
      const firstOven = Math.min(...[...ov].filter((i) => d.steps[i].phaseType !== "preheat"));
      if (Number.isFinite(firstOven)) {
        sideBases.set(d.dishId, freeAt - w.offsets[firstOven]);
        sidePre.set(d.dishId, { firstOven, lead: holder.steps[plan.freesAt].estimatedMinutes });
      }
    }
  }
  // THX-3d round 4 (BUG-496) — THE RACKS. Beside the bird one rack is free; the sides the
  // raise names take it as it finishes. Every other side goes in at the earliest moment
  // there is room for its pans (after the raise; after the bird is out when the raise says
  // so or its run fits the rest), the longest first.
  const waits = raiseWaits(raiseText);
  const restStep = holder.steps.find((s, i) => i > plan.holderLastOven && s.phaseType === "rest");
  const uses: RackUse[] = [{ from: -Infinity, to: ovenOut, racks: BIRD_RACKS }];
  const items: (RackItem & { tail: number; pos: number })[] = [];
  for (const d of nonEmpty) {
    if (d.dishId === plan.holderDishId || feast?.pre?.has(d.dishId)) continue;
    const stay = ovenStays(d)[0];
    if (!stay) continue;
    const w = walkDishAlone(d, classifyDish(d, honourTags, []));
    const minutes = d.steps.slice(stay.from, stay.to + 1).reduce((n, x) => n + x.estimatedMinutes, 0);
    const racks = dishRacks(d, false);
    if (sideBases.has(d.dishId)) { uses.push({ from: freeAt, to: freeAt + minutes, racks }); continue; }
    const run = d.steps.slice(stay.from, stay.to + 1).filter((s) => !PUT_IN_ONE.test(s.text ?? "")).reduce((n, x) => n + x.estimatedMinutes, 0);
    const afterBird = (waits !== "" && waits.includes(d.title)) || (!!restStep && plan.freesAt !== plan.holderLastOven && run <= restStep.estimatedMinutes);
    items.push({ id: d.dishId, racks, minutes, earliest: afterBird ? ovenOut : freeAt, tail: w.duration - w.offsets[stay.from], pos: d.positionIndex });
  }
  items.sort((a, b) => b.tail - a.tail || a.pos - b.pos);
  const floors = placeInRacks(items, uses);
  // …and a side the raise says goes in when the bird comes out goes in then (or when its
  // pans fit), not finish-aligned to later: the bird coming out is the cook's cue.
  for (const d of nonEmpty) {
    const floor = floors.get(d.dishId);
    const stay = ovenStays(d)[0];
    if (floor === undefined || !stay || !waits || !waits.includes(d.title)) continue;
    const w = walkDishAlone(d, classifyDish(d, honourTags, []));
    sideBases.set(d.dishId, floor - w.offsets[stay.from]);
  }
  let tail = holderTail;
  for (const d of nonEmpty) {
    const ov = plan.ovenSteps.get(d.dishId);
    if (d.dishId === plan.holderDishId || !ov || ov.size === 0 || feast?.pre?.has(d.dishId)) continue;
    const w = walkDishAlone(d, classifyDish(d, honourTags, []));
    const floor = floors.get(d.dishId);
    const stay = ovenStays(d)[0];
    tail = Math.max(tail, floor !== undefined && stay ? floor - ovenOut + w.duration - w.offsets[stay.from] : freeAt - ovenOut + w.duration - w.offsets[Math.min(...ov)]);
  }
  const second = (shift: number) =>
    scheduleOnceCore(nonEmpty, honourTags, enforceMaxLag, coldBases, {
      plan,
      anchor: ovenOut + tail,
      holderBase: holderBase + shift,
      sideBases: new Map([...sideBases].map(([k, v]) => [k, v + shift])),
      sidePre,
      floors: new Map([...floors].map(([k, v]) => [k, v + shift])),
    }, feast);
  // THX-3d round 3 (S, T) — THE BIRD AS LATE AS IT CAN BE. Pass 2 keeps the bird where
  // pass 1 put it, and the cook's hands can then push serve well past it: New Twist,
  // its sides in with the bird at 400°F, carved its turkey 49 minutes before serving
  // while the green beans and the gravy were finished. So the bird and the sides it
  // puts in move later together, in 5-minute steps, and the run whose carved bird
  // waits least is taken, if the day grows by no more than BLOCKS_LATE_SLACK.
  const base = second(0);
  const span = (r: ScheduleResult) => -Math.min(0, ...r.steps.map((e) => e.startOffsetMinutes));
  const wait = (r: ScheduleResult) => carvedWait(r, holder, plan.holderLastOven);
  let best = base;
  for (let shift = 5; shift <= wait(base); shift += 5) {
    const run = second(shift);
    if (span(run) > span(base) + BLOCKS_LATE_SLACK) continue;
    if (wait(run) < wait(best) - 2) best = run;
  }
  // (THX-3d round 5 — the span either way: a side baking before the bird can leave the frame's first minutes empty.)
  return { ...best, totalEstimatedMinutes: span(best) };
}

/** Minutes between the carve's end and serving (0): how long the carved bird waits. */
function carvedWait(r: ScheduleResult, bird: SchedulerDish, lastOven: number): number {
  const rest = bird.steps.findIndex((s, i) => i > lastOven && s.phaseType === "rest");
  const carve = rest >= 0 ? bird.steps.slice(rest + 1).find((s) => !FEAST_SERVE_STEP.test(s.text ?? "")) : undefined;
  const e = carve && r.steps.find((x) => x.dishId === bird.dishId && x.originalStepIndex === carve.stepIndex);
  return e ? Math.max(0, -(e.startOffsetMinutes + carve.estimatedMinutes)) : 0;
}

function scheduleArm(
  nonEmpty: SchedulerDish[],
  honourTags: boolean,
  enforceMaxLag: boolean,
  coldDishesForward: boolean,
  oven: OvenPlan | null = null,
  blocks: FeastOven | null = null,
): ScheduleResult {
  const scheduleOnce = (d: SchedulerDish[], t: boolean, l: boolean, c: ReadonlyMap<string, number> | null) =>
    oven ? scheduleWithOven(d, t, l, c, oven, blocks) : blocks?.blocks ? scheduleBlocksLate(d, t, l, c, blocks) : scheduleOnceCore(d, t, l, c, null, blocks);
  const aligned = scheduleOnce(nonEmpty, honourTags, enforceMaxLag, null);
  if (!coldDishesForward) return aligned;
  const cold = nonEmpty.filter(isServedCold);
  if (cold.length === 0) return aligned;

  // The passive windows pass 1 opened, in cook-start-frame minutes. Only HOT
  // dishes' windows count: a cold dish moving into another cold dish's rest
  // would just shuffle two things that were already free to sit.
  const coldIds = new Set(cold.map((d) => d.dishId));
  const serve = aligned.totalEstimatedMinutes;
  const stepByKey = new Map<string, SchedulerStep>();
  for (const d of nonEmpty) for (const s of d.steps) stepByKey.set(`${d.dishId}#${s.stepIndex}`, s);
  const windows: number[] = [];
  for (const e of aligned.steps) {
    if (coldIds.has(e.dishId)) continue;
    const s = stepByKey.get(`${e.dishId}#${e.originalStepIndex}`);
    if (!s || !isUnattended(s) || s.estimatedMinutes < COLD_FORWARD_MIN_WINDOW) continue;
    windows.push(e.startOffsetMinutes + serve);
  }
  if (windows.length === 0) return aligned;
  windows.sort((a, b) => a - b);

  // Where finish-alignment had each cold dish; only a genuinely EARLIER window
  // is a move worth making. "Earliest first" — every cold dish takes the first
  // window that beats its current base, and the single-cook pass then packs them
  // in priority order.
  const alignedBase = new Map<string, number>();
  for (const e of aligned.steps) {
    if (!coldIds.has(e.dishId)) continue;
    const abs = e.startOffsetMinutes + serve;
    const cur = alignedBase.get(e.dishId);
    if (cur === undefined || abs < cur) alignedBase.set(e.dishId, abs);
  }
  const coldBases = new Map<string, number>();
  for (const d of cold) {
    const was = alignedBase.get(d.dishId);
    if (was === undefined) continue;
    const w = windows.find((x) => x < was);
    if (w !== undefined) coldBases.set(d.dishId, w);
  }
  if (coldBases.size === 0) return aligned;

  const forward = scheduleOnce(nonEmpty, honourTags, enforceMaxLag, coldBases);
  return forward.totalEstimatedMinutes <= aligned.totalEstimatedMinutes ? forward : aligned;
}

/**
 * THX-3d round 3 (T) — a bake that is already in the oven: it needs no free moment of the
 * cook's to start ("The stuffing is in at 400°F…", "Keep roasting the turkey…"), and a
 * second phase that goes on from the first ("Uncover and bake 10–12 minutes more",
 * "Scatter the Parmesan … and roast 5 minutes more", "Reduce the oven to 325°F and
 * continue") starts as the first ends: uncovering is a moment, overbaking is not.
 */
export const ALREADY_IN = /\b(?:is|are) in at \d{3}\s*°\s*F\b|^\s*(?:On [A-Za-z]+day:\s*)?(?:Keep roasting\b|Uncover(?:,[^.;]*?,)? and (?:bake|roast)\b|Scatter [^.;]*\b(?:bake|roast)\b[^.;]*\bmore\b|Reduce the oven to \d{3}\s*°\s*F and continue\b)/i;
/**
 * A side's own one-line put-in step ("Put the potatoes in the oven."). THX-3d round 4 — or
 * "… now that the turkey is out." (A3), and "…; the green beans go in 15 minutes from now." (B).
 */
export const PUT_IN_ONE = /^\s*(?:On [A-Za-z]+day:\s*)?Put the .+? in the oven(?: now that the [\w ]+? is out)?(?:;[^.]*)?\.$/i;

/** THX-3d round 3 — the bird's rest and carve sort before every other step (their floors still hold them). */
const CARVE_FIRST = -1_000_000;

/** Minutes the latest-block move may lengthen the day and still be taken. */
export const BLOCKS_LATE_SLACK = 5;

/**
 * THX-3d round 3 (S) — THE OVEN BLOCKS AS LATE AS THEY CAN BE. The blocks are aligned
 * backward from serve (ovenBlockBases), but to the dish-alone anchor, and the cook's
 * hands then push serve later: Vegetarian's Wellington came out 31 minutes before
 * serving, and its stuffing and mac and cheese, a block earlier, sat covered 73 and 80
 * minutes before their reheat. So the pass runs again with the block dishes anchored
 * to the serve the first pass reached (the stove dishes keep theirs), until it stops
 * moving; a run is taken when it holds the held dishes for less time and lengthens the
 * day by no more than BLOCKS_LATE_SLACK.
 */
function scheduleBlocksLate(
  nonEmpty: SchedulerDish[],
  honourTags: boolean,
  enforceMaxLag: boolean,
  coldBases: ReadonlyMap<string, number> | null,
  blocks: FeastOven,
): ScheduleResult {
  const first = scheduleOnceCore(nonEmpty, honourTags, enforceMaxLag, coldBases, null, blocks);
  const anchor = Math.max(...nonEmpty.map((d) => walkDishAlone(d, classifyDish(d, honourTags, [])).duration));
  // The day's length is first step to serve: a later anchor can leave the clock's
  // first minutes empty, so a run is measured, and returned, by its span.
  const span = (r: ScheduleResult) => -Math.min(0, ...r.steps.map((e) => e.startOffsetMinutes));
  const firstSpan = span(first);
  let best = first;
  let bestHolds = blockHolds(first, nonEmpty, blocks);
  const reach = first.totalEstimatedMinutes - anchor;
  for (let shift = 5; shift <= reach + 30; shift += 5) {
    const run = scheduleOnceCore(nonEmpty, honourTags, enforceMaxLag, coldBases, null, blocks, shift);
    const holds = blockHolds(run, nonEmpty, blocks);
    if (span(run) > firstSpan + BLOCKS_LATE_SLACK) continue;
    if (holds < bestHolds || (holds === bestHolds && span(run) < span(best))) {
      best = run;
      bestHolds = holds;
    }
  }
  if (best === first) return first;
  return { ...best, totalEstimatedMinutes: span(best) };
}

/** The minutes the held dishes wait between their last oven step and their reheat, summed. */
export function blockHolds(res: ScheduleResult, dishes: readonly SchedulerDish[], blocks: FeastOven): number {
  const bk = blocks.blocks;
  if (!bk) return 0;
  const at = new Map(res.steps.map((e) => [`${e.dishId}#${e.originalStepIndex}`, e.startOffsetMinutes]));
  let sum = 0;
  for (const [dishId, k] of bk.reheatOf) {
    const d = dishes.find((x) => x.dishId === dishId);
    const ov = [...(bk.ovenSteps.get(dishId) ?? [])];
    if (!d || ov.length === 0) continue;
    const last = d.steps[Math.max(...ov)];
    const end = (at.get(`${dishId}#${last.stepIndex}`) ?? 0) + last.estimatedMinutes;
    sum += (at.get(`${dishId}#${d.steps[k].stepIndex}`) ?? end) - end;
  }
  return sum;
}

function scheduleOnceCore(
  nonEmpty: SchedulerDish[],
  honourTags: boolean,
  enforceMaxLag: boolean,
  coldBases: ReadonlyMap<string, number> | null,
  oven: OvenRun | null = null,
  blocks: FeastOven | null = null,
  /** THX-3d round 3 (S) — the block dishes' anchor, this much later (scheduleBlocksLate). */
  blockShift = 0,
): ScheduleResult {
  const ignoredTags: IgnoredTag[] = [];

  // 1. Per-dish walk (critical path) + anchor.
  const alone = nonEmpty.map((d) =>
    walkDishAlone(d, classifyDish(d, honourTags, ignoredTags)),
  );
  // THX-3 — the oven's second pass serves at the first pass's (later) serve time.
  const anchor = oven?.anchor ?? Math.max(...alone.map((a) => a.duration));
  // THX-3c (BUG-463) — each oven block but the last finishes its oven work before
  // the next block's first oven step: its dishes' bases move earlier.
  const blockBases = blocks?.blocks ? ovenBlockBases(nonEmpty, alone, anchor + blockShift, blocks.blocks) : null;
  // THX-3d (R4) — the bird's steps after its rest (the carve, the serve step), in minutes.
  const carveTail = ((): number => {
    const birdId = oven?.anchor !== undefined ? oven.plan.holderDishId : blocks?.bird?.dishId;
    const lastOven = oven?.anchor !== undefined ? oven.plan.holderLastOven : blocks?.bird?.lastOven;
    if (!birdId || lastOven === undefined) return 0;
    const d = nonEmpty.find((x) => x.dishId === birdId);
    if (!d) return 0;
    const rest = d.steps.findIndex((s, k) => k > lastOven && s.phaseType === "rest");
    return rest < 0 ? 0 : d.steps.slice(rest + 1).reduce((s, x) => s + x.estimatedMinutes, 0);
  })();
  // THX-3d (R4) — beside a bird hotter than its sides (blocks), when its rest ends.
  const birdRestEnd = ((): number | null => {
    const b = blocks?.bird;
    if (!b || !blocks?.blocks) return null;
    const i = nonEmpty.findIndex((d) => d.dishId === b.dishId);
    if (i < 0) return null;
    const d = nonEmpty[i];
    const base = blockBases?.get(d.dishId) ?? anchor - alone[i].duration;
    const rest = d.steps.findIndex((s, k) => k > b.lastOven && s.phaseType === "rest");
    const k = rest >= 0 ? rest : b.lastOven;
    return base + alone[i].offsets[k] + d.steps[k].estimatedMinutes;
  })();

  // The served-cold set, for the cue's "stays warm" veto (ruling 2). NOT the same
  // question as `coldBases`, which is only about the dishes ruling 3 chose to
  // MOVE: a guacamole must never be described as staying warm whether or not it
  // was pulled forward, and `coldDishesForward: false` must not reinstate that lie.
  const coldDishIds = new Set(nonEmpty.filter(isServedCold).map((d) => d.dishId));

  // THX-3d round 3 (U) — SERVED NOW, AT SERVING TIME (not a feast). A dish whose last
  // step serves it now ("…and serve immediately") ends with its run from its last cook
  // step aligned to serve, and the other dishes finish as that run starts: weeknight
  // Tuesday's tortillas were warmed, the pico was finished, and they sat ten minutes.
  const serveNowFrom = new Map<string, number>();
  if (!oven && !blocks) {
    for (const d of nonEmpty) {
      const last = d.steps[d.steps.length - 1];
      if (!SERVE_NOW.test(last.text ?? "")) continue;
      // Its run: the last stretch of cook steps (the filling, then the tortillas), so the
      // lag bound keeps each heat step against the next.
      let c = d.steps.map((x) => x.phaseType).lastIndexOf("cook");
      while (c > 0 && d.steps[c - 1].phaseType === "cook") c--;
      if (c >= 0 && c < d.steps.length - 1) serveNowFrom.set(d.dishId, c);
    }
  }
  const serveNowTail = Math.max(0, ...[...serveNowFrom].map(([id, c]) => nonEmpty.find((d) => d.dishId === id)!.steps.slice(c).reduce((n, x) => n + x.estimatedMinutes, 0)));
  // PREP-3 (R6) — EVERY DISH'S LAST HANDS AT SERVING TIME. A dish's closing run of
  // assemble steps (the toss, the slice-and-serve, the plate-up) ends at serve: hh4-mixed
  // Thursday dressed the Caesar at T−19 and plated it at T−14, Tuesday sliced the steak at
  // T−15, Friday tossed the arugula at T−10 though its step said "serve immediately". Not
  // a run that chills, rests or keeps warm, and not a feast's (its plating has serveLate).
  const plateLateFrom = new Map<string, number>();
  if (!oven && !blocks) {
    for (const d of nonEmpty) {
      if (serveNowFrom.has(d.dishId)) continue;
      let c = d.steps.length;
      while (c > 0 && d.steps[c - 1].phaseType === "assemble") c--;
      // (Cook Mode's: the stamped meal times pass no text, as for SERVE_NOW.)
      if (c >= d.steps.length || d.steps.slice(c).some((s) => !s.text)) continue;
      if (d.steps.slice(c).some((s) => WAITS.test(s.text ?? ""))) continue;
      // …with the cook stretch before it (as U's run): the salmon bakes until it is plated,
      // and is not plated 12 minutes early because its bake had ended there.
      // (Not over food left to cool: the croutons are toasted early, the Caesar tossed late.)
      while (c > 0 && d.steps[c - 1].phaseType === "cook" && !COOLS.test(d.steps[c - 1].text ?? "")) c--;
      plateLateFrom.set(d.dishId, c);
    }
  }

  // PREP-3 (R7) — a dish another dish's step uses is done as that step would start (the
  // meatballs, before the subs are filled), and the step waits for it in the pass below.
  // Not a feast's: its dishes are timed by the oven.
  const uses = !oven && !blocks ? dishUses(nonEmpty) : [];
  const soaks = nonEmpty.map(soakHolds);
  const waitsFor = new Map(uses.map((u) => [`${u.dishId}|${u.stepIdx}`, u]));
  /** The plain finish-aligned ideal start of a step (what step 2 computes when nothing moves the dish). */
  const plainStart = (dishIdx: number, stepIdx: number): number => {
    const d = nonEmpty[dishIdx];
    const from = serveNowFrom.get(d.dishId);
    if (from !== undefined && stepIdx >= from) return anchor - d.steps.slice(stepIdx).reduce((n, x) => n + x.estimatedMinutes, 0);
    const finishBy = anchor - carveTail - (from !== undefined ? 0 : serveNowTail);
    return finishBy - alone[dishIdx].duration + alone[dishIdx].offsets[stepIdx];
  };
  /** dishId → the latest its done step may end. */
  const doneBy = new Map<string, number>();
  for (const u of uses) {
    const di = nonEmpty.findIndex((x) => x.dishId === u.dishId);
    doneBy.set(u.usesDishId, Math.min(doneBy.get(u.usesDishId) ?? Infinity, plainStart(di, u.stepIdx)));
  }

  // 2. Finish-aligned ideal starts (each dish finishes at `anchor`), except for
  //    a cold dish that `coldBases` has moved into a passive window (ruling 3).
  const work: WorkStep[] = [];
  /** A dish's finish-aligned base (or the one the oven pins), before any held-side move. */
  const alignedOf = (dish: SchedulerDish, dishIdx: number): number => {
    const isHolder = oven?.plan.holderDishId === dish.dishId;
    const notTheBird = dish.dishId !== (oven?.plan.holderDishId ?? blocks?.bird?.dishId);
    const finishBy = notTheBird ? anchor - carveTail - (serveNowFrom.has(dish.dishId) ? 0 : serveNowTail) : anchor;
    return (isHolder && oven?.holderBase !== undefined ? oven.holderBase : undefined) ?? oven?.sideBases?.get(dish.dishId) ?? coldBases?.get(dish.dishId) ?? blockBases?.get(dish.dishId) ?? finishBy - alone[dishIdx].duration;
  };
  // THX-3d round 5 (D-WS9-322) — a held side that bakes first: beside a bird its bake ends
  // as the bird's roast starts (heldSidesToday's pre); in blocks, as the main's bake starts.
  const heldFirstBase = new Map<string, number>();
  /** THX-3d round 5 — the longest bake of a side before the bird (its first stay to its hold). */
  let bakesFirstMinutes = 0;
  const holderFirstRoastIdx = oven ? (nonEmpty.find((d) => d.dishId === oven.plan.holderDishId)?.steps.findIndex((s) => s.phaseType === "cook" && isOvenStep(s)) ?? -1) : -1;
  {
    const at = (id: string) => nonEmpty.findIndex((d) => d.dishId === id);
    const startOf = (id: string, pick: (s: SchedulerStep) => boolean): number | null => {
      const i = at(id);
      const k = i < 0 ? -1 : nonEmpty[i].steps.findIndex(pick);
      return k < 0 ? null : alignedOf(nonEmpty[i], i) + alone[i].offsets[k];
    };
    const goesIn = oven ? startOf(oven.plan.holderDishId, (s) => s.phaseType === "cook" && isOvenStep(s)) : blocks?.mainLast ? startOf(blocks.mainLast.main, (s) => s.phaseType !== "preheat" && isOvenStep(s) && !isReheatStep(s)) : null;
    const held = oven ? blocks?.pre : blocks?.mainLast?.before;
    if (goesIn !== null && held) {
      for (const id of held) {
        const i = at(id);
        const h = i < 0 ? null : heldStepsOf(nonEmpty[i]);
        if (!h) continue;
        heldFirstBase.set(id, goesIn - alone[i].offsets[h.hold]);
        const st = ovenStays(nonEmpty[i])[0];
        if (oven && st) bakesFirstMinutes = Math.max(bakesFirstMinutes, alone[i].offsets[h.hold] - alone[i].offsets[st.from]);
      }
    }
  }
  nonEmpty.forEach((dish, dishIdx) => {
    // THX-3 — the bird keeps the first pass's start (its roast ends where it did);
    // its after-the-rest tail is aligned to serve instead (see scheduleWithOven).
    const isHolder = oven?.plan.holderDishId === dish.dishId;
    // THX-3d (R4) — beside a bird, the other dishes finish as carving starts (the gravy,
    // the potatoes, the green beans): the cook carves last, the bird rests 20–30 minutes
    // and is not left waiting while the stove work finishes around the carve.
    const aligned0 = heldFirstBase.get(dish.dishId) ?? alignedOf(dish, dishIdx);
    // THX-3d round 4 (BUG-496) — a side that waits for room in the oven starts its dish
    // later with it: what it needs done first is done as it goes in.
    // Only from its last cook before the oven (the boiled potatoes, smashed as they go in);
    // raw prep before that (the beans trimmed and tossed) stays where it was.
    const roomAt = oven?.floors?.get(dish.dishId);
    const firstStay = roomAt !== undefined ? ovenStays(dish)[0] : undefined;
    const roomBase = roomAt !== undefined && firstStay ? Math.max(aligned0, roomAt - alone[dishIdx].offsets[firstStay.from]) : aligned0;
    let roomFrom = firstStay?.from ?? Infinity;
    if (firstStay) {
      let k = firstStay.from - 1;
      while (k >= 0 && dish.steps[k].phaseType !== "cook") k--;
      if (k >= 0) { while (k > 0 && dish.steps[k - 1].phaseType === "cook") k--; roomFrom = k; }
    }
    const aligned = aligned0;
    // PREP-3 (R7) — used by another dish: done (its done step ended) by the time it is used.
    const by = doneBy.get(dish.dishId);
    const done = by !== undefined ? uses.find((u) => u.usesDishId === dish.dishId)!.doneIdx : -1;
    const base = by !== undefined ? Math.min(aligned, by - alone[dishIdx].offsets[done] - dish.steps[done].estimatedMinutes) : aligned;
    // THX-3d round 4 — beside a bird, a side that bakes first and is held (it would keep
    // the rest's racks from the sides that go in then) is reheated at serving time too.
    const reheat = blocks?.blocks?.reheatOf.get(dish.dishId) ?? (oven && !isHolder ? (() => { const k = dish.steps.findIndex((s) => isReheatStep(s)); return k >= 0 ? k : undefined; })() : undefined);
    // THX-3d (R4) — the bird's carve is no longer aligned to serve (THX-3 let it rest
    // longer so the carve landed at serve): it follows its 20–30-minute rest, and the
    // serve step (feastServeOrder) comes after everything else.
    const tailFrom = isHolder ? Infinity : reheat !== undefined ? reheat : serveNowFrom.get(dish.dishId) ?? plateLateFrom.get(dish.dishId) ?? Infinity;
    const tailSum = (from: number) => dish.steps.slice(from).reduce((s, x) => s + x.estimatedMinutes, 0);
    // THX-3d (R4) — beside a bird hotter than its sides, a held dish returns to the oven
    // WHILE THE BIRD RESTS ("return uncovered for 10 minutes while the bird rests"): its
    // reheat ends as the rest ends and its later steps follow it, not finish-aligned to serve.
    const heldBack = reheat !== undefined && birdRestEnd !== null ? birdRestEnd - dish.steps[reheat].estimatedMinutes : null;
    const afterReheat = (k: number) => dish.steps.slice(reheat!, k).reduce((s, x) => s + x.estimatedMinutes, 0);
    // THX-3d round 2 (I) — what a side needs done before it goes in (the pecan topping
    // scattered, the panko mixed) ends before the raise that puts it in, not during it.
    const pre = oven?.sidePre?.get(dish.dishId);
    dish.steps.forEach((step, stepIdx) => {
      const before = pre && stepIdx < pre.firstOven ? pre.lead : 0;
      const from = stepIdx >= roomFrom && stepIdx <= (firstStay?.from ?? -1) && by === undefined ? roomBase : base;
      // THX-3d round 5 — the bird's oven heats that much earlier for a side that bakes
      // first; its own prep is done while that side bakes, not squeezed into the preheat.
      const early = isHolder && stepIdx < holderFirstRoastIdx && step.phaseType === "preheat" ? bakesFirstMinutes : 0;
      const idealStart = heldBack !== null && stepIdx >= reheat! ? heldBack + afterReheat(stepIdx) : stepIdx >= tailFrom ? anchor - tailSum(stepIdx) : from + alone[dishIdx].offsets[stepIdx] - before - early;
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

  // PREP-3 3b — a dish another dish waits for (R7) may have to start before the cook does:
  // hh4-mixed Friday's meatballs were to start at −7, began at 0, so the subs ran 7 minutes
  // past the anchor and the arugula, tossed "and serve immediately" at the anchor, waited
  // 7 minutes. The meal moves later by that much, whole: serving is where everything ends.
  if (uses.length > 0) {
    const lead = -Math.min(0, ...work.map((w) => w.idealStart));
    if (lead > 0) for (const w of work) { w.idealStart += lead; w.actualStart += lead; w.finish += lead; }
  }

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

  // SEQ-1 (BUG-594) — the steps that leave a pan live (panLive, or hands-on work done in
  // the live pan that leaves the food on: Biryani's layering over the seared chicken),
  // and each one's dish successor, which starts as it ends. Not a feast's. It is a
  // latest bound of 0, so `enforceMaxLag: false` (the bounds priced, BUG-337's §BREAK)
  // sets it aside with the others.
  // (By the dish's own order, a parallel group's riders included: the enchiladas'
  // tortillas, warmed while the sauce simmers, are rolled next.)
  const live = new Set<WorkStep>();
  const nextOnPan = new Map<WorkStep, WorkStep>();
  const onPanAfter = new Map<WorkStep, WorkStep>();
  if (!oven && !blocks && enforceMaxLag) {
    let prev: WorkStep | undefined;
    for (const w of [...work].sort((a, b) => a.dishIdx - b.dishIdx || a.stepIdx - b.stepIdx)) {
      if (prev?.dishIdx !== w.dishIdx) prev = undefined;
      if (prev && live.has(prev)) {
        nextOnPan.set(prev, w);
        onPanAfter.set(w, prev);
      }
      if (panLive(w.step) || (prev && live.has(prev) && !w.unattended && !OFF_THE_HEAT.test(w.step.text ?? ""))) live.add(w);
      prev = w;
    }
  }
  /** SEQ-1 (BUG-594) — this step starts as its dish's pan-live step ends. */
  const glued = (w: WorkStep): boolean => onPanAfter.has(w);
  /** SEQ-1 (BUG-594) — the first step of a run on a live pan. */
  const panHead = (w: WorkStep): boolean => nextOnPan.has(w) && !glued(w);
  /** SEQ-1 (BUG-594) — the cook's minutes from this step to the end of its run on the pan (an unattended last step: its kickoff minute). */
  const panRunMinutes = (w: WorkStep): number => {
    let n = w.step.estimatedMinutes;
    for (let x = nextOnPan.get(w); x; x = nextOnPan.get(x)) {
      if (x.unattended) return n + 1;
      n += x.step.estimatedMinutes;
    }
    return n;
  };

  /** The bound in minutes, or null when this step has no heat predecessor. */
  const maxLagOf = (w: WorkStep): number | null => {
    const prev = dishPredecessor(w);
    if (prev && glued(w)) return 0; // (a rider has no key to repair: the pass places it with its pan)
    if (!prev || prev.step.phaseType !== "cook") return null;
    return w.step.phaseType === "rest" ? LAG_AFTER_HEAT_REST : LAG_AFTER_HEAT_OTHER;
  };

  // ── THE COOK'S HANDS ARE A BUSY SET, NOT A HIGH-WATER MARK ───────────────
  //
  // 🔴 THIS REPLACED A SCALAR `cookBusyUntil`, AND THE REPAIR ABOVE IS WHY.
  // A single high-water mark is only correct if steps are considered in time
  // order, because it says "the hands are busy until T" and can never be asked
  // about a gap before T. Priority repair breaks that premise by design: it
  // moves a step's KEY without moving its START.
  //
  // Measured: the Mississippi Pot Roast grew 520 → 589 minutes (+13.3%). Its
  // shred step follows an 8-hour braise, so the bound pulled the shred's key to
  // the braise's — placing it FIRST in the walk with an actual start of 502. As
  // an attended step it set the mark to 506, and the mashed potatoes, whose ideal
  // start was 458 and which had happily run inside the braise for the previous
  // eight hours, were then told the hands were busy until 506. Nothing was
  // actually busy at 458; the scalar just could not represent a hole.
  //
  // So the hands keep a set of occupied intervals and a step takes the earliest
  // slot that genuinely fits. An ATTENDED step needs the whole interval free; an
  // UNATTENDED one needs only the instant it is kicked off in (the same rule
  // `walkDishAlone` already applies within a dish).
  const findSlot = (
    busy: readonly [number, number][],
    from: number,
    duration: number,
    wholeWindow: boolean,
  ): number => {
    let t = from;
    // Each shift lands on some interval's end, and there are finitely many, so
    // this settles rather than looping.
    for (let guard = 0; guard <= busy.length; guard++) {
      let moved = false;
      for (const [s, f] of busy) {
        const clashes = wholeWindow ? t < f && s < t + duration : s <= t && t < f;
        if (clashes) { t = f; moved = true; }
      }
      if (!moved) break;
    }
    return t;
  };

  // THX-3d round 3 (T) — the sides that wait for the bird (see the floor in the pass):
  // not named by the put-in, their oven run no longer than the bird's rest.
  const fitsInRest = new Set<string>();
  if (oven && oven.plan.freesAt !== oven.plan.holderLastOven) {
    const hd = nonEmpty.find((x) => x.dishId === oven.plan.holderDishId);
    const restStep = hd?.steps.find((x, i) => i > oven.plan.holderLastOven && x.phaseType === "rest");
    for (const dish of nonEmpty) {
      const ov = [...(oven.plan.ovenSteps.get(dish.dishId) ?? [])].filter((i) => dish.steps[i].phaseType !== "preheat" && !isReheatStep(dish.steps[i]) && !PUT_IN_ONE.test(dish.steps[i].text ?? ""));
      if (!restStep || dish.dishId === oven.plan.holderDishId || oven.sideBases?.has(dish.dishId) || ov.length === 0 || blocks?.pre?.has(dish.dishId)) continue;
      const run = dish.steps.slice(Math.min(...ov), Math.max(...ov) + 1).reduce((n, x) => n + x.estimatedMinutes, 0);
      if (run <= restStep.estimatedMinutes) fitsInRest.add(dish.dishId);
    }
    // THX-3d round 4 (A3) — and the sides the raise says go in when the bird comes out.
    const waits = raiseWaits(hd?.steps[oven.plan.freesAt]?.text ?? "");
    for (const dish of nonEmpty) if (waits && dish.dishId !== oven.plan.holderDishId && waits.includes(dish.title)) fitsInRest.add(dish.dishId);
  }

  // THX-3d round 4 (BUG-496) — THE RACKS, IN THE PASS. A dish's stay in the oven (ovenStays)
  // starts when its pans fit beside what is in — the bird's pan, the other sides' — and
  // holds its racks to the stay's last step. The bird's stay is counted from its ideal
  // starts until it is placed. A feast only.
  const birdOf = oven ? { dishId: oven.plan.holderDishId, lastOven: oven.plan.holderLastOven } : blocks?.bird ?? null;
  const stayFirst = new Map<WorkStep, { key: string; minutes: number; racks: number }>();
  const stayKey = new Map<WorkStep, string>();
  const predicted: [string, RackUse][] = [];
  if (oven || blocks?.blocks) {
    nonEmpty.forEach((d, di) => {
      const isBird = birdOf?.dishId === d.dishId;
      ovenStays(d, isBird ? birdOf : null).forEach((s, si) => {
        const key = `${di}:${si}`;
        const ws = work.filter((o) => o.dishIdx === di && o.stepIdx >= s.from && o.stepIdx <= s.to).sort((a, b) => a.stepIdx - b.stepIdx);
        if (ws.length === 0) return;
        const minutes = ws.reduce((n, o) => n + o.step.estimatedMinutes, 0);
        stayFirst.set(ws[0], { key, minutes, racks: dishRacks(d, isBird) });
        for (const o of ws) stayKey.set(o, key);
        if (isBird) predicted.push([key, { from: ws[0].idealStart, to: ws[ws.length - 1].idealStart + ws[ws.length - 1].step.estimatedMinutes, racks: BIRD_RACKS }]);
      });
    });
  }

  // THX-3d round 4 — in a feast, the steps placed again after the pass take no hands in
  // it: the serve step and a dessert's after-oven steps (feastServeOrder puts them after
  // everything), a morning chain (heldMorningFirst puts it in the first free window).
  // Held in the pass, they pushed the carve and the gravy later than anything ever held
  // the cook (Small: the serve step at the carve, the crisp scooped before the gravy).
  // THX-3d round 4 (BUG-497 item 3) — and the code-written warm steps: a lid and a knob
  // ("Cover and keep warm over the lowest heat.", "Turn the oven off and leave the sides
  // inside …") go right after the dish's last hot step. Queued for the cook's hands they
  // landed 18–23 minutes later (production's Classic: the stuffing out at T−31, the oven
  // turned off at T−8), and the lag repair could not pull them (their key was already the
  // hot step's): the gap, not the anchor.
  const relocated = new Set<WorkStep>();
  if (oven || blocks) {
    const chainKeys = new Set(morningChains(nonEmpty).flatMap((c) => c.keys));
    nonEmpty.forEach((d, di) => {
      const lastOven = d.steps.reduce((m, s, i) => (isOvenStep(s) && !isReheatStep(s) ? i : m), -1);
      for (const w of work.filter((o) => o.dishIdx === di)) {
        const text = w.step.text ?? "";
        // (…and a side's own rest out of the oven, written as an `assemble` step: a rest is hands-free.)
        if (FEAST_SERVE_STEP.test(text) || (DESSERT_DISH.test(d.title) && w.stepIdx > lastOven) || chainKeys.has(`${d.dishId}#${w.step.stepIndex}`) || KEEP_WARM_STEP.test(text) || OVEN_OFF_STEP.test(text) || REST_AFTER_OVEN.test(text)) relocated.add(w);
      }
    });
  }

  /** THX-3c — later blocks' kept preheats (placed after the pass), and each block's lead. */
  const floating = new Set<WorkStep>();
  const blockLead = new Map<number, number>();
  const runPass = () => {
    const busy: [number, number][] = [];
    const placed = nonEmpty.map((d) => new Array<WorkStep | undefined>(d.steps.length));
    const ovenUse = new Map<string, RackUse>(predicted.map(([k, u]) => [k, { ...u }]));
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
        // SEQ-1 (BUG-594) — what runs on its own is started before the pan goes on.
        Number(panHead(a)) - Number(panHead(b)) ||
        a.dishIdx - b.dishIdx ||
        a.step.stepIndex - b.step.stepIndex,
    );
    // THX-3d round 3 — a step is never placed before the steps it follows in its own dish
    // (a pulled-down key — the bird's carve, a side's prep — could otherwise sort it
    // ahead of them, and an unplaced predecessor reads as finished at 0): it waits its
    // turn, and goes as soon as they are placed. With keys in dish order, as they were
    // before, this is the priority order itself.
    const inDishOrder: WorkStep[] = [];
    {
      const done = new Set<WorkStep>();
      const stepAt = (dishIdx: number, stepIdx: number) => work.find((o) => o.dishIdx === dishIdx && o.stepIdx === stepIdx);
      const ready = (w: WorkStep) => {
        if (w.kind.kind === "rider") { const win = stepAt(w.dishIdx, w.kind.windowIdx); return !win || done.has(win); }
        for (let j = 0; j < w.stepIdx; j++) {
          const pj = stepAt(w.dishIdx, j);
          if (pj && !floating.has(pj) && !done.has(pj)) return false;
        }
        return true;
      };
      const waiting = [...priority];
      while (waiting.length > 0) {
        const i = waiting.findIndex(ready);
        const next = waiting.splice(i >= 0 ? i : 0, 1)[0];
        done.add(next);
        inDishOrder.push(next);
      }
    }
    // SEQ-1 (BUG-594) — a pan's run is placed together: each step on a live pan right after the one before it.
    const placing = nextOnPan.size === 0 ? inDishOrder : inDishOrder.flatMap((w) => {
      if (glued(w)) return [];
      const run = [w];
      for (let x = nextOnPan.get(w); x; x = nextOnPan.get(x)) run.push(x);
      return run;
    });
    for (const w of placing) {
      // A step can't begin before its own dish allows it — a rider at its
      // window's kickoff, anything else once every prior step of the dish has
      // finished — nor before its finish-aligned ideal start, nor before the cook
      // is free to touch it (even an unattended step needs a moment of hands to
      // kick off).
      const mine = placed[w.dishIdx];
      let earliest = 0;
      if (w.kind.kind === "rider") {
        earliest = mine[w.kind.windowIdx]?.actualStart ?? 0;
        // THX-3d round 4 (BUG-497 item 5) — in a feast, a preheat riding a hold (the bird's
        // sit) heats the oven as the sit ends, not as it starts: Make-Ahead's oven stood hot
        // and empty 30 minutes of the turkey's hour on the counter.
        const win = mine[w.kind.windowIdx];
        if ((oven || blocks) && win && w.step.phaseType === "preheat" && win.step.phaseType === "hold") earliest = Math.max(earliest, win.finish - w.step.estimatedMinutes);
      } else {
        for (let j = 0; j < w.stepIdx; j++) {
          const pj = mine[j];
          if (pj && floating.has(pj)) continue; // THX-3c — a floating preheat holds nothing up
          earliest = Math.max(earliest, pj?.finish ?? 0);
        }
      }
      let floor = Math.max(w.idealStart, earliest);
      // THX-3 (BUG-449) — the oven frees when the bird comes out. Any other dish's
      // oven step starts no earlier than the holder's last oven step finishes.
      // THX-3d (R4) — or, with a raise step, once the oven is raised for the sides
      // while the bird still roasts (`freesAt`).
      const finishOf = (dishId: string, idx: number) => {
        const hi = nonEmpty.findIndex((d) => d.dishId === dishId);
        const held = placed[hi]?.[idx];
        const ws = work.find((o) => o.dishIdx === hi && o.stepIdx === idx);
        return held ? held.finish : ws ? ws.idealStart + ws.step.estimatedMinutes : 0;
      };
      // (THX-3d round 5 — a held side's bake before the bird is no raise's side.)
      const bakesFirst = (heldFirstHold.get(w.dishId) ?? -1) > w.stepIdx;
      if (oven && !bakesFirst && w.dishId !== oven.plan.holderDishId && oven.plan.ovenSteps.get(w.dishId)?.has(w.stepIdx)) {
        floor = Math.max(floor, finishOf(oven.plan.holderDishId, oven.plan.freesAt));
        // THX-3d round 3 (T) — a side the put-in does not name, whose oven run fits in the
        // bird's rest, waits for the bird to come out (the oven holds the bird and two
        // pans): New Twist's smashed potatoes, two sheet pans, go in as the turkey rests.
        if (fitsInRest.has(w.dishId)) floor = Math.max(floor, finishOf(oven.plan.holderDishId, oven.plan.holderLastOven));
      }
      // THX-3d round 5 (D-WS9-322) — the bird goes in once the sides that bake before it are out.
      if (oven && w.dishId === oven.plan.holderDishId && w.stepIdx === holderFirstRoast) {
        for (const [id, hold] of heldFirstHold) floor = Math.max(floor, finishOf(id, hold - 1));
      }
      // THX-3d round 3 (T) — the put-in waits for the work the sides it names need first
      // (New Twist's sweet potatoes spread on their pan), placed ahead of it (below).
      if (oven?.sidePre && w.dishId === oven.plan.holderDishId && w.stepIdx === oven.plan.freesAt) {
        for (const [dishId, pre] of oven.sidePre) {
          for (let k = 0; k < pre.firstOven; k++) floor = Math.max(floor, finishOf(dishId, k));
        }
      }
      // THX-3d (R4) — the pan drippings exist once the bird is out: New Twist made its
      // gravy from "the turkey roasting pan" at T-91 with the bird in until T-40.
      const bird = oven ? { dishId: oven.plan.holderDishId, lastOven: oven.plan.holderLastOven } : blocks?.bird ?? null;
      if (bird && w.dishId !== bird.dishId && DRIPPINGS.test(w.step.text ?? "")) {
        floor = Math.max(floor, finishOf(bird.dishId, bird.lastOven));
      }
      // PREP-3 (R7) — a step that uses another dish's food starts once that dish is done.
      const use = waitsFor.get(`${w.dishId}|${w.stepIdx}`);
      if (use) floor = Math.max(floor, finishOf(use.usesDishId, use.doneIdx));
      // PREP-3 3b — the skewers are threaded once their soak is over.
      const soak = soaks[w.dishIdx].get(w.stepIdx);
      if (soak && mine[soak.from]) floor = Math.max(floor, mine[soak.from]!.finish + soak.minutes);
      // SEQ-1 (BUG-594) — a pan's run goes on late enough that each of its steps can follow
      // the one before it: Al Pastor's oil heats while the pork marinates, and the pork
      // goes in when the marinade is done, so the oil goes on two minutes before that.
      if (panHead(w)) {
        let offset = w.step.estimatedMinutes;
        for (let x = nextOnPan.get(w); x; x = nextOnPan.get(x)) {
          let own = x.idealStart;
          if (x.kind.kind === "rider") own = Math.max(own, mine[x.kind.windowIdx]?.actualStart ?? 0);
          else for (let j = 0; j < w.stepIdx; j++) own = Math.max(own, mine[j]?.finish ?? 0);
          const xUse = waitsFor.get(`${x.dishId}|${x.stepIdx}`);
          if (xUse) own = Math.max(own, finishOf(xUse.usesDishId, xUse.doneIdx));
          const xSoak = soaks[x.dishIdx].get(x.stepIdx);
          if (xSoak && xSoak.from < w.stepIdx && mine[xSoak.from]) own = Math.max(own, mine[xSoak.from]!.finish + xSoak.minutes);
          floor = Math.max(floor, own - offset);
          offset += x.step.estimatedMinutes;
        }
      }
      // THX-3c (BUG-463) — one temperature at a time: a block's oven step starts no
      // earlier than every oven step of the blocks before it has finished.
      const bk = blocks?.blocks;
      const block = bk?.blockOf.get(w.dishId);
      if (bk && block !== undefined && block > 0 && bk.ovenSteps.get(w.dishId)?.has(w.stepIdx) && !floating.has(w)) {
        for (const o of work) {
          const ob = bk.blockOf.get(o.dishId);
          if (ob === undefined || ob >= block || !bk.ovenSteps.get(o.dishId)?.has(o.stepIdx)) continue;
          const at = placed[o.dishIdx]?.[o.stepIdx];
          floor = Math.max(floor, (at ? at.finish : o.idealStart + o.step.estimatedMinutes) + (blockLead.get(block) ?? 0));
        }
      }
      // …and a dish whose own preheat was merged away puts nothing in the oven
      // before the kept preheat has run.
      const heat = blocks?.heatedBy.get(w.dishId);
      if (heat && w.step.phaseType !== "preheat" && isOvenStep(w.step)) {
        const ws = work.find((o) => o.dishId === heat.dishId && o.step.stepIndex === heat.stepIndex);
        if (ws) {
          const at = placed[ws.dishIdx]?.[ws.stepIdx];
          floor = Math.max(floor, at ? at.finish : ws.idealStart + ws.step.estimatedMinutes);
        }
      }
      // THX-3d round 3 (T) — a bake already in the oven ("Keep roasting the turkey…", "The
      // stuffing is in at 400°F…") goes on by itself: it needs no free moment of the cook's.
      // SEQ-1 (BUG-594) — the first step on a live pan needs the hands free for the pan's whole run.
      const handsFor = panHead(w) ? panRunMinutes(w) : w.step.estimatedMinutes;
      const placeAt = (t: number) => ((w.unattended && ALREADY_IN.test(w.step.text ?? "")) || relocated.has(w) ? t : findSlot(busy, t, handsFor, !w.unattended));
      let start = placeAt(floor);
      // THX-3d round 4 (BUG-496) — a stay goes in when its pans fit.
      const stay = stayFirst.get(w);
      if (stay) {
        const others = [...ovenUse].filter(([k]) => k !== stay.key).map(([, u]) => u);
        for (let guard = 0; guard < 12 && racksInUse(others, start, start + stay.minutes) + Math.min(stay.racks, OVEN_RACKS) > OVEN_RACKS + 1e-9; guard++) {
          start = placeAt(rackFloor(others, start, stay.minutes, stay.racks));
        }
      }
      w.actualStart = start;
      w.finish = start + w.step.estimatedMinutes;
      mine[w.stepIdx] = w;
      const sk = stayKey.get(w);
      if (sk) {
        if (stay) ovenUse.set(sk, { from: start, to: start + stay.minutes, racks: stay.racks });
        else { const u = ovenUse.get(sk); if (u) u.to = Math.max(u.to, w.finish); }
      }
      // Attended steps hold the cook for their whole duration; unattended steps
      // release the cook immediately after kickoff (they run in the background).
      if (!w.unattended && !relocated.has(w)) {
        busy.push([start, w.finish]);
      }
    }
  };

  // THX-3c — a kept preheat runs before EVERY dish it heats: the stuffing that lost its
  // own preheat bakes as long as the mac and cheese that kept one, and both come out
  // as the oven changes temperature, so the preheat starts early enough for the longer.
  if (blocks) {
    for (const [dishId, k] of blocks.heatedBy) {
      const kept = work.find((o) => o.dishId === k.dishId && o.step.stepIndex === k.stepIndex);
      const firstOven = work.filter((o) => o.dishId === dishId && o.step.phaseType !== "preheat" && isOvenStep(o.step) && !isReheatStep(o.step)).sort((a, b) => a.idealStart - b.idealStart)[0];
      if (!kept || !firstOven) continue;
      const want = firstOven.idealStart - kept.step.estimatedMinutes;
      if (want < kept.idealStart) {
        kept.idealStart = want;
        kept.actualStart = want;
        kept.finish = want + kept.step.estimatedMinutes;
      }
    }
  }

  // THX-3c (BUG-463, chat-Claude's ruling) — NO IDLE GAP AT THE TEMPERATURE CHANGE.
  //   • An earlier block's dish has no hands but a kick-off and the foil, so it is
  //     sorted first and lands where it was aligned.
  //   • A later block's kept preheat FLOATS: the cook assembles the Wellington while
  //     the oven heats, so its dish's next steps do not wait for it, and after the pass
  //     it is placed to finish exactly as the first bake it heats starts. The block
  //     before it then moves later to end exactly there (see below the pass).
  if (blocks?.blocks) {
    const bk = blocks.blocks;
    const lastBlock = Math.max(...bk.blockOf.values());
    for (const w of work) {
      const b = bk.blockOf.get(w.dishId);
      if (b === undefined) continue;
      // THX-3d — only the steps BEFORE its reheat: a step after it (the stuffing's "let it
      // rest 5 minutes") jumped ahead of its own reheat.
      if (b < lastBlock && w.stepIdx < (bk.reheatOf.get(w.dishId) ?? Infinity)) priorityKey.set(w, w.idealStart - PRIORITY_LEAD);
      if (b > 0 && w.step.phaseType === "preheat" && bk.ovenSteps.get(w.dishId)?.has(w.stepIdx)) {
        floating.add(w);
        blockLead.set(b, Math.max(blockLead.get(b) ?? 0, w.step.estimatedMinutes));
      }
    }
  }

  // THX-3d (R4) — THE BIRD IS CARVED AS ITS REST ENDS. Its steps after the rest share
  // the rest's priority, so the cook's hands go to the carve before the stove work that
  // finish-aligned later; the bird rests its 20–30 minutes, not 40 while the potatoes
  // are mashed. What does not fit before the carve is done after it, before serving.
  {
    const birdId = oven?.anchor !== undefined ? oven.plan.holderDishId : blocks?.bird?.dishId;
    const lastOven = oven?.anchor !== undefined ? oven.plan.holderLastOven : blocks?.bird?.lastOven;
    if (birdId && lastOven !== undefined) {
      const restW = work.find((w) => w.dishId === birdId && w.stepIdx > lastOven && w.step.phaseType === "rest");
      // 🔴 Not the rest's own key: the lag repair below pulls a side's whole chain to its
      // first step's key (Small: boil → mash, roast → squeeze the lemon), earlier than the
      // rest's, and those took the hands while a 20-minute breast rested 30. The rest and
      // what follows it take the ROAST's key — early, and still in the dish's order (a
      // dish's order is its keys' order: a lower key than the rest's put New Twist's
      // carve before its rest). Once the rest is over, the carve goes first.
      const roastW = work.find((w) => w.dishId === birdId && w.stepIdx === lastOven);
      if (restW && roastW) {
        // THX-3d round 3 (S, T) — first of all: with the bird placed later than the stove
        // dishes were aligned to, the roast's key no longer sorts ahead of their finishing
        // work, and New Twist's carve waited 4 minutes behind the green beans.
        // From the main roast on (its put-in and its keep-roasting included): the carve
        // cannot go before them, so they go first too — the roasts hold no hands.
        const mainRoast = work.filter((w) => w.dishId === birdId && w.step.phaseType === "cook" && isOvenStep(w.step)).sort((a, b) => a.stepIdx - b.stepIdx)[0];
        const from = Math.min(restW.stepIdx, mainRoast?.stepIdx ?? restW.stepIdx);
        for (const w of work) if (w.dishId === birdId && w.stepIdx >= from) priorityKey.set(w, Math.min(keyOf(w), keyOf(roastW), CARVE_FIRST + w.stepIdx));
      }
    }
  }

  // THX-3d round 3 (T) — a side's work before the put-in that names it (sidePre) goes
  // ahead of the put-in in the cook's order: the sweet potatoes are on their pan before
  // "Put the … in the oven with the turkey", not 15 minutes after it.
  // (Again after each lag repair: the repair pulls the put-in's key down to the roast's.)
  const sidePreFirst = (): boolean => {
    const putIn = oven?.sidePre?.size ? work.find((o) => o.dishId === oven.plan.holderDishId && o.stepIdx === oven.plan.freesAt) : undefined;
    let changed = false;
    if (!putIn) return changed;
    for (const [dishId, pre] of oven!.sidePre!) {
      for (const o of work) {
        if (o.dishId !== dishId || o.stepIdx >= pre.firstOven || keyOf(o) <= keyOf(putIn) - 1) continue;
        priorityKey.set(o, keyOf(putIn) - 1);
        changed = true;
      }
    }
    return changed;
  };
  sidePreFirst();

  // THX-3d round 5 (D-WS9-322) — a held side that bakes first goes first in the cook's
  // order up to its hold: before the bird's roast (whose keys are CARVE_FIRST's), before
  // the main's bake in blocks.
  const heldFirstHold = new Map<string, number>();
  const holderFirstRoast = oven ? (nonEmpty.find((d) => d.dishId === oven.plan.holderDishId)?.steps.findIndex((s) => s.phaseType === "cook" && isOvenStep(s)) ?? -1) : -1;
  for (const id of heldFirstBase.keys()) {
    const i = nonEmpty.findIndex((d) => d.dishId === id);
    const h = heldStepsOf(nonEmpty[i]);
    if (h) heldFirstHold.set(id, h.hold);
  }
  for (const w of work) {
    const hold = heldFirstHold.get(w.dishId);
    if (hold === undefined || w.stepIdx > hold) continue;
    priorityKey.set(w, oven ? CARVE_FIRST - 100_000 + w.stepIdx : Math.min(keyOf(w), w.idealStart - PRIORITY_LEAD));
  }

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
      if (sidePreFirst()) changed = true;
      if (!changed) break;
      runPass();
    }
  }

  // THX-3c (BUG-463, chat-Claude's ruling) — THE TEMPERATURE CHANGE, PLACED. Each
  // floating preheat ends as the first oven step it heats starts (any dish of its
  // block); the block before it moves later, whole, to come out exactly as the preheat
  // starts. Latest block first. Those dishes hold no hands but the foil's minute.
  if (blocks?.blocks) {
    const bk = blocks.blocks;
    for (const pre of [...floating].sort((a, b) => (bk.blockOf.get(b.dishId) ?? 0) - (bk.blockOf.get(a.dishId) ?? 0))) {
      const b = bk.blockOf.get(pre.dishId)!;
      const heats = work.filter((w) => bk.blockOf.get(w.dishId) === b && w.step.phaseType !== "preheat" && bk.ovenSteps.get(w.dishId)?.has(w.stepIdx));
      if (heats.length === 0) continue;
      const at = Math.min(...heats.map((w) => w.actualStart)) - pre.step.estimatedMinutes;
      const before = work.filter((w) => bk.blockOf.get(w.dishId) === b - 1 && bk.ovenSteps.get(w.dishId)?.has(w.stepIdx));
      const end = before.length ? Math.max(...before.map((w) => w.finish)) : at;
      if (at > end) {
        const delta = at - end;
        for (const w of work) {
          if (bk.blockOf.get(w.dishId) !== b - 1 || w.stepIdx === bk.reheatOf.get(w.dishId)) continue;
          w.actualStart += delta;
          w.finish += delta;
        }
      }
      pre.actualStart = Math.max(at, end);
      pre.finish = pre.actualStart + pre.step.estimatedMinutes;
    }
  }

  // THX-3c (BUG-463, chat-Claude's ruling) — THE REHEAT LANDS AT SERVING TIME. The
  // cook's hands can push serving past the anchor the ideal starts were aligned to;
  // the held dishes go back into the hot oven for the last minutes whatever it is.
  // THX-3d (R4) — beside a bird hotter than its sides, at the END OF THE BIRD'S REST
  // instead ("return uncovered for 10 minutes while the bird rests"). And a dish's steps
  // after its reheat (the stuffing's "let it rest 5 minutes") follow it, in order.
  // THX-3d round 4 — beside a bird too, for a side done as the bird comes out (A3).
  /** THX-3d round 5 — reheats with no room that a short enough hold makes unnecessary. */
  const droppedReheats = new Set<WorkStep>();
  const reheatIdx = new Map<string, number>();
  if (blocks?.blocks) for (const [k, v] of blocks.blocks.reheatOf) reheatIdx.set(k, v);
  else if (oven) nonEmpty.forEach((d) => { const k = d.steps.findIndex((s) => isReheatStep(s)); if (k >= 0 && d.dishId !== oven.plan.holderDishId) reheatIdx.set(d.dishId, k); });
  if (reheatIdx.size > 0) {
    const isReheat = (w: WorkStep) => w.stepIdx === reheatIdx.get(w.dishId);
    const after = (w: WorkStep) => w.stepIdx > (reheatIdx.get(w.dishId) ?? Infinity);
    const serveAt = Math.max(...work.filter((w) => !isReheat(w) && !after(w)).map((w) => w.finish));
    const bird = blocks?.blocks ? blocks.bird : null;
    const restOfBird = bird
      ? work.find((w) => w.dishId === bird.dishId && w.stepIdx > bird.lastOven && w.step.phaseType === "rest")
      : undefined;
    const endAt = restOfBird ? restOfBird.finish : serveAt;
    // THX-3d round 4 (BUG-496) — and when there is room for it: no more than REHEAT_MINUTES
    // before that, else as soon as a rack frees after it.
    const stays = new Map<string, RackUse>();
    for (const o of work) {
      const k = stayKey.get(o);
      if (!k || isReheat(o)) continue;
      const u = stays.get(k);
      stays.set(k, u ? { ...u, from: Math.min(u.from, o.actualStart), to: Math.max(u.to, o.finish) } : { from: o.actualStart, to: o.finish, racks: stayFirst.get(work.find((x) => stayKey.get(x) === k && stayFirst.has(x))!)!.racks });
    }
    const roomUses = [...stays.values()];
    // THX-3d round 5 — the biggest reheat takes serving time first (two pans of potatoes
    // need the whole oven; a 9×13 slips in beside the last bake). Every held dish is
    // reheated (D-WS9-322 (2)), even when that moves serving.
    const reheats = work.filter(isReheat).sort((a, b) => dishRacks(nonEmpty[b.dishIdx], false) - dishRacks(nonEmpty[a.dishIdx], false) || a.dishIdx - b.dishIdx);
    for (const w of reheats) {
      const prev = work.find((o) => o.dishIdx === w.dishIdx && o.stepIdx === w.stepIdx - 1);
      const want = Math.max(endAt - w.step.estimatedMinutes, prev?.finish ?? 0);
      const racks = dishRacks(nonEmpty[w.dishIdx], false);
      const fits = (t: number) => racksInUse(roomUses, t, t + w.step.estimatedMinutes) + racks <= OVEN_RACKS + 1e-9;
      let t = want;
      while (!fits(t) && t > Math.max(want - REHEAT_MINUTES, prev?.finish ?? -Infinity)) t--;
      if (!fits(t)) t = rackFloor(roomUses, want, w.step.estimatedMinutes, racks);
      if (!droppedReheats.has(w)) {
        roomUses.push({ from: t, to: t + w.step.estimatedMinutes, racks });
        w.actualStart = t;
        w.finish = w.actualStart + w.step.estimatedMinutes;
      }
      // The dish's later steps follow the reheat where it now is (or its hold, when it has
      // none): the hands-free ones (the oven-off, a rest) re-flow to it; THX-3d round 5 —
      // the pass had placed them behind the reheat's first, capacity-pushed position.
      let cursor = droppedReheats.has(w) ? (prev?.finish ?? w.actualStart) : w.finish;
      for (const o of work.filter((x) => x.dishIdx === w.dishIdx && x.stepIdx > w.stepIdx).sort((a, b) => a.stepIdx - b.stepIdx)) {
        o.actualStart = relocated.has(o) || o.unattended ? Math.max(o.idealStart, cursor) : Math.max(o.actualStart, cursor);
        o.finish = o.actualStart + o.step.estimatedMinutes;
        cursor = o.finish;
      }
    }
  }

  // 4. Emit. Serve anchor = the actual latest finish (serialization may have
  //    pushed it past `anchor`; recompute so offsets are truthful).
  const kept = work.filter((w) => !droppedReheats.has(w));
  const serveAnchor = Math.max(...kept.map((w) => w.finish));

  const ordered = [...kept].sort(
    (a, b) =>
      a.actualStart - b.actualStart ||
      // SEQ-1 (BUG-594) — the pan's next step is the next one the cook reads, and a
      // kickoff at the moment the pan goes on is read before it.
      Number(glued(b)) - Number(glued(a)) ||
      Number(panHead(a)) - Number(panHead(b)) ||
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
    const cue = composeCue(w, ordered, seqIdx, coldDishIds, !oven && !blocks);
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
    ...(droppedReheats.size > 0 ? { mergedSteps: [...droppedReheats].map((w) => ({ dishId: w.dishId, stepIndex: w.step.stepIndex })) } : {}),
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
  /** SEQ-1 (BUG-596) — an everyday meal's cue says what the dish is really doing (cookStateOf); a feast's is frozen. */
  everyday = false,
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

  const state = everyday
    ? cookStateOf(window.step, window.step.text ?? "", coldDishIds.has(window.dishId), window.dishTitle)
    : passiveStateOf(window.step, window.step.text ?? "", coldDishIds.has(window.dishId));
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
