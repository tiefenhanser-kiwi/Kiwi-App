// WS7-8a Block 2 — code-owned prep-week response assembly.
//
// The deterministic bridge between the engine result and the locked
// PrepWeekResult wire shape. Two pure steps:
//
//  buildStepPlan(result)        → code-owned step skeletons (number, phase,
//                                 contributesToMealIds) + the narration input
//                                 the AI is asked to write prose for.
//  assemblePrepWeekResult(plan, → merges AI prose back onto the code-owned
//    narration)                   skeletons by stepId. Numeric + attribution
//                                 fields come from the plan; ONLY title /
//                                 instructions / storageNote / estimatedMinutes
//                                 come from the AI. The narration result has no
//                                 quantity / mealId field, so prose cannot move
//                                 the math.
//
// Step structure (B1 ruling): seasonings_dry collapses ALL its entries (which
// are exactly the detected spice-blend components) into ONE "mix the blend"
// step; every other phase emits one step per included/uncertain group.
// Excluded groups never reach here (they are dropped upstream).
//
// Known simplification (D-WS7-151): two distinct dish-blends in one plan merge
// into a single seasonings_dry blend step. Accepted for now.

import { convertWithinDimension, pluralizeCountUnit } from "./ingredientConversions";
import {
  bowlNameFor,
  mustSit,
  proteinVerbsFor,
  isServedSeparately,
} from "./prepComponents";
import {
  classOf,
  cutOf,
  foodKeyOf,
  isWetA,
  judgeProducePortion,
  judgeProteinWork,
  type PrepClass,
} from "./prepClasses";
import { timeStep, planMinutes, wholeFruitCount, type SourceYieldLike } from "./prepStepMinutes";
import { proseNames } from "./prepMoments";
import {
  PREP_PHASE_ORDER,
  canonicalizeUnit,
  type IngredientComponent,
  type PrepPhaseKey,
  type PrepCombineResult,
  type PrepIngredientGroup,
} from "./prepCombineEngine";
// H6.2 item 2 — re-exported here because the orphan labelling and the tests both reach
// for it from the assembly, while the engine is where the grouping has to read it.
export { isNoWorkPortion } from "./prepCombineEngine";
import type {
  PrepMeasure,
  PrepNarrationComponent,
  PrepNarrationInput,
  PrepNarrationResult,
} from "./ai/schemas/prepNarration";
import type { PrepWeekResult, PrepWeekStep } from "./ai/schemas/prepWeek";

// Fixed, code-owned phase labels + skippable flags (PRD §13.4.1). Never AI.
// D-WS9-301 rule 9 — the labels Hans gave on the device pass. Short, and the
// kind of work rather than the aisle it came from. SERVER-OWNED: the client
// renders `phase.title` verbatim, so this is the only place they live.
const PHASE_META: Record<PrepPhaseKey, { title: string; skippable: boolean }> = {
  seasonings_dry: { title: "Dry ingredients", skippable: true },
  produce: { title: "Produce", skippable: false },
  sauces_marinades: { title: "Sauces and marinades", skippable: true },
  proteins: { title: "Proteins", skippable: false },
};

// ── D-WS9-301 rule 10 — THE WASH STEP ──────────────────────────────────────
//
// Hans's strategy opens the board with it: "then I do my produce — wash and dry
// all to start". It is fixed prose, a fixed three minutes, and NO container —
// nothing is portioned, so it must not inflate the header's first number.
//
// Emitted once, only when the produce phase has something in it, and keyed so a
// regenerate finds the same checkbox.
export const WASH_STEP_KEY = "produce#wash-all";
export const WASH_STEP_TITLE = "Wash and dry all the produce";
export const WASH_STEP_INSTRUCTIONS =
  "Wash and dry everything you are about to cut. One pass now keeps the board dry and the knife work clean.";
const WASH_STEP_MINUTES = 3;

// PrepWeekResult.totalEstimatedMinutes is capped 1..240 by the locked schema.
// Clamp the summed estimate so a large plan can't fail validation on the total.
const TOTAL_MIN = 1;
const TOTAL_MAX = 240;

export class PrepNarrationIncompleteError extends Error {
  constructor(public readonly missingStepIds: string[]) {
    super(`narration missing ${missingStepIds.length} step(s)`);
    this.name = "PrepNarrationIncompleteError";
  }
}

export interface PlannedStep {
  stepId: string;
  // WS7-8a B3 (D-WS7-153) — STABLE per-step key for checkbox persistence,
  // distinct from the transient positional `stepId`. Derived from the engine's
  // ingredientId (1:1 with phase), so it survives a regenerate. Carried onto
  // the wire step in assemblePrepWeekResult.
  stepKey: string;
  phase: PrepPhaseKey;
  number: number;
  // The engine ingredientId this step's key is derived from. null for a
  // per-dish seasonings_dry blend step (it folds a dish's many spice
  // ingredientIds into one step, keyed `seasonings_dry#dish#${dishId}` — BUG-016
  // / D-WS7-187) and for a grouped sauces_marinades dish-step (`…#dish#${dishId}`).
  ingredientId: string | null;
  // CODE-OWNED attribution — the dedup union of the contributing meal ids.
  contributesToMealIds: string[];
  isBlend: boolean;
  /**
   * WS9 BUG-204 — CODE-OWNED minutes, from `prepStepMinutes.timeStep`. Replaces
   * the model's estimate, which ran about 3x long and is no longer requested.
   *
   * ⚠️ NEVER SENT TO THE NARRATOR. It is derived from the step's own contents,
   * so the model has nothing to add and a number in the prompt would only invite
   * prose that contradicts it ("this takes a couple of minutes").
   */
  estimatedMinutes: number;
  /** True when the raw estimate exceeded the cap — a classification error. */
  minutesOverCap?: boolean;
  components: PrepNarrationComponent[];
  // WS7-8a B2b / D-WS9-049 A1.2 — NAMES of the dish(es) this step's ingredients
  // are cooked in and that have step text. The prose itself lives once in the
  // narration input's `dishSteps` map; each step just references the dishes.
  // Empty when no step text was available for any of this step's dishes.
  relevantDishes: string[];
  // WS7-8b #5 — set ONLY on a grouped sauces_marinades dish-step whose dish
  // ALSO has dry spices that survived into the seasonings_dry blend step. The
  // value is that dish's name; the narrator emits the mandatory linkage wording
  // ("combine … with the <name> spices from your seasoning blend") only when
  // present. Absent when the sauce's dry spices were dropped upstream as noise
  // (<3-per-dish blend), so the wording never points at spices that aren't there.
  /**
   * WS9 D-WS9-296 — the vessel this step fills, e.g. "Carne asada marinade bowl".
   * Present on a COMPONENT step; absent on a plain per-ingredient portion. The
   * narrator must use it verbatim, and every destination row shows it.
   */
  bowlName?: string;
  /**
   * D-WS9-296 ruling 1 — the sentence for a raw protein that JOINS a bowl on cook
   * day rather than sitting in it. Written by the ENGINE, never the model: it
   * states a fact about the schedule, and prose must not be able to move it.
   */
  cookDaySentence?: string;
  /** D-WS9-301 rule 12 — the knife verb(s) this protein step should name. */
  knifeVerbs?: string[];
  /** D-WS9-301 rule 7 — a step that holds no food (the wash, a cook-day line). */
  holdsNoContainer?: boolean;
  /**
   * H4 / rule 11(c) — THE CONTAINER THIS STEP WORKS ON. A container has up to
   * two steps (dry in phase 1, wet in phase 3) and the counter counts
   * CONTAINERS, not steps, so the identity has to be on the step.
   */
  containerId?: string;
  /**
   * H4 — what is already in the container when this step runs, so the later
   * step can open with it: "Lemon-herb marinade container (garlic, rosemary and
   * thyme already in it): add 3 tbsp olive oil…".
   */
  containerHolds?: string[];
  /**
   * H7 2f — the step's opening, built in code from `containerHolds`:
   * "Garlic Herb Roasted Potatoes sauce bowl (garlic, rosemary and thyme already in
   * it): add" or "Into the … :". Handed to the narrator as fixed text.
   */
  openingClause?: string;
  /** H7 2f — "Whisk to combine." / "Stir to combine.", from the members. Fixed text. */
  closingLine?: string;
  /**
   * H7 2b — the containers whose storage line THIS step carries, because it is the
   * last step to touch them. Every container on the plan is in exactly one step's
   * list.
   */
  closes?: string[];
  /**
   * H7.1 2b — on a protein step: the marinade it belongs with. Whether it joins at
   * prep or the night before is the overlay's call, from the cook day.
   */
  marinadeJoin?: MarinadeJoin & { bowl: string };
  /**
   * H6.1-C — this step is not the LAST to touch its container(s), so the storage
   * line belongs to a later step and this one closes "Set aside for …" instead.
   */
  suppressStorage?: boolean;
  /**
   * D-WS9-301 rule 10 — prose the ENGINE owns outright, for a step with no
   * ingredients for the model to narrate. The wash step is the only one today.
   * When present the narrator is not asked about this step at all.
   */
  fixedProse?: { title: string; instructions: string };
  /**
   * D-WS9-299 — the engine's own demotion. A step that does not save weeknight
   * time is render-omitted, whatever the model thinks. Carries the arm that
   * refused it so the corpus report can be read.
   */
  demoted?: { reason: string };
  /**
   * D-WS9-298 — max over this step's destination meals of (cook date − prep day),
   * in days. Undefined when no destination carries a date.
   *
   * ⚠️ CODE-ONLY. This never reaches the narration input: the storage note and the
   * demotion it drives are deterministic, and a day-dependent PROMPT input makes
   * every day reassignment a cache miss for prose that would not have changed.
   */
  daysUntilCook?: number;
  /**
   * Part J.0 (census finding 2) — the PORTION LINES, rendered by code. Present on
   * a produce step whose portions go somewhere: "4 cloves for Beef Enchiladas
   * Verdes — into the tub "Minced garlic — …"". The narrator writes only the
   * opening sentence; assembly puts these under it. See `renderPortionLines`.
   */
  portionLines?: string[];
  /** What the narrator is told about a portion step instead of its measures. */
  portionsByApp?: { food: string; total: string; cuts: string[]; portionCount: number };
  /** Part J.0 (A4) — see PrepWeekStepSchema.coversCookSteps. Set by prepWeekBuild. */
  coversCookSteps?: { mealId: string; dishId: string; stepIndex: number }[];
}

export interface StepPlan {
  steps: PlannedStep[];
  narrationInput: PrepNarrationInput;
  /**
   * H7.1 — container name → what its close must add (a cold mix's dressing, a
   * marinade's proteins). Date-free facts; the overlay writes the sentence. Optional
   * so a hand-built plan in a test still type-checks.
   */
  containerExtras?: ReadonlyMap<string, ContainerExtra>;
  /** Part J.0 — see renderPortionLines; assembly re-renders with the real opening. */
  labelKinds?: ReadonlyMap<string, LabelKind>;
}

/**
 * D-WS9-301 rule 11 — where one (dish, ingredient) portion goes, by container
 * name. Undefined when the portion is its own container and needs no pointer.
 */
type DestinationResolver = (dishId: string, ingredientId: string | null) => string | undefined;

// ── H4 / D-WS9-301 rule 11(c) — THE KIND OF WORK A MEMBER NEEDS ────────────
//
// A container is the unit of IDENTITY; a step is the work done on it in ONE
// phase. Its members are distributed by what each one needs doing:
//
//   dry      → phase 1, one step per container ("measure the seasonings")
//   produce  → phase 2, into that INGREDIENT's own step, with this container as
//              the named destination. Never a "Build the … container" step in
//              Produce: Hans works one knife and one board, all the garlic at
//              once, and a marinade step that minces garlic inside it is exactly
//              what he objected to — "the user should have already prepped the
//              veggies that will go into that marinade".
//   wet      → phase 3, one step per container, which is where the container is
//              finished and says what is already in it.
//   protein  → phase 4, as built in H3.
//
// 🔴 WET IS NOT THE SAME AS "sauces_marinades". A lemon is Produce, and zesting
// and juicing it is wet work that belongs with the oil in phase 3, not with the
// knife work in phase 2. So the engine's phase is the starting point and the
// FORM decides the rest.
type MemberKind = "dry" | "produce" | "wet" | "protein";

/** Juice, zest and purée are liquids however the catalog files them. */
const WET_FORM = /\b(juice|zest|purée|puree|paste|sauce|vinegar|oil|syrup|honey|broth|stock|wine|cream|yogurt|mayo|mustard)\b/i;
// 🔴 THERE IS NO NOTE ARM ANY MORE, AND IT MUST NOT COME BACK. H5.3 — a whole
// lemon whose note says "zested and juiced" is still a lemon on a board: its
// juice and its zest are portioned to their destinations in phase 2, like the
// onion, and the marinade's phase 3 step adds only the oil. A note arm sent it
// into the bowl instead, where a step cannot say where each portion goes.
//
// Measured before removing it: the arm placed 6 members in phase 3 across the 14
// corpus plans, and 5 were named "lime juice" or "lemon juice" — wet by FORM,
// unaffected. The 6th was a grated cucumber that never belonged there.
export function memberKind(
  phase: PrepPhaseKey | null,
  ingredientName: string,
  preparationNotes: string,
): MemberKind {
  if (phase === "proteins") return "protein";
  if (phase === "seasonings_dry") return "dry";
  if (phase === "sauces_marinades") return "wet";
  // 🔴 H7 2d — EVERYTHING THE CATALOG CALLS PRODUCE IS BOARD WORK, juice included.
  // H5.3 sent "lime juice" to phase 3 by its FORM ("a bottle that belongs with the
  // oil"), and the plan then juiced a lemon in produce and squeezed it again in the
  // sauces phase. Hans, October 2: "all of one food's knife work — juice and zest
  // included — is one produce step." A Pantry juice is still `wet` above, by phase.
  void WET_FORM;
  void ingredientName;
  void preparationNotes;
  return "produce";
}

/** Which phase a member's work is done in. */
const PHASE_OF_KIND: Record<MemberKind, PrepPhaseKey> = {
  dry: "seasonings_dry",
  produce: "produce",
  wet: "sauces_marinades",
  protein: "proteins",
};

/** The kind of one engine group, from the fields the assembly has. */
function kindOf(entry: PrepIngredientGroup): MemberKind {
  const notes = entry.lines
    .flatMap((l) => l.contributions.map((c) => c.preparationNote ?? ""))
    .join(" ");
  return memberKind(entry.phase, entry.ingredientName, notes);
}

/**
 * H6.1-B — a container label the cook can read off a lid, inside the wire's
 * 120-character cap (the client's PrepWeekStepSchema holds it there too).
 *
 * 🔴 Part J.0 — EVERY DISH, NEVER "+N more". A lid that says "+2 more" sends the
 * cook to the recipe to find out which. Now that each portion line names its full
 * dish, the label can afford SHORT dish names when the full ones do not fit:
 * "Minced garlic — Enchiladas Verdes, Street-Style Rice, Beef Chili". Shortening
 * runs only when it has to, and the hard trim is the last resort for one title
 * that is too long on its own.
 *
 * `tailIsDishes` — true for rule 5's shared tub (noun — its dishes); false for a
 * dish's own container (dish — its contents), where the DISH is what shortens.
 */
const LABEL_MAX = 120;
function shortDishName(name: string): string {
  const head = name.split(/\s+(?:with|over)\s+|,\s*|:\s*|\s*\(/i)[0].trim();
  const words = head.split(/\s+/);
  // "Chicken and Dumplings", "Pico de Gallo": a pair that opens on a connector
  // keeps the word before it.
  const two = words.slice(-2);
  return /^(?:and|&|de|del|of|in|the|a|on)$/i.test(two[0] ?? "") ? words.slice(-3).join(" ") : two.join(" ");
}
function containerLabel(head: string, tail: readonly string[], tailIsDishes = false): string {
  const fit = (h: string, t: readonly string[]) => `${h} — ${t.join(", ")}`;
  const tries = tailIsDishes
    ? [fit(head, tail), fit(head, dedupe(tail.map(shortDishName))), fit(head, dedupe(tail.map((d) => shortDishName(d).split(" ").at(-1)!)))]
    : [fit(head, tail), fit(shortDishName(head), tail)];
  for (const t of tries) if (t.length <= LABEL_MAX) return t;
  const last = tries[tries.length - 1].replace(/\bfresh\s+/gi, "");
  if (last.length <= LABEL_MAX) return last;
  return `${last.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

/** "diced onion" → "Diced onion", for the head of a container label. */
function upperFirst(t: string): string {
  return t.length === 0 ? t : `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// ── WS7-8b FIX 2 — kitchen-fraction formatter (code owns the math) ───────────
// Turns a raw engine decimal + unit into a finished display string the narrator
// echoes verbatim, so "prose can't move the math" still holds. Per-family
// policy (Hans-ratified):
//   - tsp/tbsp/cup/oz/lb → round UP to the nearest 1/8, rendered as a mixed
//     number with a vulgar-fraction glyph ("¾ cup", "1½ tbsp" — unspaced since
//     D-WS9-297 ruling 7).
//   - ml/g              → round to a whole number (no fractions, no decimals).
//   - counts + unknown  → whole where clean, else the nearest glyph ("½ onion");
//     the bare "each" placeholder unit is dropped (ruling 7).
// Unit token comes from the engine's own canonicalizer so spelling variants
// ("teaspoons" → "tsp") collapse; magnitude is never converted here (each
// contribution keeps its own unit), only the spelling is normalized.

const EIGHTH_UNITS: ReadonlySet<string> = new Set(["tsp", "tbsp", "cup", "oz", "lb"]);
const WHOLE_UNITS: ReadonlySet<string> = new Set(["ml", "g"]);

// rem (1..7) eighths → vulgar-fraction glyph. 4/8 reduces to ½, etc.
const EIGHTH_GLYPH: Record<number, string> = {
  1: "⅛", // ⅛
  2: "¼", // ¼
  3: "⅜", // ⅜
  4: "½", // ½
  5: "⅝", // ⅝
  6: "¾", // ¾
  7: "⅞", // ⅞
};

// ── WS9 BUG-338 / D-WS9-297 ruling 7 — ONE APP, ONE MIXED NUMBER ────────────
//
// 🔴 THE SPACED FORM IS RETIRED. The comment below used to defend "1 ½ lb" as
// "how a recipe is written". Measured on the 13-plan census: 55 spaced mixed
// numbers, against `artifacts/kiwi/lib/format/quantity.ts` which writes `1½`
// everywhere else in the app (`${whole}${glyph}`, no separator). Hans ruled
// glyphs everywhere in the grocery pass; two renderers disagreeing about the
// same number is the defect, and the grocery/mobile spelling is the one that
// wins because everything else already reads that way.
//
// The ruling asks to route through `formatQuantity` if it is reachable. IT IS
// NOT: that module lives in `artifacts/kiwi`, and nothing in `api-server/src`
// imports across that boundary (the server's build tree is bundled separately —
// see scripts/bundleExternals.mjs). So it is the same TABLE, deliberately
// spelled to match, and this comment is the link between the two copies. If one
// changes, change both.
function mixedNumber(whole: number, glyph: string | null): string {
  if (glyph === null) return String(whole);
  return whole > 0 ? `${whole}${glyph}` : glyph;
}

// Round UP to the nearest 1/8 and render as a mixed number ("¾", "1½", "2").
function toEighths(q: number): string {
  const eighths = Math.ceil(q * 8 - 1e-9); // fp guard so 0.5 → 4, not 5
  const whole = Math.floor(eighths / 8);
  const rem = eighths % 8;
  return mixedNumber(whole, rem === 0 ? null : EIGHTH_GLYPH[rem]);
}

// ── ruling 7, second half — A COUNT IS A GLYPH TOO ─────────────────────────
//
// `toCount` used to return the raw decimal for anything non-integer, which is
// where `0.25 bunch` and `0.5 each` came from (24 of them on the census). A
// count is not exempt from the app's own number rules: Hans's §8 asks for
// `¼ bunch` and `½ onion`.
//
// NEAREST-GLYPH, NOT ROUND-UP. `toEighths` deliberately rounds up because
// under-measuring a teaspoon spoils a dish; half an onion is an exact quantity
// and rounding it up to ⅝ would be a lie about the data. So this mirrors
// `formatQuantity`'s matchGlyph: a fractional part within ε of a known glyph
// prints that glyph, and anything else falls back to the decimal rather than
// inventing a fraction. ε and the glyph set are the mobile module's.
const COUNT_GLYPHS: ReadonlyArray<{ value: number; glyph: string }> = [
  { value: 1 / 8, glyph: "⅛" },
  { value: 1 / 4, glyph: "¼" },
  { value: 1 / 3, glyph: "⅓" },
  { value: 3 / 8, glyph: "⅜" },
  { value: 1 / 2, glyph: "½" },
  { value: 5 / 8, glyph: "⅝" },
  { value: 2 / 3, glyph: "⅔" },
  { value: 3 / 4, glyph: "¾" },
  { value: 7 / 8, glyph: "⅞" },
];
// Half the smallest gap between adjacent glyphs (⅓→⅜ and ⅝→⅔ are both 0.0417),
// so matches stay disjoint. Same constant as lib/format/quantity.ts.
const GLYPH_EPSILON = 0.02;

function toCount(q: number): string {
  const rounded = Math.round(q);
  if (Math.abs(q - rounded) < 1e-9) return String(rounded);
  const whole = Math.floor(q);
  const frac = q - whole;
  let best: { glyph: string; dist: number } | null = null;
  for (const { value, glyph } of COUNT_GLYPHS) {
    const dist = Math.abs(frac - value);
    if (dist <= GLYPH_EPSILON && (best === null || dist < best.dist)) best = { glyph, dist };
  }
  if (best === null) return String(Number(q.toFixed(2)));
  return mixedNumber(whole, best.glyph);
}

// ── ruling 7, third part — "each" IS NOT A WORD A COOK SAYS ────────────────
//
// `canonicalizeUnit` returns `each` for a bare count, and printing it produced
// "Dice 3 each roma tomatoes" — 135 of these on the census, the single largest
// P-R5 class. The unit token is dropped for the GENERIC count placeholders only,
// so the narrator writes "3 roma tomatoes" from the amount plus the ingredient
// name it already has.
//
// ⚠️ SPECIFIC count units keep their token and their F5.2 pluralisation:
// "3 cloves", "2 stalks", "¼ bunch" all carry information the ingredient name
// does not. `whole` is also kept — "1 whole chicken" means something. Only the
// placeholder goes.
const PLACEHOLDER_COUNT_UNITS: ReadonlySet<string> = new Set(["each", "ea", ""]);

// ── [grocery] F (F5.2) — A COUNT UNIT INFLECTS ─────────────────────────────
//
// Hans's device pass, item 18: the Prep the Week text read "Finely dice 3 stalk
// celery and transfer to a container". Nothing was wrong with the number or the
// noun — `canonicalizeUnit` returns the CANONICAL token, and the canonical
// token is the singular, so every count above one printed singular. The
// narrator echoes `formatMeasure`'s string verbatim ("prose can't move the
// math"), which is exactly why the grammar has to be right here and cannot be
// left to the model.
//
// ⚠️ ONLY THE COUNT BRANCH. The two branches above it are measure units and
// they stay invariant on purpose: "1 ½ cup" and "2 lb" are how a recipe is
// written, and "2 lbs" / "2 cups" would be a regression dressed as a fix. That
// is the same split COUNT_NOUN_PLURALS keeps on the client.
//
// `pluralizeCountUnit` is the INVERSE of the count-unit alias map
// ingredientConversions already owns — derived, not a second table.
export function formatMeasure(quantity: number, rawUnit: string): string {
  const { token } = canonicalizeUnit(rawUnit);
  if (EIGHTH_UNITS.has(token)) return `${toEighths(quantity)} ${token}`;
  if (WHOLE_UNITS.has(token)) return `${Math.max(1, Math.round(quantity))} ${token}`;
  const shown = toCount(quantity);
  // D-WS9-297 ruling 7 — the bare number for a placeholder count; the narrator
  // supplies the noun. `Number(shown)` is NaN for a glyph-only string like "¼",
  // so the quantity itself drives the pluralisation, not the rendered text.
  if (PLACEHOLDER_COUNT_UNITS.has(token)) return shown;
  return `${shown} ${pluralizeCountUnit(token, quantity)}`;
}

// One narration component per summed line of a group. The narrator writes from
// `measures[]` — the PER-DISH breakdown (WS7-8b FIX 1), each amount already
// fraction-formatted (FIX 2). Per-dish so nothing has to be re-portioned.
// D-WS9-049 A1.1 — the old reference-only `totalQuantity`/`unit`/`forMeals`
// (which the prompt already said to IGNORE) are no longer emitted; they only
// cost narration-input tokens. id-level attribution stays on the planned step.
// ── WS9 BUG-338 / D-WS9-297 ruling 8 — HOW MANY LIMES IS THAT ──────────────
//
// The census found every citrus in every plan counted twice: "Prep all limes"
// portions whole fruit, "Measure all lime juice: 3 tbsp + 2 tbsp + 2 tbsp" asks
// for juice, and nothing connects them. 14 of 14 plans; 5 of them never state a
// fruit count anywhere.
//
// `sourceYield` carries the `component` edge's magnitude (lime → lime juice :
// 3 tbsp), so the count is arithmetic the CODE can do — which is the whole point
// of the blended design. `convertWithinDimension` handles a demand stated in a
// different volume unit than the yield; a demand in an incompatible dimension
// (juice by weight) yields null and no hint is emitted.
//
// ROUNDED UP, always. You cannot buy 1.4 limes, and a cook told "2 limes" for
// 2.1 limes' worth of juice is short. The same direction `toEighths` rounds.
// 🔴 `pluralizeCountUnit` IS THE WRONG TOOL FOR THIS, and using it first is how
// this read "2 lime". That function inflects UNIT TOKENS from a closed table
// (clove → cloves, stalk → stalks); `fromName` is an ingredient NOUN and is not
// in it, so every count came back singular.
//
// `artifacts/kiwi/lib/format/grocery.ts` has the fuller `pluralizeNoun`, and the
// server cannot import it (same build boundary as `formatQuantity` — see
// `mixedNumber` above). This is the regular-plural subset, which is all the data
// needs: every ingredient carrying a `component` yield today is citrus, and
// lime/lemon/orange/grapefruit are all regular. An irregular noun would come back
// wrong, so if a yield is ever added for one, this is the function to widen.
function pluralizeSourceNoun(noun: string): string {
  const w = noun.trim();
  if (w.length === 0) return noun;
  if (/[^a-z]$/i.test(w)) return w; // ends in punctuation — not a noun to inflect
  if (/(?:s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

/**
 * ⚠️ D-WS9-301 rule 14 — NO LONGER PRINTED. "The source parenthetical goes from
 * every step — '3 cloves garlic', never '3 cloves garlic (from 1 garlic head)';
 * '3 celery stalks', never '(from 1 celery bunch)'. The count stays in the
 * grocery list where it belongs." Hans read it on the device and it is noise on
 * a prep card: the cook already bought the head.
 *
 * Kept because the ARITHMETIC is shared with `prepStepMinutes.wholeFruitCount`,
 * which needs to know that 3 tbsp of lime juice is two limes in order to cost
 * the squeezing. One copy of the sum, one of them no longer rendered.
 */
function sourceCountFor(
  sourceYield: PrepIngredientGroup["sourceYield"],
  quantity: number,
  unit: string,
): string | undefined {
  if (!sourceYield || !(sourceYield.quantity > 0)) return undefined;
  const { token: demandToken } = canonicalizeUnit(unit);
  const { token: yieldToken } = canonicalizeUnit(sourceYield.unit);
  let inYieldUnit: number | null;
  if (demandToken === yieldToken) {
    inYieldUnit = quantity;
  } else {
    inYieldUnit = convertWithinDimension(quantity, demandToken, yieldToken);
  }
  if (inYieldUnit === null || !Number.isFinite(inYieldUnit) || inYieldUnit <= 0) return undefined;
  // H2b — ONE copy of the arithmetic, shared with the timing. The prose and the
  // clock must not be able to disagree about how many limes a step needs.
  const count = wholeFruitCount(sourceYield, quantity, unit, (u) => canonicalizeUnit(u).token, convertWithinDimension);
  if (count === null) return undefined;
  return `${count} ${count === 1 ? sourceYield.fromName : pluralizeSourceNoun(sourceYield.fromName)}`;
}

/**
 * WS9 D-WS9-296 — `componentsOf`, minus the contributions a COMPONENT step has
 * already taken.
 *
 * 🔴 FILTERED PER (dish, ingredient), NOT PER INGREDIENT. The plan's garlic is
 * ONE ingredient group feeding four dishes; the carne asada's share goes into
 * its marinade bowl while the other three still need their own portions. An
 * entry-level skip would silently drop those three.
 */
function componentsOfUnclaimed(
  entry: PrepIngredientGroup,
  claimed: ReadonlySet<string>,
  destinationFor?: DestinationResolver,
): PrepNarrationComponent[] {
  const out: PrepNarrationComponent[] = [];
  for (const line of entry.lines) {
    const kept = line.contributions.filter(
      (c) => !claimed.has(`${c.dishId}|${entry.ingredientId}`),
    );
    if (kept.length === 0) continue;
    const prep = kept.find((c) => (c.preparationNote ?? "").trim() !== "")?.preparationNote;
    const measures: PrepMeasure[] = kept.map((c) => {
      return {
        amount: formatMeasure(c.quantity, c.unit),
        forDish: c.dishName,
        dishRole: c.dishRole,
        mealId: c.mealId,
        dishId: c.dishId,
        ingredientId: entry.ingredientId,
        qty: c.quantity,
        unit: c.unit,
        ...(destinationFor ? { destination: destinationFor(c.dishId, entry.ingredientId) } : {}),
          ...((c.preparationNote ?? "").trim()
          ? { preparationNote: (c.preparationNote ?? "").trim() }
          : {}),
      };
    });
    out.push({
      ingredientName: entry.ingredientName,
      ...(prep ? { preparationNote: prep } : {}),
      measures,
    });
  }
  return out;
}

function componentsOf(
  entry: PrepIngredientGroup,
  destinationFor?: DestinationResolver,
): PrepNarrationComponent[] {
  return entry.lines.map((line) => {
    const prep = line.contributions.find(
      (c) => (c.preparationNote ?? "").trim() !== "",
    )?.preparationNote;
    const measures: PrepMeasure[] = line.contributions.map((c) => {
      return {
        amount: formatMeasure(c.quantity, c.unit),
        forDish: c.dishName,
        dishRole: c.dishRole,
        mealId: c.mealId,
        dishId: c.dishId,
        ingredientId: entry.ingredientId,
        qty: c.quantity,
        unit: c.unit,
        ...(destinationFor ? { destination: destinationFor(c.dishId, entry.ingredientId) } : {}),
          ...((c.preparationNote ?? "").trim()
          ? { preparationNote: (c.preparationNote ?? "").trim() }
          : {}),
      };
    });
    return {
      ingredientName: entry.ingredientName,
      ...(prep ? { preparationNote: prep } : {}),
      measures,
    };
  });
}

// WS7-8b #5 — per-dishId-filtered sibling of componentsOf (the committed FIX 1
// per-entry builder above). Used ONLY by the grouped sauces_marinades dish-step
// path: given one ingredient group and a target dishId, emit components built
// from just that dish's contributions, so a sauce dish-step shows only its own
// wet parts. Sits BESIDE componentsOf (does not replace the committed path).
// D-WS9-049 A1.1 — like componentsOf, no longer emits the IGNORE-only
// totalQuantity/unit/forMeals; the narrator writes from measures[].
function componentsForDish(
  entry: PrepIngredientGroup,
  dishId: string,
  destinationFor?: DestinationResolver,
): PrepNarrationComponent[] {
  const out: PrepNarrationComponent[] = [];
  for (const line of entry.lines) {
    const contribs = line.contributions.filter((c) => c.dishId === dishId);
    if (contribs.length === 0) continue;
    const prep = contribs.find(
      (c) => (c.preparationNote ?? "").trim() !== "",
    )?.preparationNote;
    const measures: PrepMeasure[] = contribs.map((c) => {
      return {
        amount: formatMeasure(c.quantity, c.unit),
        forDish: c.dishName,
        dishRole: c.dishRole,
        mealId: c.mealId,
        dishId: c.dishId,
        ingredientId: entry.ingredientId,
        qty: c.quantity,
        unit: c.unit,
        ...(destinationFor ? { destination: destinationFor(c.dishId, entry.ingredientId) } : {}),
          ...((c.preparationNote ?? "").trim()
          ? { preparationNote: (c.preparationNote ?? "").trim() }
          : {}),
      };
    });
    out.push({
      ingredientName: entry.ingredientName,
      ...(prep ? { preparationNote: prep } : {}),
      measures,
    });
  }
  return out;
}

function mealIdsOf(entry: PrepIngredientGroup): string[] {
  return entry.lines.flatMap((l) => l.contributions.map((c) => c.mealId));
}

function dishIdsOf(entry: PrepIngredientGroup): string[] {
  return entry.lines.flatMap((l) => l.contributions.map((c) => c.dishId));
}

export function buildStepPlan(
  result: PrepCombineResult,
  planName: string,
  // WS7-8a B2b — raw step text per dishId (dish-owned + meal-owned folded in,
  // built by the route from the loader output). Re-keyed by dish name into the
  // narration input's shared `dishSteps` map (D-WS9-049 A1.2); each step then
  // references the dishes its ingredients are cooked in via `relevantDishes`.
  // Defaults to an empty map so callers/tests that don't need the skip rule
  // still work (→ empty relevantDishes, empty dishSteps).
  stepTextByDishId: Map<string, string[]> = new Map(),
  // D-WS9-297 ruling 13 — mealId → days from the prep session to that meal's cook
  // day. Built by the route from the loader's `prepDay` + each meal's
  // `assignedDate`. Defaults empty, so `loadPrepStepSet` (which only needs step
  // keys) and every existing test are untouched.
  cookLagByMealId: ReadonlyMap<string, number> = new Map(),
  /**
   * Part J.0 (A3) — Prep Selected Meals. The plan is built WHOLE — food identity,
   * shared cuts, container floors and names, the drop pass — and only then scoped
   * to these meals, so a subset step has the full plan's stepKey, container names
   * and per-dish quantities. Built over the subset alone, a food in only some
   * meals got a different key and the subset's ticks never reached `isPrepped`.
   */
  opts: { scopeMealIds?: ReadonlySet<string> } = {},
): StepPlan {
  const steps: PlannedStep[] = [];

  // ── H2b ruling 2 — THE YIELD LOOKUP THE CLOCK NEEDS ───────────────────────
  //
  // "3 tbsp lime juice" has to be costed as the TWO LIMES it takes to squeeze,
  // and `ingredient_relations` already knows that (D-WS9-194). The engine put the
  // edge on each group as `sourceYield`; this makes it reachable by ingredient
  // NAME, which is the only handle `timeStep` has on a narration component.
  const yieldByIngredientName = new Map<string, SourceYieldLike>();
  for (const phase of result.phases) {
    for (const entry of phase.entries) {
      if (entry.sourceYield) yieldByIngredientName.set(entry.ingredientName, entry.sourceYield);
    }
  }
  const yieldFor = (name: string) => {
    const y = yieldByIngredientName.get(name);
    if (!y) return null;
    return {
      yield: y,
      count: (q: number | null, u: string | null) =>
        wholeFruitCount(y, q, u, (x) => canonicalizeUnit(x).token, convertWithinDimension),
    };
  };

  // D-WS9-049 A1.2 — dish name ⇄ step text, so a dish's prose is sent ONCE
  // (input-level `dishSteps` map) and each step just references dish names.
  //   dishNameById   — dishId → dishName (first-seen across all contributions).
  //   dishStepsByName — dishName → its deduped step text (union across any
  //                     same-named dishIds). Only dishes WITH text appear.
  const dishNameById = new Map<string, string>();
  for (const phase of result.phases) {
    for (const entry of phase.entries) {
      for (const line of entry.lines) {
        for (const c of line.contributions) {
          if (!dishNameById.has(c.dishId)) dishNameById.set(c.dishId, c.dishName);
        }
      }
    }
  }
  const dishStepsByName = new Map<string, string[]>();
  for (const [dishId, texts] of stepTextByDishId) {
    const name = dishNameById.get(dishId);
    if (!name) continue; // dishId not present in this plan's contributions
    const clean = dedupe(texts);
    if (clean.length === 0) continue;
    const existing = dishStepsByName.get(name);
    dishStepsByName.set(name, existing ? dedupe([...existing, ...clean]) : clean);
  }

  // The dishes whose step text applies to a step === the dishes its ingredients
  // are cooked in, restricted to those that actually have text (so an empty
  // result still means "no step text → never demote", as before). Names, not
  // prose — the prose is looked up in dishSteps by the narrator.
  const relevantDishesFor = (dishIds: string[]): string[] =>
    dedupe(
      [...new Set(dishIds)]
        .map((dishId) => dishNameById.get(dishId))
        .filter((name): name is string => !!name && dishStepsByName.has(name)),
    );

  // ══ [prepcook] H7 — CONTAINERS BY CLASS AND COOKING MOMENT ═════════════════
  //
  // Hans, October 2: "Don't combine seasonings, oil, liquid with protein or
  // veggies until cook. Veggies + veggies is ok if they go in the pan together."
  //
  // This replaces the bucket / orphan passes D-WS9-296 through H6.7 built up,
  // which grouped by MOMENT alone and so put whatever entered together into one
  // bowl: romaine into the Caesar dressing jar, zucchini into its garlic oil,
  // tomato and cucumber into lemon juice, raw shrimp into lemon juice, raw thighs
  // into the slow cooker's vegetables, dry penne in with the broccoli. Measured on
  // the four plans Hans sent: 11 containers mixed classes.
  //
  // A container is now (dish, cooking moment, CLASS) — see prepClasses.ts:
  //
  //   A  seasonings + liquids  — group at any moment that is one: an authored
  //                              mixture (`c:`), a heat step (`s:`), the mise run
  //                              (`r:`), or, for a dish with no step signal at
  //                              all, the dish's dry or wet measures as before.
  //   B  vegetables            — group ONLY at a heat step (`s:`): "if they go in
  //                              the pan together". Never on a run, never in a
  //                              cold mixture, never at serve time.
  //   C  protein               — never a member of anything. Its own step, its
  //                              own close.
  //   aromatics                — join B when a vegetable enters with them, else
  //                              join A when a LIQUID does ("garlic whisked into
  //                              the lemon marinade"), else stand alone. Never a
  //                              dry blend: rule 2, "garlic, onion and fresh herbs
  //                              never join a dry blend", still holds.
  //
  // Floors, from D-WS9-299 and the ruling's table: a dry blend needs 3; a wet mix
  // needs 3, or 2 that must sit together (a marinade, a brine); vegetables need 2.
  // Below the floor a container dissolves and its members are single portions.
  //
  // Every cut portion that joins nothing lands in a labelled container of its own
  // — "<Dish> — <item, cut>" (2a) — or, when the same cut serves several dishes,
  // the shared tub rule 5 has always given it.

  interface Portion {
    dishId: string;
    dishName: string;
    mealName: string;
    mealIds: Set<string>;
    entry: PrepIngredientGroup;
    cls: PrepClass;
    wet: boolean;
    mk: string | null;
    component: IngredientComponent | null;
    notes: string[];
  }
  const portions = new Map<string, Portion>();
  for (const phase of result.phases) {
    for (const entry of phase.entries) {
      for (const line of entry.lines) {
        for (const c of line.contributions) {
          const k = `${c.dishId}|${entry.ingredientId}`;
          const have = portions.get(k);
          if (have) {
            have.mealIds.add(c.mealId);
            if ((c.preparationNote ?? "").trim() !== "") have.notes.push(c.preparationNote!.trim());
            continue;
          }
          portions.set(k, {
            dishId: c.dishId,
            dishName: c.dishName,
            mealName: c.mealName,
            mealIds: new Set([c.mealId]),
            entry,
            cls: classOf(entry.phase, entry.ingredientName),
            wet: isWetA(entry.phase, entry.ingredientName),
            // A component IS a moment, so a contribution carrying one but no
            // explicit `momentKey` still groups (engine-level fixtures build input
            // by hand; the adapter always sets both).
            mk: c.momentKey ?? (c.component ? `c:${c.component.key}` : null),
            component: c.component ?? null,
            notes: (c.preparationNote ?? "").trim() !== "" ? [c.preparationNote!.trim()] : [],
          });
        }
      }
    }
  }

  // ── 2c — WHICH PRODUCE PORTIONS ARE PREP AT ALL ─────────────────────────────
  //
  // Judged per portion and BEFORE grouping, so a container is never built around
  // something the cook will not touch on Sunday. The Garlic Herb Potatoes
  // container listed "potatoes already in it" after the narrator had moved the
  // potatoes to cook day; the engine now knows that first.
  const notPrep = new Map<string, string>();
  for (const [k, p] of portions) {
    if (p.entry.phase !== "produce") continue;
    // The recipe's own sentences count as much as the note: "Trim the ends off
    // green beans" is the only place the steamed beans' knife work is written.
    const v = judgeProducePortion(
      p.entry.ingredientName,
      p.notes.join(" "),
      !!p.entry.sourceYield,
      stepTextByDishId.get(p.dishId) ?? [],
    );
    if (!v.prep) notPrep.set(k, v.reason);
  }
  // Part J.1 (R2) — the Tetrazzini "sauce jar" held the spaghetti: a dry pasta is
  // measured from the box into the pot on cook day, never into a container.
  for (const [k, p] of portions) {
    if (p.entry.phase === "seasonings_dry" && DRY_PASTA.test(p.entry.ingredientName) && !/\bsauce\b/i.test(p.entry.ingredientName)) {
      notPrep.set(k, "ready-to-use");
    }
  }

  // ── RULE 5, SCOPED TO THE CUT ──────────────────────────────────────────────
  //
  // "A chopped ingredient used by several dishes goes in ONE container, labelled
  // with its dishes." It is the same CUT that makes one tub: the chicken soup's
  // halved onion is not the broccoli soup's diced onion, and treating every onion
  // on the plan as shared kept the halved one out of the soup's own pot.
  const cutGroups = new Map<string, Set<string>>();
  for (const p of portions.values()) {
    const ck = `${p.entry.ingredientId}|${cutOf(p.notes) ?? ""}`;
    const s = cutGroups.get(ck) ?? new Set<string>();
    s.add(p.dishId);
    cutGroups.set(ck, s);
  }
  const sharedCut = (p: Portion) =>
    (cutGroups.get(`${p.entry.ingredientId}|${cutOf(p.notes) ?? ""}`)?.size ?? 0) > 1;

  // ── H7.1 2a — A COLD RAW MIXTURE IS ONE CONTAINER OF ITS CUT VEGETABLES ─────
  //
  // Hans, October 3: "account for the need to marinade, or mix cole slaw, or whatever
  // else ahead of time that does combine stuff." Pico, slaw, a chopped salad, a tuna-
  // salad base: the recipe combines the cut vegetables RAW, with no pan, so the cook
  // wants them in one tub — "Fresh Pico de Gallo — tomato, onion, jalapeño, cilantro".
  // H7's B-only-at-heat rule split them one lid per item (425da049: 16 → 31).
  //
  // A dish qualifies when one of its steps combines cold (a mixing verb, no heat word)
  // and it has two or more cut, non-leafy produce portions — at least one a vegetable
  // — that no heat step places. Leafy greens keep their own container (they wilt
  // against wet vegetables), and the dressing, acid and salt stay class A: whether
  // they go in now or on cook day depends on the day, so the storage overlay says it.
  //
  // 🔴 Part J.1 (R2) — THE RAW MIX IS KEYED ON THE COMPONENT, NOT THE DISH. Hans,
  // October 3: "pico stays in the fridge and goes on top." A pico, slaw, salsa or
  // crema is one mixed bowl whatever the dish around it does with heat, and a
  // component that has ANY heat step of its own is never one, whatever its combine
  // step says (the roasted green beans' "toss"). A dish with no component tags is a
  // raw mix only when none of its own steps has heat.
  const cookedDishes = new Set<string>();
  for (const [dishId, texts] of stepTextByDishId) {
    if (texts.some((t) => HEAT_TEXT.test(t))) cookedDishes.add(dishId);
  }
  const coldDishes = new Set<string>();
  for (const [dishId, texts] of stepTextByDishId) {
    if (!cookedDishes.has(dishId) && texts.some((t) => COLD_COMBINE.test(t))) coldDishes.add(dishId);
  }
  /** Portion key → a container formed before the moment grouping (2a, 2c, 2d, R2). */
  const special = new Map<string, string>();
  type SpecialKind = "cold" | "greens" | "herbs" | "chiles" | "plate";
  const specialSpec = new Map<string, { cls: "A" | "B"; label: string; members: Portion[]; kind: SpecialKind }>();
  const unplaced = (p: Portion) => p.mk === null || /^(?:i|r|c):/.test(p.mk);
  /** Part J.1 §2 — a dish's citrus whose juice it also takes: zest and juice share one tub. */
  const citrusWithJuice = (p: Portion) =>
    CITRUS.test(p.entry.ingredientName) &&
    !/\bjuice\b/i.test(p.entry.ingredientName) &&
    [...portions.values()].some(
      (q) => q !== p && q.dishId === p.dishId && /\bjuice\b/i.test(q.entry.ingredientName) &&
        foodKeyOf(q.entry.ingredientName, q.entry.sourceYield) === foodKeyOf(p.entry.ingredientName, p.entry.sourceYield),
    );
  {
    /** group key → its members and the bowl's name. */
    const mixes = new Map<string, { dishId: string; name: string; list: Portion[] }>();
    for (const [k, p] of portions) {
      if (notPrep.has(k) || (p.cls !== "B" && p.cls !== "aromatic")) continue;
      if (p.mk !== null && p.mk.startsWith("s:")) continue; // placed into heat
      if (citrusWithJuice(p)) continue;
      let gk: string;
      let name: string;
      if (p.component) {
        if (p.component.heated) continue;
        gk = `${p.dishId}|c:${p.component.key}`;
        const noun = p.component.noun;
        const head = noun && !new RegExp(`\\b${noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(p.dishName)
          ? `${p.dishName} ${noun}`
          : p.dishName;
        name = `${head} bowl`;
      } else {
        if (isServedSeparately(p.dishName) || !coldDishes.has(p.dishId)) continue;
        gk = `${p.dishId}|cold`;
        name = `${p.dishName} bowl`;
      }
      const m = mixes.get(gk) ?? { dishId: p.dishId, name, list: [] };
      m.list.push(p);
      mixes.set(gk, m);
    }
    for (const [gk, { name, list }] of mixes) {
      const greens = list.filter((p) => LEAFY.test(p.entry.ingredientName));
      const mix = list.filter((p) => !LEAFY.test(p.entry.ingredientName));
      if (mix.length >= 2 && mix.some((p) => p.cls === "B")) {
        const key = `${gk}|cold|B`;
        specialSpec.set(key, { cls: "B", kind: "cold", members: mix, label: name });
        for (const p of mix) special.set(`${p.dishId}|${p.entry.ingredientId}`, key);
        // The greens of a dish that IS a mixture share one container of their own.
        if (greens.length >= 2) {
          const gkey = `${gk}|greens|B`;
          specialSpec.set(gkey, { cls: "B", kind: "greens", members: greens, label: containerLabel(greens[0].dishName, ["greens"]) });
          for (const p of greens) special.set(`${p.dishId}|${p.entry.ingredientId}`, gkey);
        }
      }
    }
  }
  // ── Part J.1 (R2) — ONE TOPPINGS PLATE PER DISH ─────────────────────────────
  //
  // Hans: "garnish and toppings sit on a small plate in the fridge under plastic
  // wrap." A dish's toppings and garnishes — leafy ones included — are separate
  // piles on ONE covered plate, not a lid each (H5.1's one-container-per-topping,
  // replaced). A topping is a raw produce portion the dish serves on top: its note
  // says so, or the dish IS the toppings. Citrus wedges stay cook-day (rule 7).
  {
    const byDish = new Map<string, Portion[]>();
    for (const [k, p] of portions) {
      if (notPrep.has(k) || special.has(k) || p.entry.phase !== "produce") continue;
      if (p.cls !== "B" && p.cls !== "aromatic") continue;
      if (p.mk !== null && p.mk.startsWith("s:")) continue;
      const notes = p.notes.join(" ");
      if (/\bwedges?\b/i.test(notes)) continue;
      if (!isServedSeparately(p.dishName) && !TOPPING_NOTE.test(notes)) continue;
      const l = byDish.get(p.dishId) ?? [];
      l.push(p);
      byDish.set(p.dishId, l);
    }
    for (const [dishId, list] of byDish) {
      const key = `${dishId}|plate|B`;
      const dish = list[0].dishName;
      specialSpec.set(key, {
        cls: "B",
        kind: "plate",
        members: list,
        label: /\b(toppings?|garnish(?:es)?|fixin'?s|fixings)\b/i.test(dish) ? `${dish} plate` : `${dish} toppings plate`,
      });
      for (const p of list) special.set(`${p.dishId}|${p.entry.ingredientId}`, key);
    }
  }
  // ── H7.1 2d — DRIED CHILES ARE NOT GROUND SPICES ─────────────────────────────
  //
  // The chili's anchos, guajillos and chipotle are toasted and soaked at cook time —
  // a different moment from the cumin and oregano — so they go in their own bag,
  // stemmed and seeded, and never into the spice blend. Knife work, so no 3-floor.
  {
    const byDish = new Map<string, Portion[]>();
    for (const [k, p] of portions) {
      if (p.cls !== "A" || p.wet || !DRIED_CHILE.test(p.entry.ingredientName) || special.has(k)) continue;
      const l = byDish.get(p.dishId) ?? [];
      l.push(p);
      byDish.set(p.dishId, l);
    }
    for (const [dishId, list] of byDish) {
      const key = `${dishId}|chiles|A`;
      specialSpec.set(key, {
        cls: "A",
        kind: "chiles",
        members: list,
        // J.1 (R2) — named by class and form, never a `<dish> — <contents>` label: the
        // bag has a step of its own, and its opening line printed the raw label
        // ("Into the Texas-Style Beef Chili — dried chiles, stemmed and seeded:").
        label: `${list[0].dishName} dried-chile bag`,
      });
      for (const p of list) special.set(`${p.dishId}|${p.entry.ingredientId}`, key);
    }
  }

  /** The grouping key a portion's moment allows, or null when it groups nothing. */
  const groupKeyOf = (p: Portion): string | null => {
    if (p.cls === "C") return null;
    if (special.has(`${p.dishId}|${p.entry.ingredientId}`)) return null;
    if (isServedSeparately(p.dishName)) return null;
    const mk = p.mk;
    if (mk !== null && mk.startsWith("v:")) return null;
    // A dish with no step signal at all (`i:`, or no key — an engine-level caller
    // that never ran the adapter) keeps the one grouping it always had: its dry
    // measures together and its wet measures together. Nothing else of it groups,
    // because nothing says what enters with what.
    if (mk === null || mk.startsWith("i:")) return p.cls === "A" ? `i*${p.wet ? "wet" : "dry"}` : null;
    return mk;
  };

  interface Container {
    key: string;
    dishId: string;
    dishName: string;
    mealName: string;
    cls: "A" | "B";
    members: Map<string, Portion>;
    noun: string | null;
    authoredName: string | null;
    name: string;
    /** H7.1 — a container formed by 2a/2c/2d carries its label from the start. */
    fixedName?: string;
  }
  const containers = new Map<string, Container>();
  const groups = new Map<string, Portion[]>();
  for (const [k, p] of portions) {
    if (notPrep.has(k)) continue;
    const gk = groupKeyOf(p);
    if (gk === null) continue;
    const l = groups.get(`${p.dishId}|${gk}`) ?? [];
    l.push(p);
    groups.set(`${p.dishId}|${gk}`, l);
  }
  /** Which container class a portion would join in its group, or null. */
  const targetOf = (p: Portion, group: Portion[], gk: string): "A" | "B" | null => {
    // Part J.1 (R2) — a heated component is a pan or oven moment of its own: its
    // vegetables go in together, whatever words its combine step used.
    const heat = gk.startsWith("s:") || (gk.startsWith("c:") && group.some((q) => q.component?.heated === true));
    if (p.cls === "A") return "A";
    if (p.cls === "B") return heat ? "B" : null;
    // An aromatic goes into the pan with the vegetables it is cooked with; failing
    // that, into a LIQUID it is whisked into ("garlic whisked into the lemon
    // marinade"); failing that, it stands alone. Never into a dry blend (rule 2).
    if (heat && group.some((q) => q.cls === "B")) return "B";
    if (group.some((q) => q.cls === "A" && q.wet)) return "A";
    // Aromatics are produce: two or more going onto the same tray with nothing else
    // to join (the herb potatoes' rosemary, garlic and thyme — the potatoes are cut
    // on cook day) share one container, like any vegetables into the pan together.
    if (heat) return "B";
    return null;
  };
  const deferred: { p: Portion; ck: string }[] = [];
  for (const [gKey, group] of groups) {
    const gk = gKey.slice(gKey.indexOf("|") + 1);
    for (const p of group) {
      const t = targetOf(p, group, gk);
      if (t === null) continue;
      const ck = `${gKey}|${t}`;
      // Rule 5 beats rule 1 for a SHARED cut: it joins its dish's container only
      // once that container exists on its own, below. An authored mixture still
      // claims its share at once (D-WS9-296, ratified). 🔴 KNIFE WORK ONLY: rule 5
      // is one tub of diced onion for three dishes. A measure is never pooled across
      // dishes — the cumin for the braise and for the rub are two dishes' blends.
      if (p.cls !== "A" && sharedCut(p) && !gk.startsWith("c:")) {
        deferred.push({ p, ck });
        continue;
      }
      const c = containers.get(ck) ?? {
        key: ck,
        dishId: p.dishId,
        dishName: p.dishName,
        mealName: p.mealName,
        cls: t,
        members: new Map<string, Portion>(),
        noun: null,
        authoredName: null,
        name: "",
      };
      c.members.set(p.entry.ingredientId, p);
      // The author's name only when the author NAMED a mixture: a component with no
      // noun carries a generated fallback ("Tuna Melts prep container"), which says
      // nothing about what is in it now that the class split has run.
      if (p.component?.noun && t === "A" && c.authoredName === null) {
        c.authoredName = p.component.bowlName;
        c.noun = p.component.noun;
      }
      containers.set(ck, c);
    }
  }
  const allDryA = (c: Container) =>
    c.cls === "A" && [...c.members.values()].every((p) => p.cls === "A" && !p.wet);
  const meetsFloor = (c: Container): boolean => {
    const n = c.members.size;
    if (c.cls === "B") return n >= 2;
    if (allDryA(c)) return n >= 3;
    return n >= 3 || (n >= 2 && c.noun !== null && mustSit(c.noun));
  };
  for (const [ck, c] of [...containers]) if (!meetsFloor(c)) containers.delete(ck);
  for (const { p, ck } of deferred) {
    const c = containers.get(ck);
    if (c) c.members.set(p.entry.ingredientId, p);
  }

  // ── H7.1 2c — A DISH'S UNPLACED AROMATICS SHARE ONE CONTAINER ────────────────
  //
  // Herb Roasted Potatoes (425da049) printed three herb tubs because the recipe never
  // names the step its rosemary, thyme and garlic enter — the H6.2 shape for unplaced
  // members: they go together, in one container for the dish.
  {
    const inAny = (p: Portion) => {
      const k = `${p.dishId}|${p.entry.ingredientId}`;
      return special.has(k) || [...containers.values()].some((c) => c.members.get(p.entry.ingredientId) === p);
    };
    const byDish = new Map<string, Portion[]>();
    for (const [k, p] of portions) {
      if (p.cls !== "aromatic" || notPrep.has(k) || sharedCut(p) || isServedSeparately(p.dishName)) continue;
      if (!unplaced(p) || inAny(p)) continue;
      const l = byDish.get(p.dishId) ?? [];
      l.push(p);
      byDish.set(p.dishId, l);
    }
    for (const [dishId, list] of byDish) {
      if (list.length < 2) continue;
      const key = `${dishId}|herbs|B`;
      const allHerbs = list.every((p) => FRESH_HERB.test(p.entry.ingredientName));
      specialSpec.set(key, {
        cls: "B",
        kind: "herbs",
        members: list,
        label: containerLabel(list[0].dishName, [allHerbs ? "herbs" : "aromatics"]),
      });
      for (const p of list) special.set(`${p.dishId}|${p.entry.ingredientId}`, key);
    }
  }
  /** H7.1 — the kind of each special container, by its final name, for the overlay. */
  const specialKindByName = new Map<string, SpecialKind>();
  for (const [key, s] of specialSpec) {
    const c: Container = {
      key,
      dishId: s.members[0].dishId,
      dishName: s.members[0].dishName,
      mealName: s.members[0].mealName,
      cls: s.cls,
      members: new Map(s.members.map((p) => [p.entry.ingredientId, p])),
      noun: null,
      authoredName: null,
      name: "",
      fixedName: s.label,
    };
    containers.set(key, c);
  }

  // ── NAMES — dish + use, never a number (rule 8) ───────────────────────────
  const usedNames = new Set<string>();
  const uniqueName = (base: string): string => {
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base} ${n++}`;
    usedNames.add(name);
    return name;
  };
  const vegContainersPerDish = new Map<string, number>();
  for (const c of containers.values()) {
    if (c.cls === "B" && !c.fixedName) vegContainersPerDish.set(c.dishId, (vegContainersPerDish.get(c.dishId) ?? 0) + 1);
  }
  for (const c of containers.values()) {
    const dry = allDryA(c);
    let name: string;
    if (c.fixedName) {
      name = c.fixedName;
    } else if (c.cls === "B") {
      name = bowlNameFor(c.dishName, c.mealName, null, 0, false, false, "vegetables");
      // Two vegetable containers for one dish go into the pot at two different
      // moments (the soup's onion with the chicken, its carrots and celery 20
      // minutes later), so the lid says WHICH: what is in it, never a number.
      if ((vegContainersPerDish.get(c.dishId) ?? 0) > 1) {
        const what = [...c.members.values()].map((p) => p.entry.ingredientName.toLowerCase());
        name = containerLabel(name.replace(/ vegetables$/, ""), [listOf(what)]);
      }
    } else {
      // 🔴 Part J.1 (R2) — THE NAME COMES FROM THE CLASS AND THE FORM, NEVER FROM A
      // GUESS: spice blend · dry mix · sauce jar · marinade bowl. An authored noun
      // ("glaze", "mix-ins", "dough") is not the vessel, and the Tetrazzini "sauce
      // jar" that held spaghetti, flour and panko was named by one.
      const names = [...c.members.values()].map((p) => p.entry.ingredientName).join(" ");
      const marinade = c.noun === "marinade" || (c.noun !== null && mustSit(c.noun)) || /\bmarinade\b/i.test(c.authoredName ?? "");
      // A marinade first: its liquid is often squeezed in the produce phase, so its
      // own phase-1 members read dry, and it is still the bowl the steak meets.
      const use = marinade ? "marinade bowl" : dry ? (DRY_MIX_MEMBER.test(names) ? "dry mix" : "spice blend") : "sauce jar";
      name = bowlNameFor(c.dishName, c.mealName, null, 0, false, false, use);
    }
    c.name = uniqueName(name);
  }

  /** The mixture noun a container carries, for the closing verb (2f). */
  const nounByBowl = new Map<string, string | null>();
  for (const c of containers.values()) nounByBowl.set(c.name, c.noun);
  for (const [key, s] of specialSpec) specialKindByName.set(containers.get(key)!.name, s.kind);

  /** `${dishId}|${ingredientId}` → the container it is a member of. */
  const containerOf = new Map<string, Container>();
  for (const c of containers.values()) {
    for (const p of c.members.values()) containerOf.set(`${p.dishId}|${p.entry.ingredientId}`, c);
  }
  /**
   * D-WS9-296 / rule 11(c) — the members whose work happens IN the container (the
   * dry measure, the wet pour) are taken out of the per-dish steps. Knife work is
   * never claimed: it is done in its food's own produce step, with the container as
   * the named destination.
   */
  const claimed = new Set<string>();
  for (const [k, c] of containerOf) {
    const ph = c.members.get(k.slice(k.indexOf("|") + 1))!.entry.phase;
    if (ph === "seasonings_dry" || ph === "sauces_marinades") claimed.add(k);
  }

  // ── 2a — EVERY CUT PORTION LANDS IN A LABELLED CONTAINER ────────────────────
  //
  // H6.2's one-portion floor printed "their own portion" and "no destination
  // container needed" on the sample plan: a diced jalapeño that joins nothing
  // still has to go somewhere, and "somewhere" has to be written on a lid.
  //   • the same cut for SEVERAL dishes → one tub, labelled with its dinners (rule 5);
  //   • anything else → "<Dish> — <item, cut>".
  // Only knife work gets one. A no-work item is off the list (H6.2), and an A
  // measure that joins nothing is not prep at all (2c).
  const tubLabel = new Map<string, string>();
  /** Part J.1 §2 — rule 5's labels, which a sentence calls "the shared … tub". */
  const sharedTubLabels = new Set<string>();
  {
    const byEntry = new Map<string, Portion[]>();
    for (const [k, p] of portions) {
      // A squeezed juice is board work too: it gets a lid like any cut.
      if (p.cls === "C" || (p.cls === "A" && p.entry.phase !== "produce")) continue;
      if (notPrep.has(k) || containerOf.has(k)) continue;
      const l = byEntry.get(p.entry.ingredientId) ?? [];
      l.push(p);
      byEntry.set(p.entry.ingredientId, l);
    }
    for (const list of byEntry.values()) {
      const byCut = new Map<string, Portion[]>();
      for (const p of list) {
        const cut = cutOf(p.notes) ?? "";
        const l = byCut.get(cut) ?? [];
        l.push(p);
        byCut.set(cut, l);
      }
      for (const [cut, group] of byCut) {
        const item = group[0].entry.ingredientName;
        const noun = cut ? `${cut} ${item}` : item;
        // Rule 5's tub takes every dish wanting this cut, served-separately ones
        // included — the cilantro for the enchiladas, the chili fixings and the taco
        // toppings is one tub, as it was in H6. A served-separately dish's OTHER items
        // still never pool with each other (H5.1): each gets its own lid below.
        const dishes = [...new Set(group.map((p) => p.dishName))];
        for (const p of group) {
          const label =
            dishes.length > 1 ? containerLabel(upperFirst(noun), dishes, true) : containerLabel(p.dishName, [noun]);
          tubLabel.set(`${p.dishId}|${p.entry.ingredientId}`, label);
          if (dishes.length > 1) sharedTubLabels.add(label);
        }
      }
    }
  }

  // ── Part J.1 §2 — ONE CITRUS, ONE TUB ─────────────────────────────────────────
  //
  // Shrimp Tacos zested a lime into one tub and squeezed its juice into another. One
  // dish's zest and juice of one fruit go together: "Shrimp Tacos — lime zest and
  // juice". A shared tub (several dishes) is rule 5's and stays as it is.
  {
    const groupsByFruit = new Map<string, string[]>();
    for (const [k, p] of portions) {
      const lab = tubLabel.get(k);
      if (!lab || !CITRUS.test(p.entry.ingredientName) || !lab.startsWith(`${p.dishName} — `)) continue;
      const g = `${p.dishId}|${foodKeyOf(p.entry.ingredientName, p.entry.sourceYield)}`;
      groupsByFruit.set(g, [...(groupsByFruit.get(g) ?? []), k]);
    }
    for (const keys of groupsByFruit.values()) {
      if (keys.length < 2) continue;
      const p = portions.get(keys[0])!;
      const fruit = (CITRUS.exec(keys.map((k) => portions.get(k)!.entry.ingredientName).join(" "))?.[1] ?? "citrus").replace(/s$/, "").toLowerCase();
      const label = containerLabel(p.dishName, [`${fruit} zest and juice`]);
      for (const k of keys) tubLabel.set(k, label);
    }
  }

  const destinationFor: DestinationResolver = (dishId, ingredientId) => {
    if (ingredientId === null) return undefined;
    const k = `${dishId}|${ingredientId}`;
    return containerOf.get(k)?.name ?? tubLabel.get(k);
  };

  // ── D-WS9-296 ruling 1 — the raw protein's cook-day step ─────────────────
  //
  // "On cook day: 1½ lb skirt steak into the Carne asada marinade bowl (a
  // zip-top bag works)." The sentence is the ENGINE's, because it states a fact
  // about the schedule; the model may not move it.
  // 🔴 H7 — ONLY INTO A BOWL THAT STILL EXISTS. The Alfredo's chicken was told to go
  // "into the Chicken and Broccoli Alfredo seasoning" on cook day — a two-item blend
  // the floor had dissolved — and the line replaced the chicken's own step. The
  // component's name is resolved to the container's final name, or dropped.
  const liveBowl = new Map<string, string>();
  for (const c of containers.values()) {
    if (c.authoredName) liveBowl.set(`${c.dishId}|${c.authoredName}`, c.name);
  }
  const cookDayByDishIngredient = new Map<string, string>();
  for (const phase of result.phases) {
    for (const entry of phase.entries) {
      for (const line of entry.lines) {
        for (const c of line.contributions) {
          const bowl = c.cookDayInto ? liveBowl.get(`${c.dishId}|${c.cookDayInto}`) : undefined;
          if (bowl) cookDayByDishIngredient.set(`${c.dishId}|${entry.ingredientId}`, bowl);
        }
      }
    }
  }

  // ── H7.1 2a / 2b — WHAT THE OVERLAY NEEDS TO SAY "NOW" OR "ON COOK DAY" ───────
  //
  // Whether a cold mixture's dressing goes in at prep, and whether the chicken joins
  // its marinade at prep, both depend on the COOK DAY — so neither may move a
  // container or a word of the cached prose (D-WS9-298). The plan records the facts;
  // `applyStorageOverlay` turns them into a sentence on every read.
  const containerExtras = new Map<string, ContainerExtra>();
  const proteinJoin = new Map<string, MarinadeJoin & { bowl: string }>();
  for (const c of containers.values()) {
    if (specialKindByName.get(c.name) !== "cold") continue;
    const partners = [...containers.values()]
      .filter((o) => o.dishId === c.dishId && o.cls === "A" && specialKindByName.get(o.name) !== "chiles")
      .map((o) => o.name);
    for (const [k, p] of portions) {
      if (p.dishId === c.dishId && p.cls === "A" && p.entry.phase === "produce" && tubLabel.has(k)) {
        partners.push(tubLabel.get(k)!);
      }
    }
    if (partners.length > 0) containerExtras.set(c.name, { combineWith: dedupe(partners) });
  }
  for (const c of containers.values()) {
    if (c.cls !== "A") continue;
    const isMarinade = c.noun === "marinade" || /\bmarinade\b/i.test(c.name) || (c.noun !== null && mustSit(c.noun));
    if (!isMarinade) continue;
    const texts = stepTextByDishId.get(c.dishId) ?? [];
    const marinates = texts.some((t) => MARINATES.test(t));
    // Part J.1 §2 — the window the recipe itself states, when it states one.
    const stated = marinadeWindow(texts);
    const memberNames = [...c.members.values()].map((p) => p.entry.ingredientName).join(" ");
    const acidic = ACIDIC.test(memberNames);
    const joins: (MarinadeJoin & { protein: string })[] = [];
    for (const [k, p] of portions) {
      if (p.dishId !== c.dishId || p.cls !== "C") continue;
      const name = p.entry.ingredientName;
      const named =
        cookDayByDishIngredient.get(k) === c.name ||
        texts.some((t) => t.split(/[.;]/).some((s) => /\bmarinade|\bmarinat/i.test(s) && proseNames(s, name)));
      if (!named) continue;
      const j = { marinates, seafood: SEAFOOD.test(name), acidic, ...stated, proteinStepKey: `proteins#${p.entry.ingredientId}` };
      joins.push({ protein: name, ...j });
      proteinJoin.set(k, { bowl: c.name, ...j });
    }
    if (joins.length > 0) containerExtras.set(c.name, { ...(containerExtras.get(c.name) ?? {}), joins });
  }

  for (const phase of result.phases) {
    const key = phase.phase;
    const entries = phase.entries; // include + uncertain only (excluded dropped)
    if (entries.length === 0) continue;

    let number = 0;
    const pushStep = (
      step: Omit<PlannedStep, "stepId" | "number" | "phase" | "estimatedMinutes">,
      forceDemote?: string,
    ): void => {
      number += 1;
      // WS9 BUG-204 — the clock, computed from what the step holds. Done here so
      // EVERY step gets one by construction and no branch can forget.
      const timing = timeStep({ components: step.components, bowlName: step.bowlName }, yieldFor);
      // D-WS9-301 rule 12 — the action, for a whole-protein step.
      const knifeVerbs =
        key === "proteins" && !step.cookDaySentence
          ? proteinVerbsFor(
              step.components.map((c) => c.preparationNote ?? "").join(" "),
              step.relevantDishes.flatMap((d) => dishStepsByName.get(d) ?? []).join(" "),
            )
          : [];
      // D-WS9-297 ruling 13 — the LATEST cook day this step has to survive to.
      const lags = step.contributesToMealIds
        .map((id) => cookLagByMealId.get(id))
        .filter((n): n is number => n !== undefined);
      const planned: PlannedStep = {
        stepId: `${key}#${number}`,
        phase: key,
        number,
        ...step,
        estimatedMinutes: timing.minutes,
        ...(knifeVerbs.length > 0 ? { knifeVerbs } : {}),
        ...(timing.overCap ? { minutesOverCap: true } : {}),
        ...(lags.length > 0 ? { daysUntilCook: Math.max(...lags) } : {}),
      };
      // ── 2c — THE ENGINE DECIDES WHAT IS PREP, AND NOTHING OVERRULES IT ──────
      //
      // The narrator used to: it demoted the pork chops' five-item breading, the
      // green-bean trimming and the cutlet pounding, and kept "Brown the Italian
      // sausage". Its flag is now ignored (assemblePrepWeekResult), and this is the
      // only place a step is judged.
      const notes = planned.components.flatMap((c) => [
        c.preparationNote ?? "",
        ...c.measures.map((m) => m.preparationNote ?? ""),
      ]);
      if (planned.fixedProse || planned.cookDaySentence) {
        // the wash, a cook-day line — not prep work, never judged
      } else if (forceDemote) {
        planned.demoted = { reason: forceDemote };
      } else if (key === "proteins") {
        const prose = planned.relevantDishes.flatMap((d) => dishStepsByName.get(d) ?? []);
        const worked = planned.components.some((c) =>
          judgeProteinWork(knifeVerbs, notes, prose, c.ingredientName),
        );
        if (!worked) planned.demoted = { reason: "heat-or-no-knife-work" };
      }
      steps.push(planned);
    };

    // ── D-WS9-301 rule 10 — the produce phase opens with the wash ──────────
    if (key === "produce") {
      const everyMealHere = dedupe(
        entries.flatMap((e) =>
          e.lines.flatMap((l) => l.contributions.map((c) => c.mealId)),
        ),
      );
      if (everyMealHere.length > 0) {
        number += 1;
        steps.push({
          stepId: `${key}#${number}`,
          stepKey: WASH_STEP_KEY,
          phase: key,
          number,
          ingredientId: null,
          contributesToMealIds: everyMealHere,
          isBlend: false,
          estimatedMinutes: WASH_STEP_MINUTES,
          components: [],
          relevantDishes: [],
          // Nothing is portioned into anything, so it is not a container.
          holdsNoContainer: true,
          fixedProse: { title: WASH_STEP_TITLE, instructions: WASH_STEP_INSTRUCTIONS },
        });
      }
    }

    // ── A containers: one step per container per phase it has work in ──────
    //
    // The dry measures in phase 1, the poured liquids in phase 3. Its produce
    // members (aromatics, squeezed juice) are cut in their own food's step with
    // this container as the destination — rule 11(c). A B container has no step of
    // its own at all: every member is knife work.
    if (key === "seasonings_dry" || key === "sauces_marinades") {
      for (const c of containers.values()) {
        if (c.cls !== "A") continue;
        const mine = [...c.members.values()].filter((p) => p.entry.phase === key);
        if (mine.length === 0) continue;
        // A dish with no step signal (`i*`) keeps the per-dish key its blend always had
        // (BUG-016 / D-WS7-187), so a stored tick does not move for nothing.
        const legacy = c.key.slice(c.dishId.length + 1).startsWith("i*");
        pushStep({
          // 🔴 THE SCHEMA CAPS stepKey AT 80 CHARS: `cnt#` + 4 + `#` + 62.
          stepKey: legacy ? `${key}#dish#${c.dishId}` : `cnt#${key.slice(0, 4)}#${c.key.slice(0, 62)}`,
          containerId: c.key,
          ingredientId: null,
          contributesToMealIds: dedupe(mine.flatMap((p) => [...p.mealIds])),
          // A mixture IS a blend in the narrator's sense — one pre-measure
          // action into one vessel — whatever phase it sits in.
          isBlend: true,
          components: mine.flatMap((p) => componentsForDish(p.entry, c.dishId, destinationFor)),
          relevantDishes: relevantDishesFor([c.dishId]),
          bowlName: c.name,
        });
      }
      // ── What is left is not prep (2c) ───────────────────────────────────
      //
      // Every dry or wet measure that belongs to a container was claimed above. A
      // measure still here joined nothing: one spice, one oil, two things that go
      // in at different moments. It stays on the plan as a demoted line so the
      // census can read it, and the cook's screen never shows it.
      const dishOrder: string[] = [];
      const entriesByDish = new Map<string, PrepIngredientGroup[]>();
      for (const entry of entries) {
        for (const dishId of [...new Set(dishIdsOf(entry))]) {
          if (claimed.has(`${dishId}|${entry.ingredientId}`)) continue;
          let list = entriesByDish.get(dishId);
          if (!list) {
            list = [];
            entriesByDish.set(dishId, list);
            dishOrder.push(dishId);
          }
          list.push(entry);
        }
      }
      for (const dishId of dishOrder) {
        const dishEntries = entriesByDish.get(dishId)!;
        const components = dishEntries.flatMap((e) => componentsForDish(e, dishId));
        const measured = components.reduce((n, cpt) => n + cpt.measures.length, 0);
        pushStep(
          {
            // `#left#`, not `#dish#`: the per-dish key belongs to a no-signal dish's
            // blend container above, and these lines are never required anyway.
            stepKey: `${key}#left#${dishId}`,
            ingredientId: null,
            contributesToMealIds: dedupe(
              dishEntries.flatMap((e) =>
                e.lines.flatMap((l) => l.contributions.filter((x) => x.dishId === dishId).map((x) => x.mealId)),
              ),
            ),
            isBlend: key === "seasonings_dry",
            components,
            relevantDishes: relevantDishesFor([dishId]),
          },
          measured <= 1 ? "single-item" : "below-floor-or-not-one-moment",
        );
      }
      continue;
    }

    // ── D-WS9-296 ruling 1 — the raw proteins that JOIN a bowl on cook day ──
    if (key === "proteins") {
      // 🔴 H7.1 2b — NO MORE COOK-DAY LINE IN PLACE OF THE PROTEIN. "On cook day: the
      // steak into the marinade bowl" replaced the steak's own step, so its trimming
      // vanished. The protein always keeps its knife-work step; WHEN it meets its
      // marinade is a fact about the cook day, written by the storage overlay from
      // `marinadeJoin` (here) and the marinade's `joins` (containerExtras).
      void cookDayByDishIngredient;
      for (const entry of entries) {
        const unclaimed = componentsOfUnclaimed(entry, claimed);
        if (unclaimed.length === 0) continue;
        const join = dishIdsOf(entry)
          .map((d) => proteinJoin.get(`${d}|${entry.ingredientId}`))
          .find((j) => j !== undefined);
        pushStep({
          ...(join ? { marinadeJoin: join } : {}),
          stepKey: `${key}#${entry.ingredientId}`,
          ingredientId: entry.ingredientId,
          contributesToMealIds: dedupe(
            entry.lines.flatMap((l) =>
              l.contributions
                .filter((c) => !claimed.has(`${c.dishId}|${entry.ingredientId}`))
                .map((c) => c.mealId),
            ),
          ),
          isBlend: false,
          components: unclaimed,
          relevantDishes: relevantDishesFor(
            dishIdsOf(entry).filter((d) => !claimed.has(`${d}|${entry.ingredientId}`)),
          ),
        });
      }
      continue;
    }

    // ── produce — 2d: ONE STEP PER FOOD, citrus included ─────────────────────
    //
    // "lemon", "lemon juice" and "lemon zest" were three steps on `c62587bb` and
    // `2251c7f5`: juiced in one, zested in another, squeezed again in the sauces
    // phase. All of one food's knife work is one step now — the whole fruit and
    // every catalog component of it — and its juice and zest are portioned to their
    // containers there, like an onion's dice.
    //
    // The key of a merged step is the WHOLE fruit's id when the plan has one, else
    // the smallest member id, so it does not move with meal order. A single-food
    // step keeps `produce#<id>`, which is what it always was.
    const foods = new Map<string, PrepIngredientGroup[]>();
    for (const entry of entries) {
      const fk = foodKeyOf(entry.ingredientName, entry.sourceYield);
      const l = foods.get(fk) ?? [];
      l.push(entry);
      foods.set(fk, l);
    }
    for (const group of foods.values()) {
      const skip = new Set<string>(claimed);
      for (const k of notPrep.keys()) skip.add(k);
      const work = group.flatMap((e) => componentsOfUnclaimed(e, skip, destinationFor));
      // A food with no prep portion at all keeps its line, demoted, with the reason.
      const all = work.length > 0 ? work : group.flatMap((e) => componentsOfUnclaimed(e, claimed));
      if (all.length === 0) continue;
      const keyEntry =
        group.length === 1
          ? group[0]
          : (group.find((e) => !e.sourceYield) ??
            [...group].sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : 1))[0]);
      const workKeys = group.flatMap((e) =>
        dishIdsOf(e)
          .map((d) => `${d}|${e.ingredientId}`)
          .filter((k) => !claimed.has(k)),
      );
      const reason =
        work.length > 0 ? undefined : (workKeys.map((k) => notPrep.get(k)).find((r) => r) ?? "no-work");
      pushStep(
        {
          stepKey: `${key}#${keyEntry.ingredientId}`,
          ingredientId: keyEntry.ingredientId,
          contributesToMealIds: dedupe(
            group.flatMap((e) =>
              e.lines.flatMap((l) =>
                l.contributions
                  .filter((c) => !claimed.has(`${c.dishId}|${e.ingredientId}`))
                  .map((c) => c.mealId),
              ),
            ),
          ),
          isBlend: false,
          components: all,
          relevantDishes: relevantDishesFor(workKeys.map((k) => k.slice(0, k.indexOf("|")))),
        },
        reason,
      );
    }
  }

  // ── D-WS9-301 rule 7 — THE DROP PASS, AND WHERE IT STOPS ──────────────────
  //
  // "Target 10–15 containers… Over target, drop the lowest-value steps first
  // (single-dish garnish portions, citrus wedges) rather than splitting
  // further. Exceeding 15 is allowed when every step clears the test."
  //
  // 🔴 SO THIS IS NOT A LOOP TO 15, AND MUST NOT BECOME ONE. It drops only the two
  // lowest classes and then stops. A plan at 23 containers of real work is 23.
  //
  // H7 — RUN BEFORE THE CLOSES AND THE NARRATION INPUT, not after them as it used
  // to be: a dropped step is not the last to touch anything, and a container whose
  // later step was dropped must read as finished on the step that remains.
  dropLowValueSteps(steps);

  // ── Part J.0 (A3) — SCOPE TO THE SELECTED MEALS, AFTER THE WHOLE PLAN IS BUILT ──
  //
  // Each kept step keeps its key, its container names and its demotion (the drop
  // pass ran over the whole plan); it loses the portions and meals outside the
  // selection, and its minutes and cook-day lag are recomputed for what is left.
  // Everything below — closes, openings, the narration input — runs on the scoped
  // steps, so a subset never closes a bowl on another meal's portion.
  if (opts.scopeMealIds) {
    const inScope = opts.scopeMealIds;
    const kept: PlannedStep[] = [];
    for (const st of steps) {
      const meals = st.contributesToMealIds.filter((id) => inScope.has(id));
      if (meals.length === 0) continue;
      if (st.components.length > 0) {
        const comps = st.components
          .map((c) => ({ ...c, measures: c.measures.filter((m) => m.mealId === undefined || inScope.has(m.mealId)) }))
          .filter((c) => c.measures.length > 0);
        if (comps.length === 0) continue;
        const dishNames = new Set(comps.flatMap((c) => c.measures.map((m) => m.forDish)));
        st.components = comps;
        st.relevantDishes = st.relevantDishes.filter((n) => dishNames.has(n));
        const timing = timeStep({ components: st.components, bowlName: st.bowlName }, yieldFor);
        st.estimatedMinutes = timing.minutes;
        if (timing.overCap) st.minutesOverCap = true;
        else delete st.minutesOverCap;
      }
      st.contributesToMealIds = meals;
      const lags = meals.map((id) => cookLagByMealId.get(id)).filter((n): n is number => n !== undefined);
      if (lags.length > 0) st.daysUntilCook = Math.max(...lags);
      else delete st.daysUntilCook;
      kept.push(st);
    }
    // Renumber within each phase: the cook reads "produce step 4", and a gap left
    // by an unselected meal's step would point at nothing.
    const perPhase = new Map<PrepPhaseKey, number>();
    for (const st of kept) {
      const n = (perPhase.get(st.phase) ?? 0) + 1;
      perPhase.set(st.phase, n);
      st.number = n;
      st.stepId = `${st.phase}#${n}`;
    }
    steps.splice(0, steps.length, ...kept);
  }

  // Emit dishSteps ONLY for dishes actually referenced by some step, in
  // first-referenced order, so the map carries no unused prose.
  const dishSteps: Record<string, string[]> = {};
  for (const s of steps) {
    for (const name of s.relevantDishes) {
      if (!(name in dishSteps)) {
        const texts = dishStepsByName.get(name);
        if (texts) dishSteps[name] = texts;
      }
    }
  }

  // ── H6.1-C — WHO TOUCHES EACH CONTAINER, AND WHO IS LAST ──────────────────
  //
  // Keyed on the container NAME: the steps that fill a container are its members'
  // own produce steps, which have no id of their own. Ordered by phase then
  // number, which is the order the cook reads.
  const rank = (st: PlannedStep) => PREP_PHASE_ORDER.indexOf(st.phase) * 1000 + st.number;
  const touchers = new Map<string, PlannedStep[]>();
  for (const st of steps) {
    if (st.demoted || st.cookDaySentence || st.holdsNoContainer) continue;
    for (const n of containerNamesOf(st)) {
      const l = touchers.get(n) ?? [];
      l.push(st);
      touchers.set(n, l);
    }
  }
  for (const l of touchers.values()) l.sort((x, y) => rank(x) - rank(y));

  // ── 2b — EVERY CONTAINER'S LAST STEP CARRIES ITS CLOSE ─────────────────────
  //
  // H6.2 gave the storage line only to a step that IS the container or that filled
  // a tub nobody else touched. A container filled by several produce steps and
  // owned by none — the slow cooker's vegetables, the tomatillo tray, the asparagus
  // bowl — was therefore closed by nobody, and on six containers across the four
  // plans the last thing the cook read was a knife instruction.
  //
  // Now the close belongs to the container, and the container's LAST step carries
  // it, whoever that step is. A step that closes nothing (because a later step
  // touches its containers) is suppressed; a step that touches no named container
  // (a protein on its own) closes itself, as it always did.
  for (const [n, l] of touchers) {
    const last = l[l.length - 1];
    last.closes = [...(last.closes ?? []), n];
  }
  for (const st of steps) {
    if (st.demoted || st.cookDaySentence || st.holdsNoContainer) continue;
    if (containerNamesOf(st).length > 0 && (st.closes?.length ?? 0) === 0) st.suppressStorage = true;
  }

  /**
   * The phase label of the next step to touch this step's OWN container, or null.
   * 🔴 ITS OWN: a handoff is a thing a container does, so only a step that IS a
   * container can announce one (H6.2 item 5).
   */
  const workedAgainAfter = (step: PlannedStep): string | null => {
    if (!step.bowlName) return null;
    const here = PREP_PHASE_ORDER.indexOf(step.phase);
    let best: PlannedStep | null = null;
    for (const other of touchers.get(step.bowlName) ?? []) {
      // 🔴 ACROSS PHASES ONLY. Two steps in the same phase are just two steps.
      if (PREP_PHASE_ORDER.indexOf(other.phase) <= here) continue;
      if (best === null || rank(other) < rank(best)) best = other;
    }
    return best ? PHASE_META[best.phase].title.toLowerCase() : null;
  };

  // ── 2f — WHAT IS ALREADY IN IT, AND THE VERB, ARE THE CODE'S ───────────────
  //
  // "Garlic Herb Roasted Potatoes prep container (garlic, rosemary, thyme, and
  // potatoes already in it)… Toss to coat" — the potatoes had been moved to cook
  // day, and the narrator wrote the list and chose the verb. Both are facts about
  // the container's members, so both are built here, from the steps that actually
  // put something in it, and handed to the narrator as fixed text.
  for (const st of steps) {
    if (!st.bowlName || st.demoted) continue;
    const before = (touchers.get(st.bowlName) ?? []).filter((o) => rank(o) < rank(st));
    const holds: string[] = [];
    for (const o of before) {
      for (const c of o.components) {
        const intoThis =
          o.bowlName === st.bowlName || c.measures.some((m) => m.destination === st.bowlName);
        if (!intoThis) continue;
        const label =
          // Only squeezed or zested citrus says where it came from ("the lemon juice
          // from produce step 2"); garlic has a catalog parent too (head → cloves), and
          // "the garlic from produce step 3" is noise.
          o.phase === "produce" && /\b(juice|zest|lemons?|limes?|oranges?)\b/i.test(c.ingredientName)
            ? `the ${c.ingredientName} from produce step ${o.number}`
            : c.ingredientName;
        if (!holds.includes(label)) holds.push(label);
      }
    }
    if (holds.length > 0) st.containerHolds = holds;
    st.openingClause =
      holds.length > 0 ? `${st.bowlName} (${listOf(holds)} already in it): add` : `Into the ${st.bowlName}:`;
    const after = (touchers.get(st.bowlName) ?? []).some((o) => rank(o) > rank(st));
    if (!after) {
      const memberNames = [
        ...holds,
        ...st.components.map((c) => c.ingredientName),
      ].join(" ");
      const wet = st.phase === "sauces_marinades" || /\bjuice\b/i.test(memberNames);
      if (wet) {
        const noun = nounByBowl.get(st.bowlName) ?? null;
        const emulsion =
          (noun !== null && EMULSIONS.has(noun)) ||
          (/\boil\b/i.test(memberNames) && /\b(vinegar|juice|mustard|mayonnaise|mayo|wine)\b/i.test(memberNames));
        st.closingLine = emulsion ? "Whisk to combine." : "Stir to combine.";
      }
    }
  }

  // ── A DEMOTED STEP IS NOT NARRATED ────────────────────────────────────────
  //
  // The client never renders it, and the narrator has nothing to decide about it
  // any more (2c). It gets fixed, code-owned prose naming the thing and why it
  // waits — the census reads it — and costs no tokens.
  for (const st of steps) {
    if (!st.demoted || st.fixedProse) continue;
    const names = dedupe(st.components.map((c) => c.ingredientName));
    st.fixedProse = {
      title: `${upperFirst(listOf(names.length > 0 ? names : ["Cook day"]))} — cook day`.slice(0, 120),
      instructions: DEMOTE_PROSE[st.demoted.reason] ?? "Left for cook day.",
    };
  }

  // ── Part J.0 — a produce step's portion lines are rendered here, not narrated ──
  // Part J.1 §2 — what each dash label is, so the sentence can say it in words.
  const labelKinds = new Map<string, LabelKind>();
  for (const l of sharedTubLabels) labelKinds.set(l, "shared");
  for (const [key, s] of specialSpec) if (s.kind === "chiles") labelKinds.set(containers.get(key)!.name, "own-bag");
  for (const c of containers.values()) {
    if (c.cls === "B" && !c.fixedName && c.name.includes(" — ")) labelKinds.set(c.name, "own-container");
  }
  // Part J.1 (R1) — a protein step that serves two meals is a portion step too: the
  // near meal's share is prepped and the far one's held, so its amounts are the
  // code's to write per meal ("1½ lb for Chicken Tikka Masala"), like the produce.
  for (const st of steps) {
    if (st.demoted || st.fixedProse) continue;
    const portionsHere = st.components.reduce((n, c) => n + c.measures.length, 0);
    if (st.phase !== "produce" && !(st.phase === "proteins" && portionsHere >= 2)) continue;
    const r = renderPortionLines(st, labelKinds);
    if (!r) continue;
    st.portionLines = r.lines;
    st.portionsByApp = r.meta;
  }

  const narrationInput: PrepNarrationInput = {
    planName,
    dishSteps,
    // D-WS9-301 rule 10 — a step the ENGINE owns the prose for is not sent to
    // the model at all. There is nothing to narrate and nothing to get wrong.
    steps: steps.filter((s) => !s.fixedProse).map((s) => ({
      stepId: s.stepId,
      phase: s.phase,
      isBlend: s.isBlend,
      // Part J.0 — a portion step's components go WITHOUT their measures: the
      // model writes the opening only, and an amount it cannot see is an amount it
      // cannot write a second time.
      components: s.portionsByApp
        ? s.components.map((c) => ({
            ingredientName: c.ingredientName,
            ...(c.preparationNote ? { preparationNote: c.preparationNote } : {}),
            measures: [],
          }))
        : narrationComponents(s.components),
      ...(s.portionsByApp ? { portionsByApp: s.portionsByApp } : {}),
      relevantDishes: s.relevantDishes,
      ...(s.bowlName ? { bowlName: s.bowlName } : {}),
      ...(s.cookDaySentence ? { cookDaySentence: s.cookDaySentence } : {}),
      ...(s.knifeVerbs ? { knifeVerbs: s.knifeVerbs } : {}),
      // H7 2f — the opening and the closing verb, fixed text. Date-independent by
      // construction (the container's own membership), so no cache-miss hazard.
      ...(s.openingClause ? { openingClause: s.openingClause } : {}),
      ...(s.closingLine ? { closingLine: s.closingLine } : {}),
      // H5.2 — is this container worked again later in the session?
      ...(workedAgainAfter(s) ? { setAsideFor: workedAgainAfter(s)! } : {}),
      // ⚠️ daysUntilCook IS DELIBERATELY NOT HERE (D-WS9-298): a day-dependent
      // prompt input makes every day reassignment a cache miss.
    })),
  };

  return { steps, narrationInput, containerExtras, labelKinds };
}

// ── H7.1 vocabulary. Every pattern reads its OWN subject — a step's text for a verb,
// an ingredient's own name for a food — and the exclusions are written down. ──────

/** A step that mixes things cold. */
const COLD_COMBINE = /\b(combine|mix|toss|stir together|fold)\b/i;
/** …and a step that has heat in it is not cold. */
const HEAT_TEXT =
  /\b(saut[ée]\w*|cook\w*|simmer\w*|bake\w*|roast\w*|broil\w*|grill\w*|fry|fried|boil\w*|heat\w*|sear\w*|toast\w*|melt\w*)\b/i;
/** Leafy greens, on the ingredient's own name: they wilt against wet vegetables. */
// Part J.1 §2 — LEAFY IS LEAVES: lettuces, spinach, arugula, kale, chard, herbs. Cabbage,
// fennel and carrot are cut vegetables (four "— greens" tubs held shredded cabbage).
const LEAFY = /\b(lettuce|romaine|iceberg|spinach|arugula|kale|mesclun|greens|radicchio|endive|chard|frisée|watercress)\b/i;
/** Part J.1 §2 — a citrus fruit or its zest, for the one-citrus-one-tub rule. */
const CITRUS = /\b(limes?|lemons?|oranges?|grapefruits?)\b/i;
/** Part J.1 (R2) — a portion the dish serves on top, by its own note. */
const TOPPING_NOTE = /\b(garnish\w*|toppings?|to serve|for serving|to top|on top|sprinkl\w+ over)\b/i;
/** Part J.1 (R2) — dry pasta is a no-work item: it goes from the box to the pot. */
const DRY_PASTA = /\b(spaghetti|linguine|fettuccine|penne|rigatoni|macaroni|elbows?|fusilli|farfalle|orzo|lasagna|egg noodles|pasta|noodles)\b/i;
/** Whole dried chiles — not chili POWDER, not FLAKES (Pantry rows on their own names). */
const DRIED_CHILE =
  /\b(?:dried\s+(?:\w+\s+)?chil(?:e|es|i|is|ies)|(?:ancho|guajillo|chipotle|pasilla|mulato|cascabel|arbol|árbol)\s+chil(?:e|es|i|is|ies))\b(?!\s+(?:powder|flakes))/i;
/** Fresh herbs, for naming a dish's unplaced aromatics "herbs" rather than "aromatics". */
const FRESH_HERB = /\b(parsley|cilantro|basil|mint|dill|thyme|rosemary|sage|chives|tarragon|oregano)\b/i;
/** The recipe marinates: a stated soak, or overnight. */
const MARINATES = /\b(marinat\w*|overnight|refrigerate for at least|let (?:it )?sit for)\b/i;
/** An acidic marinade member. */
const ACIDIC = /\b(juice|vinegar|lemon|lime|orange|wine|yogurt|buttermilk)\b/i;
/** Seafood, on the protein's own name (prepStorage's raw-fish vocabulary). */
const SEAFOOD = /\b(salmon|cod|halibut|tilapia|tuna|snapper|trout|bass|shrimp|prawns?|scallops?|fish|fillets?|mahi|catfish|flounder|mussels|clams)\b/i;

/** H7.1 2b — one protein that belongs with a marinade, and the facts that decide when. */
export interface MarinadeJoin {
  /** The recipe tells the cook to marinate (a stated soak, or overnight). */
  marinates: boolean;
  seafood: boolean;
  /** The marinade holds an acid (citrus, vinegar, wine, yogurt). */
  acidic: boolean;
  /** Part J.1 §2 — the recipe's stated window in hours; null when none. */
  windowHours?: number | null;
  /** Part J.1 §2 — the recipe says overnight, or 8 hours or more. */
  overnight?: boolean;
  /** Part J.1 §2 — the protein's own step, so a read can ask whether it renders. */
  proteinStepKey?: string;
}

const WORD_NUMBERS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, six: 6, eight: 8, twelve: 12, half: 0.5 };

/**
 * Part J.1 §2 — the marinating window a dish's own steps state. The FIRST duration in
 * a sentence about marinating, resting in the marinade or refrigerating, in hours:
 * "at least 30 minutes or up to 8 hours" → 0.5 (the soonest the protein can go in);
 * "overnight" → overnight. Null when the steps state no duration.
 */
export function marinadeWindow(texts: readonly string[]): { windowHours: number | null; overnight: boolean } {
  let windowHours: number | null = null;
  let overnight = false;
  for (const t of texts) {
    for (const s of t.split(/(?<=[.;])\s+/)) {
      if (!/\b(marinat\w*|refrigerate|chill|let (?:it |them )?(?:sit|rest)|in the marinade)\b/i.test(s)) continue;
      if (/\bovernight\b/i.test(s)) overnight = true;
      if (windowHours !== null) continue;
      const m = /\b(\d+(?:\.\d+)?|one|two|three|four|six|eight|twelve|half an?)\s*(?:to\s*\d+\s*|-\s*\d+\s*|–\s*\d+\s*)?(hours?|hrs?|minutes?|mins?)\b/i.exec(s);
      if (!m) continue;
      const raw = m[1].toLowerCase().replace(/\s*an?$/, "");
      const n = WORD_NUMBERS[raw] ?? Number(raw);
      if (!Number.isFinite(n)) continue;
      windowHours = /^min/i.test(m[2]) ? n / 60 : n;
    }
  }
  if (windowHours !== null && windowHours >= 8) overnight = true;
  return { windowHours, overnight };
}

/** H7.1 — what a container's close must say beyond how it keeps. */
export interface ContainerExtra {
  /** 2a — a cold mixture's dressing/acid containers, combined now or on cook day. */
  combineWith?: string[];
  /** 2b — the proteins that join this marinade. */
  joins?: (MarinadeJoin & { protein: string })[];
}

/** "a", "a and b", "a, b and c" — for the opening clause. */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Mixtures the cook emulsifies: their last step closes "Whisk to combine." */
const EMULSIONS: ReadonlySet<string> = new Set([
  "dressing", "vinaigrette", "marinade", "aioli", "glaze", "remoulade", "brine",
]);

/** A dry container of baking or binding goods is a "dry mix", not a "spice blend". */
const DRY_MIX_MEMBER =
  /\b(flour|cornmeal|masa|breadcrumbs|panko|sugar|baking powder|baking soda|yeast|oats|cornstarch|semolina|polenta)\b/i;

/** H7 2c — the reason a step left the list, as the census reads it. */
const DEMOTE_PROSE: Record<string, string> = {
  "single-item": "One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.",
  "below-floor-or-not-one-moment":
    "These go in at different moments, or there are too few to be worth a container — measure them on cook day.",
  "no-work": "Nothing to cut — it goes in as it comes.",
  "ready-to-use": "Ready to use from the package — nothing to do ahead.",
  heat: "This is cooking, not prep — it happens on cook day.",
  "does-not-hold": "This browns once it is cut, so it is cut on cook day.",
  "heat-or-no-knife-work": "Nothing to do to it before the pan — it goes in straight from the package on cook day.",
  "rule 7 — over the container target; citrus wedges keep best cut on the day":
    "Citrus wedges keep best cut on the day.",
  "rule 7 — over the container target; a single-dish garnish portion saves the least":
    "A single garnish portion saves the least — cut it on the day.",
};

// ── Part J.0 (census finding 2) — THE PORTION LINES ARE THE CODE'S ─────────────
//
// 8 of 25 census plans 502'd because the narrator's "Mince all garlic" ran past the
// 800-character cap: it wrote every portion line itself and repeated a 120-character
// tub label on each one. Those lines are facts — an amount, a dish, a destination —
// so code writes them, once, and the narrator writes only the opening sentence.
//
//   4 cloves for Beef Enchiladas Verdes — into the tub "Minced garlic — Enchiladas …"
//   2 cloves for Mexican Street-Style Rice — same tub
//
// A label is printed in full ONCE per step; a repeat reads "same tub" / "same bowl".
// Portions are grouped by cut, then by destination, so a repeat is adjacent and
// "same" can only mean the line above. The renderer owns the cap: what it returns
// fits PORTION_LINES_MAX, which leaves the opening OPENING_MAX of the 800.

/**
 * The narrator's opening sentence, at most. Longer is cut at a sentence end. The
 * longest shape the prompt asks for ("Work through 3 yellow onions three ways:
 * thinly sliced, finely diced and roughly chopped.") is 88 characters.
 */
export const OPENING_MAX = 160;
/** The wire caps `instructions` at 800 (both schemas); the opening and a newline take the rest. */
export const PORTION_LINES_MAX = 800 - OPENING_MAX - 1;

const VESSEL_NOUN = /\b(bowl|jar|container|tub|bag|tray|dish|pot|plate)\b(?:\s+\d+)?$/i;

/**
 * Part J.1 §2 — what a `<head> — <tail>` label IS, so a sentence can say it in words.
 *   shared        rule 5's tub: head = the food, tail = its dinners
 *   own-tub/bag/container   a dish's own: head = the dish, tail = what is in it
 */
export type LabelKind = "shared" | "own-tub" | "own-bag" | "own-container";

/** "diced jalapeño" → "diced-jalapeño", "dried chiles, stemmed and seeded" → "dried-chile". */
function attributive(contents: string): string {
  const s = contents.replace(/,\s*(?:stemmed|seeded|trimmed|peeled)\b.*$/i, "").trim();
  const words = s.split(/\s+/);
  if (words.length > 3 || /,|\band\b/.test(s)) return s;
  const last = words[words.length - 1];
  words[words.length - 1] = /greens$/i.test(last)
    ? last
    : last.replace(/leaves$/i, "leaf").replace(/(tomato|potato)es$/i, "$1").replace(/ies$/i, "y").replace(/([^siu])s$/i, "$1"); // asparagus, hummus, couscous keep theirs
  return words.join("-");
}

/**
 * The first mention of a destination, and what a repeat calls it.
 *
 * 🔴 Part J.1 §2 — NEVER THE RAW `<Dish> — <contents>` LABEL INSIDE A SENTENCE. The
 * label is the lid's name and stays on the wire as the container's name; the
 * sentence says it contents first, dish after: "into the dried-chile bag for the
 * Texas-Style Beef Chili", "into the shared minced-garlic tub". `namesDish` is the
 * dish the phrase already names, so the line need not say "for <dish>" again.
 */
export function destinationPhrase(
  dest: string,
  kind?: LabelKind,
): { first: string; noun: string; namesDish: string | null } {
  if (dest.includes(" — ")) {
    const [head, ...rest] = dest.split(" — ");
    let tail = rest.join(" — ");
    const n = /\s(\d+)$/.exec(tail);
    if (n) tail = tail.slice(0, -n[0].length);
    if (kind === "shared") return { first: `into the shared ${attributive(head.toLowerCase())} tub`, noun: "tub", namesDish: null };
    const vessel = kind === "own-bag" ? "bag" : kind === "own-container" ? "container" : "tub";
    return { first: `into the ${attributive(tail)} ${vessel}${n ? ` ${n[1]}` : ""} for the ${head}`, noun: vessel, namesDish: head };
  }
  const m = VESSEL_NOUN.exec(dest);
  if (m) return { first: `into the ${dest}`, noun: m[1].toLowerCase(), namesDish: null };
  return { first: `into the ${dest} container`, noun: "container", namesDish: null };
}

function leadingNumber(amount: string): number | null {
  const m = /^(\d+)?\s*([¼½¾⅓⅔⅛⅜⅝⅞])?/.exec(amount.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const frac: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
  return (m[1] ? Number(m[1]) : 0) + (m[2] ? frac[m[2]] : 0);
}

/**
 * Part J.1 — each component's whole amount, ingredient name → finished amount
 * ("6 tbsp", "2 yellow onions"). A partial hold changes these, and the opening the
 * narrator wrote states them: `finishPrepWeek` swaps the old for the new.
 */
export function componentTotals(components: readonly PrepNarrationComponent[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of components) {
    const parts = totalOf([c], false).split(" + ");
    out.set(c.ingredientName, [...(out.get(c.ingredientName) ?? []), ...parts]);
  }
  return out;
}

/** "3" + "yellow onion" → "3 yellow onions"; the count decides the noun's number. */
function countNoun(amount: string, name: string): string {
  const n = leadingNumber(amount);
  if (n === null) return name;
  if (n > 1) return /[sy]$/i.test(name) ? name : pluralizeSourceNoun(name);
  return name.replace(/(tomato|potato)es$/i, "$1").replace(/([^seiu])s$/i, "$1");
}

/** The step's whole amount per component, as a finished string ("11 cloves", "1 lemon + 6 tbsp lemon juice"). */
function totalOf(components: readonly PrepNarrationComponent[], named: boolean): string {
  const parts: string[] = [];
  for (const c of components) {
    const byToken = new Map<string, { q: number; unit: string }>();
    for (const m of c.measures) {
      if (m.qty === undefined || m.unit === undefined) continue;
      const { token } = canonicalizeUnit(m.unit);
      const first = [...byToken.keys()][0];
      const conv = first !== undefined && first !== token ? convertWithinDimension(m.qty, token, first) : null;
      const key = conv !== null && first !== undefined ? first : token;
      const have = byToken.get(key) ?? { q: 0, unit: m.unit };
      have.q += conv !== null ? conv : m.qty;
      byToken.set(key, have);
    }
    for (const { q, unit } of byToken.values()) {
      const amount = formatMeasure(q, unit);
      const countOnly = canonicalizeUnit(unit).token === "" || PLACEHOLDER_COUNT_UNITS.has(canonicalizeUnit(unit).token);
      parts.push(named || countOnly ? `${amount} ${countOnly ? countNoun(amount, c.ingredientName) : c.ingredientName}` : amount);
    }
  }
  return parts.join(" + ");
}

export interface RenderedPortions {
  lines: string[];
  meta: { food: string; total: string; cuts: string[]; portionCount: number };
}

/**
 * The portion lines for one produce step, or null when it has nothing to portion.
 * Pure: reads only the step's components.
 */
export function renderPortionLines(
  step: Pick<PlannedStep, "components">,
  /** Part J.1 §2 — what each dash label is (shared tub, a dish's own tub/bag/container). */
  labelKinds: ReadonlyMap<string, LabelKind> = new Map(),
  /** Characters the lines may take. Assembly passes 800 minus the real opening. */
  budget: number = PORTION_LINES_MAX,
): RenderedPortions | null {
  const names = dedupe(step.components.map((c) => c.ingredientName));
  const named = names.length > 1;
  type P = { qty: string; amount: string; cut: string; dish: string; dest: string | undefined };
  const portions: P[] = [];
  for (const c of step.components) {
    for (const m of c.measures) {
      const countOnly = (() => {
        const t = canonicalizeUnit(m.unit ?? "").token;
        return t === "" || PLACEHOLDER_COUNT_UNITS.has(t);
      })();
      let qty = m.amount;
      if (named || countOnly) {
        const n = leadingNumber(m.amount);
        // The catalog name's number is whatever it was filed under ("roma tomatoes",
        // "jalapeño"); the count decides it here.
        const noun = !countOnly || n === null
          ? c.ingredientName
          : n > 1
            // "celery" is a mass noun on a board ("3 celery", never "3 celeries");
            // the -y plural is left to names the catalog already pluralises.
            ? (/[sy]$/i.test(c.ingredientName) ? c.ingredientName : pluralizeSourceNoun(c.ingredientName))
            : c.ingredientName.replace(/(tomato|potato)es$/i, "$1").replace(/([^se])s$/i, "$1");
        qty = `${m.amount} ${noun}`;
      }
      // The CUT only ("finely diced"), never the whole note: "freshly squeezed",
      // "leaves picked" and "for garnish" are not a second way to work the food,
      // and printed on every line they pushed shared steps past the cap.
      const cut = cutOf([m.preparationNote ?? c.preparationNote ?? ""]) ?? "";
      portions.push({ qty, amount: m.amount, cut, dish: m.forDish, dest: m.destination });
    }
  }
  if (portions.length === 0) return null;

  // Group by cut, then by destination, first appearance first — so a repeated
  // destination is always the line directly above.
  const cuts = dedupe(portions.map((p) => p.cut));
  const dests = dedupe(portions.map((p) => p.dest ?? ""));
  const ordered = portions
    .map((p, i) => ({ p, i }))
    .sort((a, b) => cuts.indexOf(a.p.cut) - cuts.indexOf(b.p.cut) || dests.indexOf(a.p.dest ?? "") - dests.indexOf(b.p.dest ?? "") || a.i - b.i)
    .map((x) => x.p);
  const showCut = cuts.filter((c) => c !== "").length > 1;

  const build = (dishOf: (p: P) => string | null, plain = false): string[] => {
    const seen = new Set<string>();
    let prev: string | undefined;
    return ordered.map((p) => {
      // "4 cloves for Beef Chili", "½ white onion finely diced for Guacamole".
      const head = plain ? p.amount : `${p.qty}${showCut && p.cut ? ` ${p.cut}` : ""}`;
      const phrase = p.dest ? destinationPhrase(p.dest, labelKinds.get(p.dest)) : null;
      // A dish's own tub already says "for the <Dish>" — the line does not repeat it.
      const dish = phrase?.namesDish === p.dish ? null : dishOf(p);
      const who = dish ? `${head} for ${dish}` : head;
      if (!p.dest || !phrase) {
        prev = undefined;
        return who;
      }
      const { first, noun } = phrase;
      const where = !seen.has(p.dest)
        ? first
        : prev === p.dest ? `same ${noun}` : `the same ${noun} as above`;
      seen.add(p.dest);
      prev = p.dest;
      return `${who} — ${where}`;
    });
  };
  const fits = (ls: string[]) => ls.join("\n").length <= budget;
  // A short dish name only where it stays unique in this step: "Citrus-Braised
  // Pork Carnitas" and "Crispy Citrus-Braised Pork Carnitas" both shorten to
  // "Pork Carnitas", and two lines saying so are two portions nobody can tell apart.
  const shortCount = new Map<string, number>();
  for (const d of dedupe(portions.map((p) => p.dish))) shortCount.set(shortDishName(d), (shortCount.get(shortDishName(d)) ?? 0) + 1);
  const shortOf = (d: string) => (shortCount.get(shortDishName(d)) === 1 ? shortDishName(d) : d);
  // The lid NAMES the dish when the dish is its head: "Tabbouleh — lemon juice",
  // "Smoky Carne Asada marinade bowl". A shared tub's head is the food, and its
  // tail lists every dish — that tub needs "for <dish>" on each line, or the cook
  // cannot tell the portions apart.
  const lidNamesDish = (p: P) => {
    if (!p.dest) return false;
    const head = p.dest.split(" — ")[0];
    return head.includes(p.dish) || head.includes(shortDishName(p.dish));
  };
  // 1. as is; 2. drop "for <dish>" where the vessel's name is the dish's; 3. short
  //    dish names on the rest; 4. plain amounts — the cut and the food are the
  //    opening sentence's to say.
  let lines = build((p) => p.dish);
  if (!fits(lines)) lines = build((p) => (lidNamesDish(p) ? null : p.dish));
  if (!fits(lines)) lines = build((p) => (lidNamesDish(p) ? null : shortOf(p.dish)));
  if (!fits(lines)) lines = build((p) => (lidNamesDish(p) ? null : shortOf(p.dish)), true);
  if (!fits(lines)) {
    // Never reached on the census corpus (Part J.0 measured it): keep every line,
    // trim the tail, so the wire's 800 can never 502 the week.
    const all = lines.join("\n");
    lines = `${all.slice(0, budget - 1).trimEnd()}…`.split("\n");
  }
  return {
    lines,
    meta: {
      food: names.length === 1 ? names[0] : listOf(names),
      total: totalOf(step.components, named),
      cuts: showCut ? cuts.filter((c) => c !== "") : [],
      portionCount: portions.length,
    },
  };
}

/**
 * The narrator's text for a portion step, reduced to its opening sentence: the
 * first line, cut at a sentence end inside OPENING_MAX. Anything after the first
 * line is a portion list the app already writes.
 */
export function openingSentence(text: string): string {
  const first = text.split("\n")[0].trim().replace(/:$/, ".");
  if (first.length <= OPENING_MAX) return first;
  const cut = first.slice(0, OPENING_MAX);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.slice(0, OPENING_MAX - 1).trimEnd()}…`;
}

/** The narration input's view of components: the code-only attribution removed. */
function narrationComponents(components: readonly PrepNarrationComponent[]): PrepNarrationComponent[] {
  return components.map((c) => ({
    ...c,
    measures: c.measures.map(({ mealId: _m, dishId: _d, ingredientId: _i, qty: _q, unit: _u, ...rest }) => rest),
  }));
}

/** Rule 7's two droppable classes, lowest value first. Null = never dropped. */
export function lowValueClass(step: PlannedStep): "garnish" | "citrus-wedge" | null {
  if (step.cookDaySentence) return null; // not a container at all
  if (step.bowlName) return null; // a named mixture is never the cheap thing
  const notes = step.components
    .flatMap((c) => [c.preparationNote ?? "", ...c.measures.map((m) => m.preparationNote ?? "")])
    .join(" ")
    .toLowerCase();
  const names = step.components.map((c) => c.ingredientName).join(" ").toLowerCase();
  const dishes = new Set(step.components.flatMap((c) => c.measures.map((m) => m.forDish)));

  // Citrus cut into wedges: the one thing on the plan that takes 20 seconds on
  // the night and loses most by sitting (rule 6 names it as the first to go).
  if (/\b(lime|lemon|orange|grapefruit)\b/.test(names) && /\bwedge/.test(notes)) {
    return "citrus-wedge";
  }
  // A SINGLE-DISH garnish portion. Single-dish on purpose: a cilantro container
  // feeding four dishes is rule 5's best work, not a garnish portion.
  if (dishes.size === 1 && /\b(garnish|to finish|for serving|to serve|topping)\b/.test(notes)) {
    return "garnish";
  }
  return null;
}

/**
 * H4 / rule 11(c) — does this planned step put a container of its own on the
 * counter? False when every portion it makes has a destination: the food lives
 * in the containers it fills, and the knife work is not a third bowl.
 *
 * 🔴 ONE predicate, read by the plan-side counter AND by the wire mapping, so
 * the drop pass and the header can never disagree about what a container is.
 */
/**
 * H6.1-B — THE VESSELS A STEP TOUCHES, by name.
 *
 * Its own container, if it is one, plus every container its portions go into. The
 * header counts the union of these across the kept steps, because that is the set
 * of things the cook will have on the counter.
 *
 * 🔴 THIS REPLACES `feedsContainersOnly`. That predicate asked "does this step put
 * a bowl out of its own?", which was the right question while most portions went
 * nowhere named. Now that rule 11 names every destination, it answered "no" for
 * every ingredient step on the plan and the count collapsed to the mixtures alone.
 * Counting NAMES cannot have that failure: a container counts once, whoever fills
 * it, and a step that fills three counts them all.
 */
export function containerNamesOf(step: PlannedStep): string[] {
  const names = new Set<string>();
  if (step.bowlName) names.add(step.bowlName);
  for (const c of step.components) {
    for (const m of c.measures) if (m.destination) names.add(m.destination);
  }
  return [...names];
}

/** H7 2b — one container's close, as the storage overlay needs it. */
export interface StorageClose {
  /** The container's name, exactly as the steps write it. */
  name: string;
  /** Every ingredient that went into it, across every step that filled it. */
  ingredientNames: string[];
  /** Those names plus their preparation notes — the overlay's `text`. */
  text: string;
  /**
   * True when the container holds nothing but this step's own food (its own tub, or
   * the step IS the container), so the line needs no name in front of it.
   */
  own: boolean;
  /** H7.1 — see ContainerExtra. */
  combineWith?: string[];
  joins?: (MarinadeJoin & { protein: string })[];
}

/**
 * H7 2b — stepKey → the containers that step closes, with their FULL membership.
 *
 * The storage line describes the container, not the step that happens to close it:
 * the carrots step closing the slow cooker's vegetables writes the note for onion,
 * celery, carrots and garlic, and says which container it means.
 */
export function storageClosesByStepKey(
  steps: readonly PlannedStep[],
  /** H7.1 — `StepPlan.containerExtras`; absent means nothing beyond the storage line. */
  extras: ReadonlyMap<string, ContainerExtra> = new Map(),
): Map<string, StorageClose[]> {
  const members = new Map<string, { names: Set<string>; notes: string[] }>();
  for (const st of steps) {
    if (st.demoted || st.cookDaySentence || st.holdsNoContainer) continue;
    for (const n of containerNamesOf(st)) {
      const m = members.get(n) ?? { names: new Set<string>(), notes: [] };
      for (const c of st.components) {
        const into = st.bowlName === n ? c.measures : c.measures.filter((x) => x.destination === n);
        if (into.length === 0) continue;
        m.names.add(c.ingredientName);
        for (const x of into) if (x.preparationNote) m.notes.push(x.preparationNote);
      }
      members.set(n, m);
    }
  }
  const out = new Map<string, StorageClose[]>();
  for (const st of steps) {
    if (!st.closes || st.closes.length === 0) continue;
    const mine = new Set(st.components.map((c) => c.ingredientName));
    out.set(
      st.stepKey,
      st.closes.map((name) => {
        const m = members.get(name) ?? { names: new Set<string>(), notes: [] };
        const ingredientNames = [...m.names];
        return {
          name,
          ingredientNames,
          text: [...ingredientNames, ...m.notes].join(" "),
          own: st.bowlName === name || ingredientNames.every((x) => mine.has(x)),
          ...(extras.get(name) ?? {}),
        };
      }),
    );
  }
  return out;
}

/** Containers in a step plan: every distinct vessel the kept steps fill. */
export function countContainers(steps: readonly PlannedStep[]): number {
  const names = new Set<string>();
  let unnamed = 0;
  for (const s of steps) {
    if (s.demoted || s.cookDaySentence || s.holdsNoContainer) continue;
    const here = containerNamesOf(s);
    if (here.length === 0) {
      // Nothing named at all. After rule 11 this should be empty; it is counted
      // rather than ignored so the gap shows up in the census instead of hiding.
      unnamed += 1;
      continue;
    }
    for (const n of here) names.add(n);
  }
  return names.size + unnamed;
}

const CONTAINER_TARGET_MAX = 15;


function dropLowValueSteps(steps: PlannedStep[]): void {
  if (countContainers(steps) <= CONTAINER_TARGET_MAX) return;
  // Garnish portions before citrus wedges, and within a class the ones serving
  // the FEWEST dishes first — D-WS9-301 ruling 2's "dishes-served descending"
  // read from the other end: the container that earns its place by feeding four
  // dishes is the last of its kind to go.
  const order = { garnish: 0, "citrus-wedge": 1 } as const;
  const candidates = steps
    .map((s) => ({ s, cls: lowValueClass(s) }))
    .filter((x): x is { s: PlannedStep; cls: "garnish" | "citrus-wedge" } => x.cls !== null && !x.s.demoted)
    .sort((a, b) => {
      if (order[a.cls] !== order[b.cls]) return order[a.cls] - order[b.cls];
      const da = new Set(a.s.components.flatMap((c) => c.measures.map((m) => m.forDish))).size;
      const db = new Set(b.s.components.flatMap((c) => c.measures.map((m) => m.forDish))).size;
      return da - db;
    });
  for (const { s, cls } of candidates) {
    if (countContainers(steps) <= CONTAINER_TARGET_MAX) break;
    s.demoted = {
      reason:
        cls === "citrus-wedge"
          ? "rule 7 — over the container target; citrus wedges keep best cut on the day"
          : "rule 7 — over the container target; a single-dish garnish portion saves the least",
    };
  }
}

/**
 * D-WS9-301 ruling 4 — the header's two numbers: "N containers · about M min".
 *
 * Hans re-ruled D-WS9-213 for this: *"'12 containers, about 40 minutes' sounds
 * great. that's a time investment with a clear outcome that users can see value
 * in."* The September ruling that removed the summed total was made against a
 * two-hour output and is amended, not reversed — the per-phase "~N min left"
 * stays, and the header is hidden when there is nothing to prep.
 *
 * 🔴 ROUNDED UP, NEVER DOWN. His condition: *"I just want to be sure 40 minutes
 * is no more than 50 minutes or so in reality, otherwise, people won't trust
 * it."* A stated number a cook beats is a number they trust; one they miss is a
 * number they stop reading. So the sum goes UP to the next 5.
 *
 * 🔴 COMPUTED ON EVERY READ, over the steps that RENDER. A step the day overlay
 * demotes (a Friday salmon on a Sunday prep) is not a container today even
 * though it was one when the blob was cached — the same argument as
 * applyStorageOverlay, and the reason this is not baked into `structureJson`.
 */
export function summarizePrepWeek(result: PrepWeekResult): PrepWeekResult {
  // H4 / rule 11(c) — CONTAINERS, NOT STEPS, on the screen too. A container
  // worked in phase 1 and again in phase 3 is one bowl; counting its steps made
  // the redistribution look like it added bowls when it only re-sorted work.
  const names = new Set<string>();
  let unnamed = 0;
  let minutes = 0;
  const perStep: number[] = [];
  for (const phase of result.phases) {
    for (const step of phase.steps) {
      if (step.skipSuggested) continue;
      // The cook-day sentence still shows and still takes a moment on Friday, so
      // it counts toward the MINUTES — it just is not a container.
      minutes += step.estimatedMinutes;
      perStep.push(step.estimatedMinutes);
      if (step.holdsNoContainer) continue;
      // H6.1-B — count VESSELS BY NAME. A container counts once however many steps
      // touch it, and a step that fills three counts three.
      const here = step.containerNames ?? (step.containerId ? [step.containerId] : []);
      if (here.length === 0) {
        unnamed += 1;
        continue;
      }
      for (const n of here) names.add(n);
    }
  }
  const containers = names.size + unnamed;
  return {
    ...result,
    containerCount: containers,
    // BUG-204 — planMinutes adds the one allowed padding (10% for getting the
    // containers out and wiping down) and rounds UP to the next 5.
    estimatedMinutes: planMinutes(perStep),
  };
}

export function assemblePrepWeekResult(
  plan: StepPlan,
  narration: PrepNarrationResult,
): PrepWeekResult {
  const proseById = new Map(narration.steps.map((s) => [s.stepId, s]));

  // Fail closed: every planned step must be narrated. We never ship a step
  // with code-owned numbers but no prose.
  const missing = plan.steps
    .filter((s) => !s.fixedProse && !proseById.has(s.stepId))
    .map((s) => s.stepId);
  if (missing.length > 0) throw new PrepNarrationIncompleteError(missing);

  const stepsByPhase = new Map<PrepPhaseKey, PrepWeekStep[]>();
  for (const p of PREP_PHASE_ORDER) stepsByPhase.set(p, []);

  let total = 0;
  for (const planned of plan.steps) {
    const prose = planned.fixedProse
      ? { ...planned.fixedProse, storageNote: undefined, skipSuggested: undefined }
      : proseById.get(planned.stepId)!;
    // WS9 BUG-204 — the step minutes are the ENGINE's. 
    // is ignored even when a v12 narration still sends one.
    total += planned.estimatedMinutes;
    stepsByPhase.get(planned.phase)!.push({
      number: planned.number, // CODE
      stepKey: planned.stepKey, // CODE — stable persistence identity
      title: prose.title, // AI
      // Part J.0 — a portion step is the AI's opening sentence over the CODE's lines,
      // re-rendered for the room the real opening leaves (the plan-time lines
      // assumed the longest opening allowed).
      instructions: planned.portionLines
        ? (() => {
            const opening = openingSentence(prose.instructions);
            const lines = renderPortionLines(planned, plan.labelKinds, 800 - opening.length - 1)?.lines ?? planned.portionLines;
            return `${opening}\n${lines.join("\n")}`;
          })()
        : prose.instructions, // AI
      estimatedMinutes: planned.estimatedMinutes, // CODE (BUG-204 — prepStepMinutes.ts)
      contributesToMealIds: planned.contributesToMealIds, // CODE — never from prose
      ...(prose.storageNote ? { storageNote: prose.storageNote } : {}),
      // 🔴 H7 2c — THE NARRATOR'S `skipSuggested` IS IGNORED. It demoted real prep
      // (a five-item breading, green-bean trimming, pounding cutlets) and kept
      // cooking ("Brown the Italian sausage"). What is prep is the engine's call
      // alone, made in buildStepPlan; the field stays in the narration schema only
      // so an in-flight v18 response still parses.
      // D-WS9-301 rule 7 — the engine's own demotion has to reach the wire, not
      // just the corpus. It used to be folded in by the census harness and by
      // the mobile model separately; the drop pass makes that a correctness
      // matter, because a dropped garnish portion the client still rendered
      // would be a container the header did not count.
      ...(planned.demoted ? { skipSuggested: true } : {}),
      // A cook-day sentence holds no food, so it is not a container.
      ...(planned.cookDaySentence || planned.holdsNoContainer ? { holdsNoContainer: true } : {}),
      // H4 / rule 11(c) — the two fields the header's first number is counted
      // from. They have to travel on the wire because the cache-HIT path counts
      // the stored blob and has no step plan to ask.
      ...(planned.containerId ? { containerId: planned.containerId } : {}),
      // H6.1-C — the overlay must not write a storage line on a bowl that is about
      // to be opened again; the last toucher carries it.
      ...(planned.suppressStorage ? { suppressStorage: true } : {}),
      // H6.1-B — THE VESSEL NAMES, which is what the header counts. A boolean
      // could not say that one step fills three containers, and after rule 11 it
      // was true of every ingredient step and collapsed the count.
      ...(containerNamesOf(planned).length > 0
        ? { containerNames: containerNamesOf(planned) }
        : {}),
      // Part J.0 (A4) — the cook steps this prep step did the work of.
      ...(planned.coversCookSteps && planned.coversCookSteps.length > 0
        ? { coversCookSteps: planned.coversCookSteps }
        : {}),
    });
  }

  const phases = PREP_PHASE_ORDER.map((p) => ({
    phase: p,
    title: PHASE_META[p].title,
    skippable: PHASE_META[p].skippable,
    steps: stepsByPhase.get(p)!,
  }));

  return {
    totalEstimatedMinutes: Math.min(TOTAL_MAX, Math.max(TOTAL_MIN, total)),
    phases,
  };
}
