// [prepcook] Part J.0 (census finding 1) — ONE STEP SET, BUILT ONCE.
//
// The Prep the Week route renders from this, and `loadPrepStepSet` (the
// `isPrepped` derivation on GET /plans/:id) derives from it, with the same
// inputs: the plan, its day lags and today. Before this the derivation rebuilt
// the step plan WITHOUT step text and WITHOUT lags (prepStepSet.ts:114), so it
// keyed different steps than the screen showed — `seasonings_dry#dish#…` blends
// no screen ever showed — and it never saw the overlay's protein holds. Ticking
// every step on screen left 12 of 14 census meals not prepped.
//
// What `isPrepped` counts is `isTickable`: a step the cook can tick. A step the
// engine demoted, a step that holds no container (the wash, a cook-day line) and
// a step whose every portion is held for cook day are not in the denominator. A
// meal with zero tickable steps is prepped (Hans's vacuous rule, D-WS7-153).
//
// ── Part J.1 (R1) — ONE SUNDAY SESSION. NOTHING MID-WEEK. ─────────────────────
//
// Hans, October 3: "this is for home chefs to do an hour or so of work on Sunday to
// make the week easier… if they prep on Sunday and didn't get ahead on the
// Wednesday/Thursday meal that's ok." So a PORTION is prepped when the window of the
// container it goes into reaches its meal's cook day; otherwise it goes on the
// cook-day list, and the rest of that meal — its blend, its measuring, every
// vegetable that holds — is still prepped. A protein serving two meals preps the
// near share and holds the far one. There is no second session, ever.
//
// The holds are DATE facts, so they are computed here on every read (cache hit or
// miss) and applied to the wire by `finishPrepWeek`, never baked into cached prose.

import type { LoadPrepWeekInputResult, PrepLoadedPlan } from "./prepWeekAggregation";
import { buildPrepCombineInput } from "./prepCombineAdapter";
import { containerUses, feastClosingLines, stepDayOf } from "./prepFeastClose";
import { proseNames } from "./prepMoments";
import { ingredientGroupKey } from "./ingredientRelations";
import { foodOf, namedFoods } from "./prepFoods";
import { withCupLadder } from "./prepQuantity";
import { combinePrep, MIX_STAPLE } from "./prepCombineEngine";
import { cutOf } from "./prepClasses";
import { CUT_AT_THE_STEP } from "./heldMorning";
import { labelWeekResult, mainDishOf, mixBowlWording, weekLabelMap } from "./prepWeekLabels";
import { FEAST_LABEL_STEP_KEY } from "./prepFeastLabels";
import {
  buildStepPlan,
  componentTotals,
  composePortionStep,
  openingSentence,
  OVER_CAP_REASON,
  storageClosesByStepKey,
  type PlannedStep,
  type StepPlan,
} from "./prepWeekAssembly";
import {
  applyStorageOverlay,
  containerWindowDays,
  marinadeCookDayAction,
  nounFormTitle,
  storageClassFor,
  type StorageContext,
} from "./prepStorage";
import type { PrepWeekResult, PrepWeekStep } from "./ai/schemas/prepWeek";
import type { PrepNarrationComponent } from "./ai/schemas/prepNarration";

/** One step's verdict for today: which of its meals' portions wait for cook day. */
export interface StepHold {
  /** Meals at least one of whose portions in this step is still prepped today. */
  keptMealIds: string[];
  /** Meals ALL of whose portions in this step wait for cook day. */
  heldMealIds: string[];
  /** Every portion waits: the step is a cook-day line today. */
  all: boolean;
  /** The components with the held portions removed (the partial-step render). */
  keptComponents: PrepNarrationComponent[];
  /** The held portions, for the cook-day list. */
  heldPortions: { mealId: string; ingredientName: string; cut: string | null; window: number; lag: number; dest?: string; day?: string; dish?: string }[];
}

export interface PrepWeekBuild {
  stepPlan: StepPlan;
  /** stepKey → what the storage overlay needs, from today's cook days. */
  storageContexts: Map<string, StorageContext>;
  /** stepKey → today's holds (R1). Absent for a step with nothing held. */
  holds: Map<string, StepHold>;
  /** The cook-day list's lines that come from the step plan (0c), before the overlay's. */
  heldLines: string[];
  /**
   * THX-3 (BUG-426 b) — the feast session only: stepKey → the line that closes a
   * container, "That's the Pumpkin Pie dry mix. On Wednesday, whisk it into …". Built
   * from the recipe, appended at finish (never cached in prose).
   */
  closingLines?: Map<string, string>;
  /**
   * THX-3 (D-WS9-316) — the feast session only: the first day one of its containers
   * is used ("Monday" — the cranberry sauce's dry mix), so the session is done BEFORE
   * it. The feast's own day when no container is used earlier.
   */
  sessionBefore?: string;
  /**
   * PREP-3 (R3) — the week only: each container's label from today's days ("Tuesday
   * plate", "Monday marinade", "Minced garlic"), put on at finish (never cached in prose).
   */
  weekLabels?: ReturnType<typeof weekLabelMap>;
  /** The feast session's build ("Prep the feast"), not a week's. */
  feast?: true;
}

export interface BuildPrepWeekOptions {
  /** Prep Selected Meals: the plan is built whole, then scoped (A3). */
  scopeMealIds?: readonly string[];
  /** Census only: compute no holds (to count expired windows the old way). */
  noHolds?: boolean;
  /** THX-3 — "Prep the feast": salt and pepper measure, two dry items make a mix, closing lines. */
  feast?: boolean;
}

type Load = Pick<LoadPrepWeekInputResult, "input" | "cookDays" | "identity">;

// ── PREP-1 (D-WS9-314) — THE FEAST IS NOT THE WEEK ───────────────────────────
//
// Hans, October 14: "the core engine ignores the thanksgiving thing and then the
// thanksgiving piece maybe runs after or in addition to the core engine." A meal
// tagged `thanksgiving-feast` is out of the full week — its scope AND its step
// set, so the core reads it as nothing to prep — and is prepped in a session of
// its own. Both sessions are the whole plan built once and then scoped (A3): one
// food-identity fold, one set of container names.

/** The plan's feast meals, by tag (the loader sets `feast`). */
export function feastMealIds(input: Pick<PrepLoadedPlan, "meals">): string[] {
  return input.meals.filter((m) => m.feast).map((m) => m.mealId);
}

/**
 * The full week's scope: the selection (or every meal) less the feast. Undefined
 * for a plan with no feast and no selection, which is today's whole week,
 * byte-unchanged. An empty array is a real answer: nothing but the feast.
 */
export function coreScopeMealIds(input: Pick<PrepLoadedPlan, "meals">, selected?: readonly string[]): string[] | undefined {
  const feast = new Set(feastMealIds(input));
  if (feast.size === 0) return selected ? [...selected] : undefined;
  return (selected ?? input.meals.map((m) => m.mealId)).filter((id) => !feast.has(id));
}

/** The full week (core session) — what Prep the Week, `isPrepped` and the structure route build. */
export function buildCoreWeek(load: Load, selected?: readonly string[]): PrepWeekBuild {
  const scope = coreScopeMealIds(load.input, selected);
  return buildPrepWeekPlan(load, scope ? { scopeMealIds: scope } : {});
}

/**
 * 🔴 PREP-1 (D-WS9-314) — THE FEAST SESSION'S KEYS HAVE THEIR OWN PREFIX. A step key
 * is `phase#ingredientId` and ticks are stored per plan, so the onions chopped for
 * the weeknights and the onions chopped for the stuffing would be ONE checkbox
 * (PREP-0: Vegetarian shares 7 keys between the sessions, Classic 1). The longest
 * engine key is 71 characters (`cnt#` + 4 + `#` + 62), so this fits the 80 allowed.
 *
 * The prefix is the WIRE's and the completions table's. Inside the engine — the
 * build, the holds, the cached blob — a feast step keeps its engine key, so
 * `finishPrepWeek` reads a cached feast blob exactly as it reads the week's.
 */
export const FEAST_KEY_PREFIX = "feast#";

/**
 * PREP-1 G — the feast session's load: THE FEAST MEALS ALONE.
 *
 * It used to be the whole plan built and then scoped (A3), the seam PREP-0 chose to
 * keep one food fold and the week's container names. Measured on dev (QA-1 item 3):
 * swapping Monday's dinner re-ordered the feast's produce steps — new step numbers,
 * the same foods listed in a different order inside a container name — so its
 * narration input moved with a meal it does not contain, and a cache keyed on the
 * feast could serve stale numbers. The `feast#` prefix already keeps the sessions'
 * ticks apart, so nothing needs the whole-plan build any more.
 *
 * So the session is built from the feast's own meals, under the feast meal's own
 * name. Its food keys are then the feast's own: combinePrep keys a food on the
 * smallest id among the rows IN ITS INPUT, so a weeknight's "garlic cloves" row,
 * folded with the feast's garlic under a smaller id, no longer decides the feast
 * garlic's key. (The plan's fold map still groups the feast's own rows; only a
 * synonym chain running THROUGH a weeknight row could group differently.)
 *
 * Its day is the day BEFORE the feast (Wednesday), not the Sunday the week is
 * prepped on, so each feast meal's lag is measured from there (at most 1). From
 * Sunday a Thursday feast is 4 days out, and its onions would read "leave it for
 * cook day" in the one session that exists to cut them.
 */
export function feastOnlyLoad(load: Load, lagCap = 1): Load | null {
  const meals = load.input.meals.filter((m) => m.feast);
  if (meals.length === 0) return null;
  const ids = new Set(meals.map((m) => m.mealId));
  const cd = load.cookDays ?? { prepDay: null, lagByMealId: new Map<string, number>(), dayNameByMealId: new Map<string, string>() };
  const only = <V>(m: ReadonlyMap<string, V>) => new Map([...m].filter(([id]) => ids.has(id)));
  const lagByMealId = new Map([...only(cd.lagByMealId)].map(([id, lag]) => [id, Math.min(lag, lagCap)] as const));
  return {
    input: { planId: load.input.planId, planName: meals[0].mealName, meals },
    cookDays: {
      prepDay: cd.prepDay,
      lagByMealId,
      dayNameByMealId: only(cd.dayNameByMealId),
      ...(cd.pastMealIds ? { pastMealIds: new Set([...cd.pastMealIds].filter((id) => ids.has(id))) } : {}),
    },
    identity: load.identity,
  };
}

/**
 * "Prep the feast" — the feast's own session (see feastOnlyLoad). Null for a plan without one.
 *
 * 🔴 THX-3 (D-WS9-316) — THE SESSION IS NOT "WEDNESDAY" ANY MORE. It holds the
 * make-ahead dishes' shelf-stable mixes, and Make-Ahead's cranberry sauce uses its
 * mix on Monday, so the session is done before the FIRST day one of its containers
 * is used (`sessionBefore`). Its lag is measured from the day before that day, so
 * a Thursday dish's perishable reads honestly as days out (and is held for cook
 * day when it would not keep), rather than as the day before. Built twice when the
 * lag moves: the first build is what finds the first day.
 */
export function buildFeastSession(load: Load): PrepWeekBuild | null {
  const feast = feastOnlyLoad(load);
  if (!feast) return null;
  const first = buildPrepWeekPlan(feast, { feast: true });
  const feastDay = dayIndex(load.cookDays?.dayNameByMealId.get(feastMealIds(load.input)[0] ?? "")) ?? 4;
  const before = dayIndex(first.sessionBefore);
  if (before === undefined) return first;
  const daysBefore = (feastDay - before + 7) % 7;
  const cap = daysBefore + 1;
  if (cap <= 1) return first;
  const again = feastOnlyLoad(load, cap)!;
  const same = [...again.cookDays!.lagByMealId].every(([id, lag]) => feast.cookDays!.lagByMealId.get(id) === lag);
  return same ? first : buildPrepWeekPlan(again, { feast: true });
}

function dayIndex(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const i = WEEKDAYS.findIndex((d) => d.toLowerCase() === name.trim().toLowerCase());
  return i >= 0 ? i : undefined;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The feast session's day: the day before the (first) feast's. An unscheduled feast is Thursday's. */
export function feastSessionDay(load: Pick<Load, "input" | "cookDays">): string {
  const first = feastMealIds(load.input)[0];
  const named = first ? load.cookDays?.dayNameByMealId.get(first) : undefined;
  const i = named ? WEEKDAYS.findIndex((d) => d.toLowerCase() === named.trim().toLowerCase()) : -1;
  return WEEKDAYS[((i >= 0 ? i : 4) + 6) % 7];
}

/** A feast-session result with its keys as the wire and the completions table carry them. */
export function withFeastKeys(result: PrepWeekResult): PrepWeekResult {
  return {
    ...result,
    phases: result.phases.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, stepKey: `${FEAST_KEY_PREFIX}${s.stepKey}` })) })),
  };
}

/** Every key a build puts on the wire (not demoted), with a prefix — what a regenerate's prune keeps. */
export function wireStepKeys(build: PrepWeekBuild, prefix = ""): string[] {
  return build.stepPlan.steps.filter((s) => !s.demoted).map((s) => `${prefix}${s.stepKey}`);
}

export function buildPrepWeekPlan(load: Load, opts: BuildPrepWeekOptions = {}): PrepWeekBuild {
  // SERVER-12 C — the feast's amounts keep the cup ladder as it was (Thanksgiving is frozen).
  return opts.feast ? withCupLadder(() => buildPlan(load, opts)) : buildPlan(load, opts);
}

function buildPlan(load: Load, opts: BuildPrepWeekOptions): PrepWeekBuild {
  const { input, identity } = load;
  // An older caller (or a hand-built test loader) carries no cook days: that is
  // "no day known", the same as a plan with no startDate.
  const cookDays = load.cookDays ?? { prepDay: null, lagByMealId: new Map(), dayNameByMealId: new Map() };
  const combineInput = buildPrepCombineInput(input, opts.feast ? { feast: true } : {});
  const combineResult = combinePrep(combineInput, identity?.foldedIdByIngredientId, opts.feast ? { feast: true } : {});
  // WS7-8a B2b — step text per dishId (folded dish + meal owned) so the engine
  // can judge what is prep and which dishes mix cold.
  const stepTextByDishId = new Map<string, string[]>();
  for (const meal of input.meals) {
    for (const dish of meal.dishes) stepTextByDishId.set(dish.dishId, dish.stepTexts);
  }
  const stepPlan = buildStepPlan(
    combineResult,
    input.planName,
    stepTextByDishId,
    cookDays.lagByMealId,
    {
      ...(opts.scopeMealIds ? { scopeMealIds: new Set(opts.scopeMealIds) } : {}),
      mealOrder: input.meals.map((m) => m.mealId),
      ...(opts.feast ? { feast: true } : {}),
    },
  );

  const closesByStepKey = storageClosesByStepKey(stepPlan.steps, stepPlan.containerExtras, stepPlan.labelKinds);
  // THX-3c (E) — in the feast, each portion is measured to its OWN dish's day.
  const dayOf = opts.feast ? feastPortionDays(input, cookDays, identity) : undefined;
  const holds = opts.noHolds ? new Map<string, StepHold>() : computeHolds(stepPlan, closesByStepKey, cookDays.lagByMealId, dayOf);

  const mealNameById = new Map(input.meals.map((m) => [m.mealId, m.mealName]));
  /** Plate name → the piles held for cook day today. */
  const heldPiles = new Map<string, Set<string>>();
  for (const h of holds.values()) {
    for (const p of h.heldPortions) {
      if (!p.dest || !isPlate(p.dest)) continue;
      heldPiles.set(p.dest, (heldPiles.get(p.dest) ?? new Set()).add(p.ingredientName));
    }
  }
  // A step's meals TODAY: the kept ones when something is held.
  const mealsOf = (st: PlannedStep) => {
    const h = holds.get(st.stepKey);
    return h && !h.all ? h.keptMealIds : st.contributesToMealIds;
  };
  const visible = (key: string, mealIds: readonly string[]): boolean => {
    const st = stepPlan.steps.find((s) => s.stepKey === key);
    if (!st || st.demoted || st.holdsNoContainer || st.cookDaySentence) return false;
    const h = holds.get(key);
    if (!h) return true;
    return !h.all && mealIds.some((m) => h.keptMealIds.includes(m));
  };

  // D-WS9-298 — what the overlay needs, keyed by stepKey, from the STEP PLAN so it
  // is today's dates whether the prose came from the cache or not.
  const storageContexts = new Map<string, StorageContext>();
  // PREP-3 — each container's own meals, for its own day in its closing line.
  const mealsByContainer = new Map<string, Set<string>>();
  for (const s of stepPlan.steps) {
    for (const c of s.components) {
      for (const m of c.measures) {
        const n = m.destination ?? s.bowlName;
        if (n && m.mealId) mealsByContainer.set(n, (mealsByContainer.get(n) ?? new Set()).add(m.mealId));
      }
    }
  }
  const containerDay = (name: string): { dayName?: string; daysUntilCook?: number } => {
    if (dayOf) return {}; // the feast's portions carry their own days
    const latest = [...(mealsByContainer.get(name) ?? [])]
      .map((id) => ({ id, lag: cookDays.lagByMealId.get(id) }))
      .filter((x): x is { id: string; lag: number } => x.lag !== undefined)
      .sort((a, b) => b.lag - a.lag)[0];
    if (!latest) return {};
    const day = cookDays.dayNameByMealId.get(latest.id);
    return { daysUntilCook: latest.lag, ...(day ? { dayName: day } : {}) };
  };
  for (const st of stepPlan.steps) {
    const names = st.components.map((c) => c.ingredientName);
    const notes = st.components.flatMap((c) => [
      c.preparationNote ?? "",
      ...c.measures.map((x) => x.preparationNote ?? ""),
    ]);
    const meals = mealsOf(st);
    // D-WS9-301 rule 13 — the held line names the day and the meal. The LATEST
    // meal is the one the lag is from — of the meals still prepped today.
    const latest = meals
      .map((id) => ({ id, lag: cookDays.lagByMealId.get(id) ?? -1 }))
      .sort((x, y) => y.lag - x.lag)[0];
    // THX-3c (E) — in the feast, the latest of the step's own portions' days.
    const portionDays = dayOf
      ? (holds.get(st.stepKey)?.keptComponents ?? st.components).flatMap((c) => c.measures.map((m) => dayOf(m, c.ingredientName))).filter((x): x is PortionDay => !!x)
      : [];
    const latestPortion = [...portionDays].sort((x, y) => y.lag - x.lag)[0];
    const lags = latestPortion
      ? portionDays.map((p) => p.lag)
      : meals.map((id) => cookDays.lagByMealId.get(id)).filter((n): n is number => n !== undefined);
    const dayName = latestPortion?.day ?? (latest ? cookDays.dayNameByMealId.get(latest.id) : undefined);
    const mealName = latest ? mealNameById.get(latest.id) : undefined;
    // A partly held step closes only the containers it still fills today.
    const hold = holds.get(st.stepKey);
    const stillFilled = hold && !hold.all
      ? new Set([st.bowlName, ...hold.keptComponents.flatMap((c) => c.measures.map((m) => m.destination))].filter((x): x is string => !!x))
      : null;
    const closes = closesByStepKey.get(st.stepKey)?.filter((c) => !stillFilled || stillFilled.has(c.name)).map((c) => ({
      ...c,
      // PREP-3 — the container's own day (its own meals'), not the step's latest.
      ...containerDay(c.name),
      // J.1b — a plate's line names the piles on it TODAY; a held pile is not.
      ...(isPlate(c.name) && heldPiles.has(c.name)
        ? (() => {
            const names = c.ingredientNames.filter((n) => !heldPiles.get(c.name)!.has(n));
            return { ingredientNames: names, text: names.join(" ") };
          })()
        : {}),
      // J.1 §2 — the marinade's close may point at the proteins step only when it renders.
      ...(c.joins ? { joins: c.joins.map((j) => ({ ...j, proteinVisible: !!j.proteinStepKey && visible(j.proteinStepKey, meals) })) } : {}),
    }));
    storageContexts.set(st.stepKey, {
      daysUntilCook: lags.length > 0 ? Math.max(...lags) : undefined,
      ...(dayName ? { dayName } : {}),
      ...(mealName ? { mealName } : {}),
      phase: st.phase,
      // The BOWL NAME is part of the text on purpose: "Fajita spice blend" says
      // what the mixture IS; without it a dry blend read as loose produce.
      text: [...names, ...notes].join(" "),
      bowlName: st.bowlName,
      ingredientNames: names,
      ...(closes ? { closes } : {}),
      ...(st.marinadeJoin ? { marinadeJoin: st.marinadeJoin } : {}),
    });
  }

  // PREP-3 3c — a week's labels name each meal's plate by its main dish ("Skewers plate").
  const weekLabels = opts.feast
    ? undefined
    : weekLabelMap(stepPlan, cookDays.dayNameByMealId, new Map(input.meals.map((m) => [m.mealId, mainDishOf(m.dishes)?.dishName ?? m.mealName])), mealNameById);
  const build: PrepWeekBuild = {
    stepPlan,
    storageContexts,
    holds,
    heldLines: heldLinesFor(stepPlan, holds, cookDays, mealNameById, dayOf, weekLabels?.map),
    ...(opts.feast ? { ...feastFacts(stepPlan, input, combineInput, cookDays, dayOf), feast: true as const } : { weekLabels }),
  };
  assignCoversCookSteps(build, load, opts.feast ? { feast: true } : {});
  return build;
}

/** THX-3d — each dish's servings multiplier (the adapter's: the plan's servings over the authored anchor). */
function servingsMultipliers(input: Load["input"]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of input.meals) {
    for (const d of m.dishes) {
      const base = (d.authoredBaseServings ?? d.baseServings) > 0 ? (d.authoredBaseServings ?? d.baseServings) : 1;
      out.set(d.dishId, (m.servingsOverride ?? d.baseServings) / base);
    }
  }
  return out;
}

/**
 * THX-3 — the feast session's date-free facts: each container's closing line
 * (BUG-426 b) and the first day one of its containers is used (D-WS9-316).
 */
function feastFacts(
  stepPlan: StepPlan,
  input: Load["input"],
  combineInput: ReturnType<typeof buildPrepCombineInput>,
  cookDays: { dayNameByMealId: ReadonlyMap<string, string> },
  dayOf?: PortionDayOf,
): Pick<PrepWeekBuild, "closingLines" | "sessionBefore"> {
  const dishes = new Map(input.meals.flatMap((m) => m.dishes.map((d) => [d.dishId, d] as const)));
  const feastDay = cookDays.dayNameByMealId.get(input.meals[0]?.mealId ?? "") ?? "Thursday";
  const fi = dayIndex(feastDay) ?? 4;
  let first: string | undefined;
  let most = -1;
  const consider = (day: string | undefined) => {
    const i = day ? dayIndex(day) : undefined;
    if (i === undefined) return;
    const before = (fi - i + 7) % 7;
    if (before > most) { most = before; first = WEEKDAYS[i]; }
  };
  for (const u of containerUses(stepPlan.steps, dishes, combineInput)) consider(u.day?.day);
  // THX-3c (E) — and the first day one of its CUTS is used: the gravy's onion on
  // Tuesday is cut before Tuesday, whatever the dry mixes say.
  for (const st of stepPlan.steps) {
    if (st.demoted || st.phase !== "produce" || !dayOf) continue;
    for (const c of st.components) for (const m of c.measures) consider(dayOf(m, c.ingredientName)?.day);
  }
  // The closing line names what JOINS a container, which for a make-ahead dish is
  // exactly what the session left out (the purée, the eggs, the cranberries): so its
  // amounts come from the dishes whole, scaled the same way, not the session's rows.
  const whole = buildPrepCombineInput(input);
  return {
    closingLines: feastClosingLines(stepPlan.steps, dishes, whole, WEEKDAYS[fi], servingsMultipliers(input), new Set([...(stepPlan.feastLabels?.kinds ?? [])].filter(([, k]) => k === "shared").map(([l]) => l))),
    sessionBefore: first ?? WEEKDAYS[fi],
  };
}

/** THX-3c (E) — the day a feast portion is cooked on, and its lag from the session. */
export interface PortionDay {
  day: string;
  lag: number;
}
type PortionDayOf = (m: { mealId?: string; dishId?: string; ingredientId?: string }, ingredientName: string) => PortionDay | undefined;

/**
 * 🔴 THX-3c (E) — A FEAST PORTION IS MEASURED TO ITS OWN DISH'S DAY, never Thursday.
 * Hans, October 20: the make-ahead dishes' cuts come back into Prep the feast, and the
 * stuffing's onions are cut for WEDNESDAY, the gravy's for Tuesday. So the day is the
 * recipe's own: the step the portion first enters at ("Make ahead (Wednesday):", the
 * phrase contract stepDayOf reads), else the feast's day. Its lag is the feast's lag
 * less the days between, never below 0. A portion that will not keep that long is
 * held for THAT day ("cut it that morning"), and the held line names that day.
 *
 * Keyed by meal + dish + the measure's food id, with the plan's fold and the food's
 * name as fallbacks (combinePrep keys a food on the smallest id among its rows).
 */
function feastPortionDays(
  input: Load["input"],
  cookDays: { lagByMealId: ReadonlyMap<string, number>; dayNameByMealId: ReadonlyMap<string, string> },
  identity: Load["identity"],
): PortionDayOf {
  const byKey = new Map<string, PortionDay>();
  for (const meal of input.meals) {
    const mealLag = cookDays.lagByMealId.get(meal.mealId);
    if (mealLag === undefined) continue;
    const feastDay = cookDays.dayNameByMealId.get(meal.mealId) ?? "Thursday";
    const fi = dayIndex(feastDay) ?? 4;
    for (const dish of meal.dishes) {
      const steps = [...(dish.componentSteps ?? [])].sort((a, b) => a.stepIndex - b.stepIndex);
      for (const ing of dish.ingredients) {
        const entry =
          steps.find((s) => s.ingredientIds.includes(ing.ingredientId)) ??
          steps.find((s) => proseNames(s.text, ing.ingredientName));
        const day = (entry ? stepDayOf(steps, entry.stepIndex)?.day : undefined) ?? feastDay;
        const back = ((fi - (dayIndex(day) ?? fi)) + 7) % 7;
        const pd = { day, lag: Math.max(0, mealLag - back) };
        const folded = identity?.foldedIdByIngredientId.get(ing.ingredientId) ?? ing.ingredientId;
        for (const k of [ing.ingredientId, folded, `n:${ingredientGroupKey(ing.ingredientName)}`]) {
          const key = `${meal.mealId}|${dish.dishId}|${k}`;
          if (!byKey.has(key)) byKey.set(key, pd);
        }
      }
    }
  }
  return (m, name) => {
    if (!m.mealId || !m.dishId) return undefined;
    const base = `${m.mealId}|${m.dishId}|`;
    return (m.ingredientId ? byKey.get(`${base}${m.ingredientId}`) : undefined) ?? byKey.get(`${base}n:${ingredientGroupKey(name)}`);
  };
}

/** The window of a step's own food when it goes into no named container. */
function ownWindow(st: PlannedStep, c: PrepNarrationComponent): number {
  const note = [c.preparationNote ?? "", ...c.measures.map((m) => m.preparationNote ?? "")].join(" ");
  return containerWindowDays({ name: "", text: `${c.ingredientName} ${note}`, ingredientNames: [c.ingredientName] });
}

/**
 * R1 — for each step, which portions wait for cook day. A portion waits when its
 * meal's lag is past the window of the container it goes into (or of its own food,
 * for a portion that goes into none — a protein in its own wrapping). Room-temperature
 * containers never wait. A step the narrator writes whole (a bowl's measures, a
 * single protein) is all-or-nothing; a portion step (code-rendered lines) can split.
 */
function computeHolds(
  plan: StepPlan,
  closesByStepKey: ReturnType<typeof storageClosesByStepKey>,
  lagByMealId: ReadonlyMap<string, number>,
  /** THX-3c (E) — the feast: each portion's own day and lag. */
  dayOf?: PortionDayOf,
): Map<string, StepHold> {
  const windowByName = new Map<string, number>();
  for (const list of closesByStepKey.values()) {
    for (const c of list) windowByName.set(c.name, containerWindowDays(c));
  }
  const out = new Map<string, StepHold>();
  for (const st of plan.steps) {
    if (st.demoted || st.holdsNoContainer || st.cookDaySentence || st.fixedProse) continue;
    const heldPortions: StepHold["heldPortions"] = [];
    const keptComponents: PrepNarrationComponent[] = [];
    const kept = new Set<string>();
    const touched = new Set<string>();
    for (const c of st.components) {
      const keptMeasures = c.measures.filter((m) => {
        if (!m.mealId) return true;
        touched.add(m.mealId);
        const own = dayOf?.(m, c.ingredientName);
        const lag = own ? own.lag : lagByMealId.get(m.mealId);
        const dest = m.destination ?? st.bowlName;
        // 🔴 Part J.1b — A PLATE HOLDS PER PILE; A BOWL HOLDS WHOLE. A toppings plate is
        // separate piles, so each member keeps on its own window: the lettuce and
        // cilantro go on the plate Sunday and only the tomatoes wait. A mixed bowl (pico,
        // slaw, a marinade) is one mixture and keeps as its strictest member.
        const window = dest !== undefined && windowByName.has(dest) && !isPlate(dest) ? windowByName.get(dest)! : ownWindow(st, c);
        const held = lag !== undefined && lag > window;
        if (held) heldPortions.push({ mealId: m.mealId, ingredientName: c.ingredientName, cut: cutOf([m.preparationNote ?? c.preparationNote ?? ""]), window, lag: lag!, dest, ...(own ? { day: own.day, dish: m.forDish } : {}) });
        else kept.add(m.mealId);
        return !held;
      });
      if (keptMeasures.length > 0) keptComponents.push({ ...c, measures: keptMeasures });
    }
    if (heldPortions.length === 0) continue;
    const portionStep = st.portionLines !== undefined;
    // A narrated step cannot be re-written per meal: it waits only when ALL of it does.
    if (!portionStep && kept.size > 0) continue;
    const keptMealIds = st.contributesToMealIds.filter((m) => kept.has(m) || !touched.has(m));
    out.set(st.stepKey, {
      keptMealIds,
      heldMealIds: st.contributesToMealIds.filter((m) => !keptMealIds.includes(m)),
      all: keptComponents.length === 0,
      keptComponents,
      heldPortions,
    });
  }
  return out;
}

/** A toppings plate (R2): its members are separate piles. */
const isPlate = (name: string) => /\bplate$/i.test(name);

/** "finely diced" → "finely dice", for the cook-day list's verbs. */
const CUT_VERB: ReadonlyArray<[RegExp, string]> = [
  [/minced/, "mince"], [/diced/, "dice"], [/chopped/, "chop"], [/sliced/, "slice"], [/shredded/, "shred"],
  [/grated/, "grate"], [/zested and juiced/, "zest and juice"], [/juiced/, "juice"], [/zested/, "zest"], [/julienned/, "julienne"], [/halved/, "halve"],
  [/quartered/, "quarter"], [/trimmed/, "trim"], [/cubed/, "cube"], [/peeled/, "peel"], [/crushed/, "crush"],
  [/torn/, "tear"], [/cut/, "cut"],
];
/** The verb a held item takes: knife work, a squeeze, a zest, or the protein's own verb. */
function actionFor(cut: string | null, ingredientName: string, phase: string, verbs?: readonly string[]): string {
  if (phase === "proteins") return verbs && verbs.length > 0 ? `${verbs[0]} the ${ingredientName}` : `prep the ${ingredientName}`;
  if (cut) {
    const adverb = /^(finely|thinly|roughly|coarsely)\s/.exec(cut)?.[1];
    const v = CUT_VERB.find(([re]) => re.test(cut))?.[1];
    if (v) return `${adverb ? `${adverb} ` : ""}${v} the ${ingredientName}`;
  }
  if (/\bjuice\b/i.test(ingredientName)) return `squeeze the ${ingredientName}`;
  if (/\bzest\b/i.test(ingredientName)) return `zest the ${ingredientName}`;
  return `prep the ${ingredientName}`;
}
const listOf = (items: readonly string[]) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
/** "fresh flat-leaf parsley" → "parsley", for the tightest rung of the fit ladder. */
const bareName = (n: string) =>
  n.replace(/\b(fresh|boneless|skinless|bone-in|large|small|medium|ripe|english|roma|flat-leaf|leaves?)\b\s*/gi, "").trim() || n;

/** The wire caps each cook-day line at 200 characters and the list at 20. */
const LINE_MAX = 200;
const LIST_MAX = 20;

/**
 * 0c / Part J.1b — ONE cook-day list, ONE LINE PER MEAL, PREP ONLY.
 *
 * It carries what would have been a prep step and waits for the cook day: a portion
 * held for its window (R1), produce that browns once cut, and the marinade's cook-day
 * action. Never a lone measure, never a no-work item — D-WS9-299 says neither is prep,
 * and A10's Falafel Plate printed "measure the ground cumin" and "measure the ice
 * water" across four lines. Members are joined in one sentence with the weekday once:
 *   "Fresh Pico de Gallo (Saturday, 6 days out) — dice the roma tomatoes and the white
 *    onion that morning; add the skirt steak to the marinade the night before."
 * A line over 200 characters is fitted by naming the foods more briefly, never split.
 */
function heldLinesFor(
  plan: StepPlan,
  holds: ReadonlyMap<string, StepHold>,
  cookDays: {
    lagByMealId: ReadonlyMap<string, number>;
    dayNameByMealId: ReadonlyMap<string, string>;
    pastMealIds?: ReadonlySet<string>;
    prepDayIsToday?: boolean;
  },
  mealNameById: ReadonlyMap<string, string>,
  /** THX-3c (E) — the feast: a line per meal AND DAY, each portion on its own dish's day. */
  dayOf?: PortionDayOf,
  /** PREP-3 3c — the week's labels (engine name → label): a line says the container's. */
  labels?: ReadonlyMap<string, string>,
): string[] {
  const labelOf = (n: string) => labels?.get(n) ?? n;
  type Item = { food: string; action: string; dest?: string };
  // A line's key: the meal, or in the feast the meal and the day ("<mealId>|Wednesday").
  const work = new Map<string, Item[]>(); // line → prep items, first action per food
  const marinade = new Map<string, string[]>(); // mealId → marinade clauses
  const lineDay = new Map<string, PortionDay>(); // feast line → its day and lag
  const lineDishes = new Map<string, Set<string>>(); // feast line → the dishes on it
  const addWork = (mealId: string, it: Item, at?: PortionDay, dish?: string) => {
    const key = at ? `${mealId}|${at.day}` : mealId;
    if (at) {
      lineDay.set(key, at);
      if (dish) lineDishes.set(key, (lineDishes.get(key) ?? new Set()).add(dish));
    }
    const l = work.get(key) ?? [];
    if (!l.some((x) => x.food === it.food)) l.push(it);
    work.set(key, l);
  };
  for (const st of plan.steps) {
    const h = holds.get(st.stepKey);
    if (h) {
      // A held MEASURE (a dry blend's, a sauce jar's) is not prep work on cook day.
      if (st.phase === "seasonings_dry" || st.phase === "sauces_marinades") continue;
      for (const p of h.heldPortions) {
        addWork(
          p.mealId,
          { food: p.ingredientName, action: actionFor(p.cut, p.ingredientName, st.phase, st.knifeVerbs), ...(p.dest && isPlate(p.dest) ? { dest: p.dest } : {}) },
          p.day !== undefined ? { day: p.day, lag: p.lag } : undefined,
          p.dish,
        );
      }
      continue;
    }
    // PREP-1 (BUG-413) — over the 30-step cap: the whole step waits for cook day,
    // each meal's portion on that meal's line. A mixture is made, not cut.
    if (st.demoted?.reason === OVER_CAP_REASON) {
      for (const c of st.components) {
        for (const m of c.measures) {
          if (!m.mealId) continue;
          addWork(
            m.mealId,
            st.isBlend && st.bowlName
              ? { food: st.bowlName, action: `make the ${st.bowlName}` }
              : { food: c.ingredientName, action: actionFor(cutOf([m.preparationNote ?? c.preparationNote ?? ""]), c.ingredientName, st.phase, st.knifeVerbs) },
          );
        }
      }
      continue;
    }
    // Held for its CLASS: cut produce that browns once cut. A protein the engine
    // leaves for cook day has no knife work — a no-work item, so it is not listed.
    if (st.demoted?.reason === "does-not-hold") {
      for (const c of st.components) {
        for (const m of c.measures) {
          if (!m.mealId) continue;
          // THX-3c (E) — the feast's potatoes are cut the morning of THEIR day (Wednesday).
          addWork(m.mealId, { food: c.ingredientName, action: `cut the ${c.ingredientName} (it browns once cut)` }, dayOf?.(m, c.ingredientName), m.forDish);
        }
      }
    }
    // THX-3c (item 5) — A FEAST'S GARNISH IS NEVER DROPPED SILENTLY. Rule 7 drops a
    // single-dish garnish when the session is over its container target (Vegetarian's
    // chives): in the feast it becomes a line on the garnish's own day, "Mashed
    // Potatoes (Thursday, 3 days out) — thinly slice the fresh chives that morning."
    if (dayOf && st.demoted?.reason.startsWith("rule 7")) {
      for (const c of st.components) {
        for (const m of c.measures) {
          if (!m.mealId) continue;
          addWork(m.mealId, { food: c.ingredientName, action: actionFor(cutOf([m.preparationNote ?? c.preparationNote ?? ""]), c.ingredientName, st.phase, st.knifeVerbs) }, dayOf(m, c.ingredientName), m.forDish);
        }
      }
    }
  }
  // The marinade's cook-day action, folded into its meal's line.
  // PREP-3 3c — the week's marinade by its label ("add the chicken to the Skewers marinade"),
  // unless one meal's action names two marinades: then once, in its own words.
  const jarsOf = new Map<string, Map<string, Set<string>>>(); // mealId → action → marinades
  for (const [name, extra] of plan.containerExtras ?? new Map()) {
    if (!extra.joins?.length) continue;
    const meals = [...new Set(plan.steps.filter((s) => s.bowlName === name).flatMap((s) => s.contributesToMealIds))];
    for (const mealId of meals) {
      for (const j of extra.joins) {
        const action = marinadeCookDayAction(j, cookDays.lagByMealId.get(mealId));
        if (!action) continue;
        const byAction = jarsOf.get(mealId) ?? new Map<string, Set<string>>();
        byAction.set(action, (byAction.get(action) ?? new Set()).add(name));
        jarsOf.set(mealId, byAction);
      }
    }
  }
  for (const [mealId, byAction] of jarsOf) {
    marinade.set(mealId, [...byAction].map(([action, names]) => {
      const [name] = names;
      return names.size === 1 && labels?.has(name) ? action.replace(/ to the marinade\b/, ` to the ${labelOf(name)}`) : action;
    }));
  }

  const lines: string[] = [];
  const mealOfLine = (key: string) => key.split("|")[0];
  const lagOfLine = (key: string) => lineDay.get(key)?.lag ?? cookDays.lagByMealId.get(mealOfLine(key));
  const meals = [...new Set([...work.keys(), ...marinade.keys()])].sort(
    (a, b) => (lagOfLine(a) ?? 99) - (lagOfLine(b) ?? 99),
  );
  for (const key of meals) {
    const mealId = mealOfLine(key);
    const lag = lagOfLine(key);
    const day = lineDay.get(key)?.day ?? cookDays.dayNameByMealId.get(mealId);
    // PREP-3 (R6) — "today" only when the prep day IS today: a week starting Monday read
    // on Thursday said "(Monday, today)". Then lag 0 is the prep day itself.
    const ago = lag === 0 ? (cookDays.prepDayIsToday === false ? "prep day" : "today") : `${lag} ${lag === 1 ? "day" : "days"} out`;
    // BUG-359 — a day already gone is named, never called "today".
    const past = cookDays.pastMealIds?.has(mealId) ?? false;
    const when =
      lag === undefined || past ? (day ? ` (${day})` : "") : ` (${day ? `${day}, ` : ""}${ago})`;
    // THX-3c (E) — a feast line names the dishes it is for ("Mashed Potato Casserole
    // (Wednesday, 3 days out)"): the meal is the whole feast, every line's.
    const dishes = [...(lineDishes.get(key) ?? [])];
    const who = dishes.length > 0 && dishes.length <= 2 ? dishes.join(" and ") : (mealNameById.get(mealId) ?? "A planned meal");
    const head = `${who}${when} — `;
    const marinadeClauses = key === mealId ? (marinade.get(mealId) ?? []) : [];
    // A protein that joins its marinade the night before (or hours before) is handled
    // then, not "that morning" — one instruction per food.
    // PREP-3 (R8) — an avocado is never cut in the morning: it is cut at its step, so its
    // clause says so instead of "that morning" ("cut the ripe Hass avocados as you cook").
    const all = (work.get(key) ?? []).filter((i) => !marinadeClauses.some((c) => c.includes(`add the ${i.food} `)));
    const items = all.filter((i) => !CUT_AT_THE_STEP.test(i.food));
    const atStep = all.filter((i) => CUT_AT_THE_STEP.test(i.food)).map((i) => `${i.action.replace(/\s*\(it browns once cut\)$/, "")} as you cook (${/s$/i.test(i.food) ? "they brown" : "it browns"} once cut)`);
    const plates = [...new Set(items.map((i) => i.dest))];
    const onePlate = items.length > 0 && plates.length === 1 && plates[0] !== undefined ? plates[0] : null;
    const moment = lag === undefined ? "on cook day" : "that morning";
    const prepClause = (names: string[]) =>
      names.length === 0 ? "" : `${listOf(names)} ${moment}${onePlate ? ` and add ${items.length === 1 && !/s$/i.test(items[0].food) ? "it" : "them"} to the ${labelOf(onePlate)}` : ""}`;
    const sentence = (h: string, names: string[], marinades: string[]) =>
      `${h}${[prepClause(names), ...marinades].filter(Boolean).join("; ")}.`;
    const marinades = [...atStep, ...marinadeClauses];
    // The protein named briefly in its clause, for the tighter rungs.
    const bareMarinades = marinades.map((c) => c.replace(/^add the (.+?) to the /, (_m, who: string) => `add the ${bareName(who)} to the `));
    // The meal named briefly: its own dish, before " with …".
    const mealName = who;
    const shortHead = `${mealName.split(/\s+with\s+|,\s*/)[0]}${when} — `;
    // The fit ladder, under each head: the actions; the foods named plainly; the foods
    // and the protein named briefly; the first foods and a count. One line, whole
    // words, whatever happens.
    const ladder = (h: string): string[] => {
      const out = [
        sentence(h, items.map((i) => i.action), marinades),
        sentence(h, items.length ? [`prep the ${listOf(items.map((i) => i.food))}`] : [], marinades),
        sentence(h, items.length ? [`prep the ${listOf(items.map((i) => bareName(i.food)))}`] : [], bareMarinades),
      ];
      for (let k = items.length - 1; k >= 1; k--) {
        out.push(sentence(h, [`prep the ${items.slice(0, k).map((i) => bareName(i.food)).join(", ")} and ${items.length - k} more`], bareMarinades));
      }
      return out;
    };
    const rungs = [...ladder(head), ...ladder(shortHead)];
    const line = rungs.find((r) => r.length <= LINE_MAX)
      ?? `${rungs[rungs.length - 1].slice(0, LINE_MAX - 1).replace(/\s+\S*$/, "")}…`;
    lines.push(line);
  }
  return lines.slice(0, LIST_MAX);
}

/**
 * A step the cook can tick on screen, and therefore one `isPrepped` waits for.
 * The same facts the wire is built from: `demoted` becomes `skipSuggested`
 * (assemblePrepWeekResult), a cook-day line or the wash `holdsNoContainer`, and a
 * step whose every portion waits for cook day (R1) is `skipSuggested` by
 * `finishPrepWeek`, which reads the same `holds`.
 */
export function isTickable(step: PlannedStep, build: Pick<PrepWeekBuild, "holds">): boolean {
  if (step.demoted || step.holdsNoContainer || step.cookDaySentence) return false;
  return !build.holds.get(step.stepKey)?.all;
}

export interface PrepStepRef {
  stepKey: string;
  contributesToMealIds: string[];
}

export function tickableStepRefs(build: PrepWeekBuild): PrepStepRef[] {
  return build.stepPlan.steps
    .filter((s) => isTickable(s, build))
    .map((s) => ({
      stepKey: s.stepKey,
      // A meal whose every portion in this step waits for cook day does not wait for it.
      contributesToMealIds: build.holds.get(s.stepKey)?.keptMealIds ?? s.contributesToMealIds,
    }));
}

/**
 * A partial hold changes a step's amounts, and the narrator's opening states them
 * ("Juice the lemons to make 6 tbsp"). Each component's plan-time total that appears
 * in the opening is swapped for today's; one that does not appear is left alone.
 */
function retotal(opening: string, before: PrepNarrationComponent[], after: PrepNarrationComponent[]): string {
  const was = componentTotals(before);
  const now = componentTotals(after);
  let out = opening;
  for (const [name, parts] of was) {
    const next = now.get(name) ?? [];
    parts.forEach((p, i) => {
      const q = next[i];
      if (q && q !== p && out.includes(p)) out = out.replace(p, q);
    });
  }
  return out;
}

/**
 * Part J.1b — the opening names the cuts the step does ("Work through 2 yellow
 * onions: thinly sliced, finely diced and chopped."). A cut whose every portion is
 * held for cook day is not done today, so it leaves the list: "…thinly sliced and
 * finely diced." Only the "<verb> …: a, b and c." shape is rewritten.
 */
export function dropHeldCuts(opening: string, before: PrepNarrationComponent[], after: PrepNarrationComponent[]): string {
  const cutsOf = (cs: PrepNarrationComponent[]) =>
    new Set(cs.flatMap((c) => c.measures.map((m) => cutOf([m.preparationNote ?? c.preparationNote ?? ""]))).filter((x): x is string => !!x));
  const was = cutsOf(before);
  const now = cutsOf(after);
  const gone = [...was].filter((c) => !now.has(c));
  if (gone.length === 0) return opening;
  const m = /^(.*?:\s*)(.+?)(\.?)$/.exec(opening);
  if (!m) return opening;
  const items = m[2].split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
  // An item is the cut it names exactly, else the longest cut it ends with — the
  // narrator writes "roughly chopped" where the engine's cut is "chopped", and a kept
  // "finely diced" must not be dropped for a held "diced".
  const all = [...new Set([...was, ...now])];
  const cutOfItem = (it: string) => {
    const t = it.toLowerCase();
    return all.find((c) => c === t) ?? all.filter((c) => t.endsWith(` ${c}`)).sort((a, b) => b.length - a.length)[0];
  };
  const kept = items.filter((it) => !gone.includes(cutOfItem(it) ?? ""));
  if (kept.length === items.length || kept.length === 0) return opening;
  return `${m[1]}${listOf(kept)}${m[3] || "."}`;
}

/**
 * Part J.1 — everything that depends on TODAY, applied to an assembled (or cached)
 * result: the holds (R1), the portion lines re-rendered from the plan, the protein
 * titles (0f), the storage overlay, and ONE cook-day list (0c). The route calls this
 * on both cache paths; the census and the tests call it too, so what they measure is
 * what is served.
 */
export function finishPrepWeek(result: PrepWeekResult, build: PrepWeekBuild): PrepWeekResult {
  // SERVER-12 C — a held feast portion is re-totalled here: the cup ladder as it was.
  return build.feast ? withCupLadder(() => finish(result, build)) : finish(result, build);
}

function finish(result: PrepWeekResult, build: PrepWeekBuild): PrepWeekResult {
  const byKey = new Map(build.stepPlan.steps.map((s) => [s.stepKey, s]));
  // SERVER-12 A — a week's links are today's, like its holds: a cached step carries the
  // links of the build that narrated it, so a link rule (BUG-626) or a hold that moved
  // since never reached a warm cache. (The feast session's stay as narrated: frozen.)
  const linked = (w: PrepWeekStep, planned: PlannedStep): PrepWeekStep => {
    if (build.feast) return w;
    const { coversCookSteps: _was, ...rest } = w;
    return planned.coversCookSteps?.length ? { ...rest, coversCookSteps: planned.coversCookSteps } : rest;
  };
  const steps = (phase: PrepWeekResult["phases"][number]) =>
    phase.steps.map((cached): PrepWeekStep => {
      const planned = byKey.get(cached.stepKey);
      if (!planned) return cached;
      const w = linked(cached, planned);
      const h = build.holds.get(w.stepKey);
      if (h?.all) {
        const names = [...new Set(planned.components.map((c) => c.ingredientName))];
        return { ...w, skipSuggested: true, title: nounFormTitle(names).slice(0, 120) };
      }
      let out: PrepWeekStep = w;
      if (planned.portionLines) {
        const components = h ? h.keptComponents : planned.components;
        const opening = h
          ? dropHeldCuts(retotal(openingSentence(w.instructions), planned.components, components), planned.components, components)
          : openingSentence(w.instructions);
        out = {
          ...out,
          instructions: composePortionStep(opening, components, build.stepPlan.labelKinds ?? new Map()),
          ...(h ? { contributesToMealIds: h.keptMealIds } : {}),
        };
      }
      // 0f — a protein's title names its dish, so its container is findable on screen.
      if (planned.phase === "proteins" && !out.skipSuggested) {
        const keptDishes = [...new Set((h ? h.keptComponents : planned.components).flatMap((c) => c.measures.map((m) => m.forDish)))];
        if (keptDishes.length > 0 && !keptDishes.some((d) => out.title.includes(d))) {
          const full = `${out.title} — ${keptDishes.join(", ")}`;
          out = { ...out, title: full.length <= 120 ? full : `${out.title} — ${keptDishes.length} dishes`.slice(0, 120) };
        }
      }
      // THX-3 (BUG-426 b) — the feast container's closing line, on the step that
      // closes it. Whole or not at all: the wire caps instructions at 800.
      const close = build.closingLines?.get(w.stepKey);
      if (close && !out.skipSuggested && !out.instructions.includes(close)) {
        const next = `${out.instructions}\n${close}`;
        if (next.length <= 800) out = { ...out, instructions: next };
      }
      // SERVER-7 D — the feast's label step is narrated (fixedProse) and cached, so its
      // count is put on here, and only when the served title says today's count.
      const labelled = build.stepPlan.feastLabels?.ordered.length;
      if (w.stepKey === FEAST_LABEL_STEP_KEY && labelled && out.title === `Label ${labelled} containers`) {
        out = { ...out, labelCount: labelled };
      }
      return out;
    });
  const held = { phases: result.phases.map((p) => ({ ...p, steps: steps(p) })) };
  const overlaid = applyStorageOverlay({ ...result, ...held }, build.storageContexts);
  // The reason a held step waits, written AFTER the overlay (which clears the
  // storage line of any step that is not done): "This one is 5 days out — leave it
  // for cook day."
  const reasons = (s: PrepWeekStep): PrepWeekStep => {
    const h = build.holds.get(s.stepKey);
    if (!h?.all) return s;
    const lag = Math.max(...h.heldPortions.map((x) => x.lag));
    return { ...s, storageNote: `This one is ${lag} days out — leave it for cook day.` };
  };
  const finished: PrepWeekResult = {
    ...overlaid,
    phases: overlaid.phases.map((ph) => ({ ...ph, steps: ph.steps.map(reasons) })).map((p) => {
      if (p.phase !== "proteins") return p;
      const merged = [...new Set([...build.heldLines, ...(p.heldForCookDay ?? [])])].slice(0, LIST_MAX);
      const { heldForCookDay: _old, ...rest } = p;
      return merged.length > 0 ? { ...rest, heldForCookDay: merged } : rest;
    }),
  };
  // PREP-3 (R3) — the week's labels, last: every string of the served week says them.
  // SERVER-6 BUG-534 — then a mix is said with its bowl ("Get a small bowl for the …").
  return build.weekLabels
    ? mixBowlWording(labelWeekResult(finished, build.weekLabels), build.weekLabels.labels.kinds)
    : finished;
}

/**
 * Part J.0 (A4) — which cook steps each prep step did the work of.
 *
 * A cook step tagged `prep` is COVERED when every ingredient its `amountRefs` name
 * is in a tickable prep step for that meal and dish (a portion held for cook day is
 * not). Each prep step that handles one of its ingredients lists it, so the client
 * can collapse it to "done in prep" once all of them are ticked. Strict on purpose:
 * a step whose salt, oil or buttermilk was never prepped is not done, and
 * collapsing it would hide the part the cook still has to do.
 *
 * The amountRef ids are the dish's own; the step plan's are the plan's folded food
 * identity, so the join goes through `identity` exactly as combinePrep did.
 *
 * 🔴 SERVER-12 A (BUG-626) — AND THE FOODS ITS WORDS NAME. A food the text names
 * without an amount has no amountRef: "Finely dice the yellow onion and set aside"
 * linked to nothing, and "Finely dice the yellow onion and mince the remaining 2
 * garlic cloves" only to the garlic, so ticking the onion folded nothing and drew
 * no chip (INV-626). A step is also covered when every food its words name (the
 * app's own matching, prepFoods.ts namedFoods) and every food its amountRefs name
 * is in a tickable prep step; then each of those prep steps lists it. Still all or
 * nothing: one named food nobody prepped and the words link nothing (the refs keep
 * their own rule). The app folds a covered step only when every covering step is
 * ticked and their words say each food, so the rule that every named food is prepped
 * first holds on both sides. Not in the feast: its Cook Mode is worded from its own
 * session ("Skip if you prepped"), and Thanksgiving's structure is frozen.
 */
function assignCoversCookSteps(build: PrepWeekBuild, load: Pick<Load, "input" | "identity">, opts: { feast?: boolean } = {}): void {
  const folded = (id: string) => load.identity?.foldedIdByIngredientId.get(id) ?? id;
  const stepsByPortion = new Map<string, PlannedStep[]>();
  for (const st of build.stepPlan.steps) {
    if (!isTickable(st, build)) continue;
    const h = build.holds.get(st.stepKey);
    for (const c of h ? h.keptComponents : st.components) {
      for (const m of c.measures) {
        if (!m.mealId || !m.dishId || !m.ingredientId) continue;
        // (PREP-3 R4 — a marinade's own oil is measured under `<id>|mix`; the step's ref is the oil's.)
        const k = `${m.mealId}|${m.dishId}|${m.ingredientId.endsWith(MIX_STAPLE) ? m.ingredientId.slice(0, -MIX_STAPLE.length) : m.ingredientId}`;
        const l = stepsByPortion.get(k) ?? [];
        if (!l.includes(st)) l.push(st);
        stepsByPortion.set(k, l);
      }
    }
  }
  const inPlan = new Set(build.stepPlan.steps.flatMap((s) => s.contributesToMealIds));
  for (const meal of load.input.meals) {
    if (!inPlan.has(meal.mealId)) continue;
    for (const dish of meal.dishes) {
      const stepsOf = (id: string) => stepsByPortion.get(`${meal.mealId}|${dish.dishId}|${folded(id)}`) ?? [];
      for (const cs of dish.componentSteps) {
        if (cs.phaseType !== "prep") continue;
        const covering = cs.ingredientIds.map(stepsOf);
        const byRefs = covering.length > 0 && covering.every((l) => l.length > 0);
        // A named food is covered when one of the dish's rows of it is ("garlic" and
        // "garlic cloves" are one food to the app).
        const named = opts.feast ? [] : namedFoods(cs.text, dish.ingredients.map((i) => i.ingredientName)).map((f) =>
          dish.ingredients
            .filter((i) => { const o = foodOf(i.ingredientName); return !!o && o.head === f.head && o.before === f.before; })
            .flatMap((i) => stepsOf(i.ingredientId)));
        const byWords = named.length > 0 && named.every((l) => l.length > 0) && covering.every((l) => l.length > 0);
        if (!byRefs && !byWords) continue;
        for (const st of new Set([...covering.flat(), ...(byWords ? named.flat() : [])])) {
          const list = (st.coversCookSteps ??= []);
          if (!list.some((x) => x.mealId === meal.mealId && x.dishId === dish.dishId && x.stepIndex === cs.stepIndex)) {
            list.push({ mealId: meal.mealId, dishId: dish.dishId, stepIndex: cs.stepIndex });
          }
        }
      }
    }
  }
}

// Re-exported for callers that classify a step's own food (census, tests).
export { storageClassFor };
