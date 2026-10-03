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

import type { LoadPrepWeekInputResult } from "./prepWeekAggregation";
import { buildPrepCombineInput } from "./prepCombineAdapter";
import { combinePrep } from "./prepCombineEngine";
import { cutOf } from "./prepClasses";
import {
  buildStepPlan,
  componentTotals,
  openingSentence,
  renderPortionLines,
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
  heldPortions: { mealId: string; ingredientName: string; cut: string | null; window: number; lag: number; dest?: string }[];
}

export interface PrepWeekBuild {
  stepPlan: StepPlan;
  /** stepKey → what the storage overlay needs, from today's cook days. */
  storageContexts: Map<string, StorageContext>;
  /** stepKey → today's holds (R1). Absent for a step with nothing held. */
  holds: Map<string, StepHold>;
  /** The cook-day list's lines that come from the step plan (0c), before the overlay's. */
  heldLines: string[];
}

export interface BuildPrepWeekOptions {
  /** Prep Selected Meals: the plan is built whole, then scoped (A3). */
  scopeMealIds?: readonly string[];
  /** Census only: compute no holds (to count expired windows the old way). */
  noHolds?: boolean;
}

type Load = Pick<LoadPrepWeekInputResult, "input" | "cookDays" | "identity">;

export function buildPrepWeekPlan(load: Load, opts: BuildPrepWeekOptions = {}): PrepWeekBuild {
  const { input, identity } = load;
  // An older caller (or a hand-built test loader) carries no cook days: that is
  // "no day known", the same as a plan with no startDate.
  const cookDays = load.cookDays ?? { prepDay: null, lagByMealId: new Map(), dayNameByMealId: new Map() };
  const combineResult = combinePrep(buildPrepCombineInput(input), identity?.foldedIdByIngredientId);
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
    opts.scopeMealIds ? { scopeMealIds: new Set(opts.scopeMealIds) } : {},
  );

  const closesByStepKey = storageClosesByStepKey(stepPlan.steps, stepPlan.containerExtras, stepPlan.labelKinds);
  const holds = opts.noHolds ? new Map<string, StepHold>() : computeHolds(stepPlan, closesByStepKey, cookDays.lagByMealId);

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
    const lags = meals.map((id) => cookDays.lagByMealId.get(id)).filter((n): n is number => n !== undefined);
    const dayName = latest ? cookDays.dayNameByMealId.get(latest.id) : undefined;
    const mealName = latest ? mealNameById.get(latest.id) : undefined;
    // A partly held step closes only the containers it still fills today.
    const hold = holds.get(st.stepKey);
    const stillFilled = hold && !hold.all
      ? new Set([st.bowlName, ...hold.keptComponents.flatMap((c) => c.measures.map((m) => m.destination))].filter((x): x is string => !!x))
      : null;
    const closes = closesByStepKey.get(st.stepKey)?.filter((c) => !stillFilled || stillFilled.has(c.name)).map((c) => ({
      ...c,
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

  const build: PrepWeekBuild = {
    stepPlan,
    storageContexts,
    holds,
    heldLines: heldLinesFor(stepPlan, holds, cookDays, mealNameById),
  };
  assignCoversCookSteps(build, load);
  return build;
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
        const lag = lagByMealId.get(m.mealId);
        const dest = m.destination ?? st.bowlName;
        // 🔴 Part J.1b — A PLATE HOLDS PER PILE; A BOWL HOLDS WHOLE. A toppings plate is
        // separate piles, so each member keeps on its own window: the lettuce and
        // cilantro go on the plate Sunday and only the tomatoes wait. A mixed bowl (pico,
        // slaw, a marinade) is one mixture and keeps as its strictest member.
        const window = dest !== undefined && windowByName.has(dest) && !isPlate(dest) ? windowByName.get(dest)! : ownWindow(st, c);
        const held = lag !== undefined && lag > window;
        if (held) heldPortions.push({ mealId: m.mealId, ingredientName: c.ingredientName, cut: cutOf([m.preparationNote ?? c.preparationNote ?? ""]), window, lag: lag!, dest });
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
  [/grated/, "grate"], [/juiced/, "juice"], [/zested/, "zest"], [/julienned/, "julienne"], [/halved/, "halve"],
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
  cookDays: { lagByMealId: ReadonlyMap<string, number>; dayNameByMealId: ReadonlyMap<string, string> },
  mealNameById: ReadonlyMap<string, string>,
): string[] {
  type Item = { food: string; action: string; dest?: string };
  const work = new Map<string, Item[]>(); // mealId → prep items, first action per food
  const marinade = new Map<string, string[]>(); // mealId → marinade clauses
  const addWork = (mealId: string, it: Item) => {
    const l = work.get(mealId) ?? [];
    if (!l.some((x) => x.food === it.food)) l.push(it);
    work.set(mealId, l);
  };
  for (const st of plan.steps) {
    const h = holds.get(st.stepKey);
    if (h) {
      // A held MEASURE (a dry blend's, a sauce jar's) is not prep work on cook day.
      if (st.phase === "seasonings_dry" || st.phase === "sauces_marinades") continue;
      for (const p of h.heldPortions) {
        addWork(p.mealId, { food: p.ingredientName, action: actionFor(p.cut, p.ingredientName, st.phase, st.knifeVerbs), ...(p.dest && isPlate(p.dest) ? { dest: p.dest } : {}) });
      }
      continue;
    }
    // Held for its CLASS: cut produce that browns once cut. A protein the engine
    // leaves for cook day has no knife work — a no-work item, so it is not listed.
    if (st.demoted?.reason === "does-not-hold") {
      for (const c of st.components) {
        for (const id of [...new Set(c.measures.map((m) => m.mealId).filter((x): x is string => !!x))]) {
          addWork(id, { food: c.ingredientName, action: `cut the ${c.ingredientName} (it browns once cut)` });
        }
      }
    }
  }
  // The marinade's cook-day action, folded into its meal's line.
  for (const [name, extra] of plan.containerExtras ?? new Map()) {
    if (!extra.joins?.length) continue;
    const meals = [...new Set(plan.steps.filter((s) => s.bowlName === name).flatMap((s) => s.contributesToMealIds))];
    for (const mealId of meals) {
      for (const j of extra.joins) {
        const clause = marinadeCookDayAction(j, cookDays.lagByMealId.get(mealId));
        if (!clause) continue;
        const l = marinade.get(mealId) ?? [];
        if (!l.includes(clause)) l.push(clause);
        marinade.set(mealId, l);
      }
    }
  }

  const lines: string[] = [];
  const meals = [...new Set([...work.keys(), ...marinade.keys()])].sort(
    (a, b) => (cookDays.lagByMealId.get(a) ?? 99) - (cookDays.lagByMealId.get(b) ?? 99),
  );
  for (const mealId of meals) {
    const lag = cookDays.lagByMealId.get(mealId);
    const day = cookDays.dayNameByMealId.get(mealId);
    const ago = lag === 0 ? "today" : `${lag} ${lag === 1 ? "day" : "days"} out`;
    const when = lag === undefined ? (day ? ` (${day})` : "") : ` (${day ? `${day}, ` : ""}${ago})`;
    const head = `${mealNameById.get(mealId) ?? "A planned meal"}${when} — `;
    const marinadeClauses = marinade.get(mealId) ?? [];
    // A protein that joins its marinade the night before (or hours before) is handled
    // then, not "that morning" — one instruction per food.
    const items = (work.get(mealId) ?? []).filter((i) => !marinadeClauses.some((c) => c.includes(`add the ${i.food} `)));
    const plates = [...new Set(items.map((i) => i.dest))];
    const onePlate = items.length > 0 && plates.length === 1 && plates[0] !== undefined ? plates[0] : null;
    const moment = lag === undefined ? "on cook day" : "that morning";
    const prepClause = (names: string[]) =>
      names.length === 0 ? "" : `${listOf(names)} ${moment}${onePlate ? ` and add ${items.length === 1 && !/s$/i.test(items[0].food) ? "it" : "them"} to the ${onePlate}` : ""}`;
    const sentence = (h: string, names: string[], marinades: string[]) =>
      `${h}${[prepClause(names), ...marinades].filter(Boolean).join("; ")}.`;
    const marinades = marinadeClauses;
    // The protein named briefly in its clause, for the tighter rungs.
    const bareMarinades = marinades.map((c) => c.replace(/^add the (.+?) to the marinade/, (_m, who: string) => `add the ${bareName(who)} to the marinade`));
    // The meal named briefly: its own dish, before " with …".
    const mealName = mealNameById.get(mealId) ?? "A planned meal";
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
  const byKey = new Map(build.stepPlan.steps.map((s) => [s.stepKey, s]));
  const steps = (phase: PrepWeekResult["phases"][number]) =>
    phase.steps.map((w): PrepWeekStep => {
      const planned = byKey.get(w.stepKey);
      if (!planned) return w;
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
        const lines = renderPortionLines({ components }, build.stepPlan.labelKinds, 800 - opening.length - 1)?.lines ?? [];
        out = {
          ...out,
          instructions: lines.length > 0 ? `${opening}\n${lines.join("\n")}` : opening,
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
  return {
    ...overlaid,
    phases: overlaid.phases.map((ph) => ({ ...ph, steps: ph.steps.map(reasons) })).map((p) => {
      if (p.phase !== "proteins") return p;
      const merged = [...new Set([...build.heldLines, ...(p.heldForCookDay ?? [])])].slice(0, LIST_MAX);
      const { heldForCookDay: _old, ...rest } = p;
      return merged.length > 0 ? { ...rest, heldForCookDay: merged } : rest;
    }),
  };
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
 */
function assignCoversCookSteps(build: PrepWeekBuild, load: Pick<Load, "input" | "identity">): void {
  const folded = (id: string) => load.identity?.foldedIdByIngredientId.get(id) ?? id;
  const stepsByPortion = new Map<string, PlannedStep[]>();
  for (const st of build.stepPlan.steps) {
    if (!isTickable(st, build)) continue;
    const h = build.holds.get(st.stepKey);
    for (const c of h ? h.keptComponents : st.components) {
      for (const m of c.measures) {
        if (!m.mealId || !m.dishId || !m.ingredientId) continue;
        const k = `${m.mealId}|${m.dishId}|${m.ingredientId}`;
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
      for (const cs of dish.componentSteps) {
        if (cs.phaseType !== "prep" || cs.ingredientIds.length === 0) continue;
        const covering = cs.ingredientIds.map((id) => stepsByPortion.get(`${meal.mealId}|${dish.dishId}|${folded(id)}`));
        if (covering.some((l) => !l || l.length === 0)) continue;
        for (const st of new Set(covering.flat() as PlannedStep[])) {
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
