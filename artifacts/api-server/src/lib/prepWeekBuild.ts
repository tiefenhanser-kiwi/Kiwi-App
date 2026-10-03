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
  heldPortions: { mealId: string; ingredientName: string; cut: string | null; window: number; lag: number }[];
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

  const closesByStepKey = storageClosesByStepKey(stepPlan.steps, stepPlan.containerExtras);
  const holds = opts.noHolds ? new Map<string, StepHold>() : computeHolds(stepPlan, closesByStepKey, cookDays.lagByMealId);

  const mealNameById = new Map(input.meals.map((m) => [m.mealId, m.mealName]));
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
        const window = dest !== undefined && windowByName.has(dest) ? windowByName.get(dest)! : ownWindow(st, c);
        const held = lag !== undefined && lag > window;
        if (held) heldPortions.push({ mealId: m.mealId, ingredientName: c.ingredientName, cut: cutOf([m.preparationNote ?? c.preparationNote ?? ""]), window, lag: lag! });
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

/** "finely diced" → "finely dice", for the cook-day list's verbs. */
const CUT_VERB: ReadonlyArray<[RegExp, string]> = [
  [/minced/, "mince"], [/diced/, "dice"], [/chopped/, "chop"], [/sliced/, "slice"], [/shredded/, "shred"],
  [/grated/, "grate"], [/juiced/, "juice"], [/zested/, "zest"], [/julienned/, "julienne"], [/halved/, "halve"],
  [/quartered/, "quarter"], [/trimmed/, "trim"], [/cubed/, "cube"], [/peeled/, "peel"], [/crushed/, "crush"],
  [/torn/, "tear"], [/cut/, "cut"],
];
/**
 * The verb a held item takes on the cook-day list. A measure is measured and a
 * juice squeezed — "cut the ground cumin" and "cut the tahini" were the first draft.
 */
function actionFor(cut: string | null, ingredientName: string, phase: string, verbs?: readonly string[]): string {
  if (phase === "proteins") return verbs && verbs.length > 0 ? `${verbs[0]} the ${ingredientName}` : `prep the ${ingredientName}`;
  if (phase === "seasonings_dry" || phase === "sauces_marinades") return `measure the ${ingredientName}`;
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

/** The wire caps each cook-day line at 200 characters and the list at 20. */
const LINE_MAX = 200;
const LIST_MAX = 20;

/**
 * 0c — ONE cook-day list, every cook-day item, no duplicates: the portions held for
 * their window (R1), the proteins the engine leaves for cook day, and the produce
 * that browns once cut. Per meal: "Fresh Pico de Gallo (Saturday, 6 days out) — dice
 * the roma tomatoes and the white onion that morning." and, for a protein with no
 * knife work, "Supreme Pizza (Sunday, today) — straight from the package: the Italian
 * sausage." One food is named once per meal. A line that would pass 200 characters is
 * split at an item, never mid-word.
 */
function heldLinesFor(
  plan: StepPlan,
  holds: ReadonlyMap<string, StepHold>,
  cookDays: { lagByMealId: ReadonlyMap<string, number>; dayNameByMealId: ReadonlyMap<string, string> },
  mealNameById: ReadonlyMap<string, string>,
): string[] {
  const work = new Map<string, Map<string, string>>(); // mealId → food → action
  const pkg = new Map<string, string[]>();
  const addWork = (mealId: string, food: string, action: string) => {
    const m = work.get(mealId) ?? new Map<string, string>();
    if (!m.has(food)) m.set(food, action);
    work.set(mealId, m);
  };
  for (const st of plan.steps) {
    const h = holds.get(st.stepKey);
    if (h) {
      for (const p of h.heldPortions) addWork(p.mealId, p.ingredientName, actionFor(p.cut, p.ingredientName, st.phase, st.knifeVerbs));
      continue;
    }
    if (!st.demoted) continue;
    for (const c of st.components) {
      for (const id of [...new Set(c.measures.map((m) => m.mealId).filter((x): x is string => !!x))]) {
        if (st.phase === "proteins") {
          const l = pkg.get(id) ?? [];
          if (!l.includes(`the ${c.ingredientName}`)) l.push(`the ${c.ingredientName}`);
          pkg.set(id, l);
        } else if (st.demoted.reason === "does-not-hold") {
          addWork(id, c.ingredientName, `cut the ${c.ingredientName} (it browns once cut)`);
        }
      }
    }
  }
  const lines: string[] = [];
  const fit = (head: string, items: readonly string[], tail: string) => {
    let chunk: string[] = [];
    for (const it of items) {
      if (`${head}${listOf([...chunk, it])}${tail}`.length > LINE_MAX && chunk.length > 0) {
        lines.push(`${head}${listOf(chunk)}${tail}`);
        chunk = [it];
      } else chunk.push(it);
    }
    if (chunk.length > 0) {
      const line = `${head}${listOf(chunk)}${tail}`;
      lines.push(line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 1).replace(/\s+\S*$/, "")}…`);
    }
  };
  // In cook-day order, so the list reads like the week.
  const meals = [...new Set([...work.keys(), ...pkg.keys()])].sort(
    (a, b) => (cookDays.lagByMealId.get(a) ?? 99) - (cookDays.lagByMealId.get(b) ?? 99),
  );
  for (const mealId of meals) {
    const lag = cookDays.lagByMealId.get(mealId);
    const day = cookDays.dayNameByMealId.get(mealId);
    const ago = lag === 0 ? "today" : `${lag} ${lag === 1 ? "day" : "days"} out`;
    const when = lag === undefined ? (day ? ` (${day})` : "") : ` (${day ? `${day}, ` : ""}${ago})`;
    const head = `${mealNameById.get(mealId) ?? "A planned meal"}${when} — `;
    const w = [...(work.get(mealId)?.values() ?? [])];
    if (w.length > 0) fit(head, w, lag === undefined ? " on cook day." : " that morning.");
    const p = pkg.get(mealId) ?? [];
    if (p.length > 0) fit(`${head}straight from the package: `, p, ".");
  }
  return lines;
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
        const opening = h ? retotal(openingSentence(w.instructions), planned.components, components) : openingSentence(w.instructions);
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
