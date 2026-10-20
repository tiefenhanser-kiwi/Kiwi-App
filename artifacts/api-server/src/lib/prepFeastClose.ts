// THX-3 (BUG-426 b) — "THAT'S THE PIE FILLING BASE. ON WEDNESDAY, WHISK IN…"
//
// A feast container is made days before it is used, and nothing said what it
// was for: Make-Ahead's pie "dry mix" silently left out the eggs and cream, and
// Hans asked for the brine's step to say "add the gallon of water". So each
// container's closing step carries one line, BUILT IN CODE from the recipe step
// its members enter at — the way the marinade's join line is built — saying what
// joins it there and on which day:
//
//   "That's the Pumpkin Pie dry mix. On Wednesday, whisk it into the 24 oz canned
//    pumpkin purée, 3 large eggs, 1¼ cup heavy cream and 1½ tsp vanilla extract."
//
// Pure. Date-free (the day is the RECIPE's day, "Make ahead (Wednesday):"), so it
// is computed with the build and appended at finish, never cached in prose.

import type { ComponentStep } from "./prepComponents";
import type { PrepCombineInput } from "./prepCombineEngine";
import { isNeverMeasured } from "./prepCombineEngine";
import type { PlannedStep } from "./prepWeekAssembly";
import { formatMeasure } from "./prepWeekAssembly";
import { proseNames } from "./prepMoments";
import { ingredientGroupKey } from "./ingredientRelations";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** THX-2G-E's step phrases: "Make ahead (Tuesday night):", "On Thursday:". */
const MAKE_AHEAD = /^\s*Make ahead \(([A-Za-z]+)( night)?\):/i;
const ON_DAY = /^\s*On ([A-Za-z]+day):/i;

export interface StepDay {
  /** "Wednesday". */
  day: string;
  night: boolean;
}

function weekday(name: string): string | null {
  const hit = WEEKDAYS.find((d) => d.toLowerCase() === name.trim().toLowerCase());
  return hit ?? null;
}

/**
 * The day a dish's step is cooked on, by the recipe's own phrases: the nearest
 * "Make ahead (<Day>):" or "On <Day>:" at or before it (THX-2G-F: the model
 * prefixes a run's first step). Null when the dish names no day before it.
 */
export function stepDayOf(steps: readonly Pick<ComponentStep, "stepIndex" | "text">[], stepIndex: number): StepDay | null {
  let out: StepDay | null = null;
  for (const s of [...steps].sort((a, b) => a.stepIndex - b.stepIndex)) {
    if (s.stepIndex > stepIndex) break;
    const m = MAKE_AHEAD.exec(s.text);
    if (m && weekday(m[1])) { out = { day: weekday(m[1])!, night: !!m[2] }; continue; }
    const o = ON_DAY.exec(s.text);
    if (o && weekday(o[1])) out = { day: weekday(o[1])!, night: false };
  }
  return out;
}

/** The verb the line uses, read off the entry step ("whisk together …" → whisk it into). */
const VERBS: ReadonlyArray<[RegExp, string]> = [
  [/\bwhisk/i, "whisk it into"],
  [/\bdissolve/i, "dissolve it in"],
  [/\bstir/i, "stir it into"],
  [/\bfold/i, "fold it into"],
  [/\bbeat/i, "beat it into"],
  [/\btoss/i, "toss it with"],
  [/\brub/i, "rub it over"],
  [/\b(?:combine|mix)/i, "combine it with"],
];

function listOf(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface ContainerUse {
  /** The container's name, as the step plan carries it. */
  name: string;
  dishId: string;
  mealId: string;
  /** The dish step its members enter at. */
  entryStep: number | null;
  day: StepDay | null;
}

export interface FeastLoadDish {
  dishId: string;
  componentSteps: readonly ComponentStep[];
}

/**
 * Every bowl container in a step plan (a step with a `bowlName`), with the dish
 * step its members enter at and that step's day. One container is one dish's.
 */
export function containerUses(
  steps: readonly PlannedStep[],
  dishesById: ReadonlyMap<string, FeastLoadDish>,
  combineInput: PrepCombineInput,
): ContainerUse[] {
  const out = new Map<string, ContainerUse>();
  const ingredientsOf = new Map<string, { ingredientId: string; ingredientName: string }[]>();
  for (const m of combineInput.meals) for (const d of m.dishes) ingredientsOf.set(d.dishId, d.ingredients);
  for (const st of steps) {
    if (!st.bowlName || st.demoted || out.has(st.bowlName)) continue;
    const measures = st.components.flatMap((c) => c.measures.map((m) => ({ ...m, name: c.ingredientName })));
    const first = measures.find((m) => m.dishId);
    if (!first?.dishId || !first.mealId) continue;
    const dish = dishesById.get(first.dishId);
    const members = memberIds(measures.filter((m) => m.dishId === first.dishId), ingredientsOf.get(first.dishId) ?? []);
    const entry = dish ? entryStepOf(dish.componentSteps, members.ids, members.names) : null;
    out.set(st.bowlName, {
      name: st.bowlName,
      dishId: first.dishId,
      mealId: first.mealId,
      entryStep: entry,
      day: dish && entry !== null ? stepDayOf(dish.componentSteps, entry) : null,
    });
  }
  return [...out.values()];
}

/** A container's members as the dish's OWN ingredient ids (the plan folds foods under one id). */
function memberIds(
  measures: readonly { ingredientId?: string; name: string }[],
  dishIngredients: readonly { ingredientId: string; ingredientName: string }[],
): { ids: Set<string>; names: string[] } {
  const ids = new Set<string>();
  const names = [...new Set(measures.map((m) => m.name))];
  const keys = new Set(names.map((n) => ingredientGroupKey(n)));
  for (const i of dishIngredients) {
    if (measures.some((m) => m.ingredientId === i.ingredientId) || keys.has(ingredientGroupKey(i.ingredientName))) ids.add(i.ingredientId);
  }
  return { ids, names };
}

function entryStepOf(steps: readonly ComponentStep[], ids: ReadonlySet<string>, names: readonly string[]): number | null {
  const ordered = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const byRef = ordered.find((s) => s.ingredientIds.some((id) => ids.has(id)));
  if (byRef) return byRef.stepIndex;
  const byName = ordered.find((s) => names.some((n) => proseNames(s.text, n)));
  return byName ? byName.stepIndex : null;
}

/**
 * stepKey → the closing line for every container that step closes. `closes` is
 * the step plan's own "last step to touch it" (H7 2b); a container whose bowl
 * step closes nothing (no later step touches it) closes on its bowl step.
 */
export function feastClosingLines(
  steps: readonly PlannedStep[],
  dishesById: ReadonlyMap<string, FeastLoadDish>,
  combineInput: PrepCombineInput,
): Map<string, string> {
  const uses = containerUses(steps, dishesById, combineInput);
  const scaled = new Map<string, { ingredientId: string; ingredientName: string; quantity: number; unit: string }[]>();
  for (const m of combineInput.meals) for (const d of m.dishes) scaled.set(d.dishId, d.ingredients);
  const lineOf = new Map<string, string>();
  for (const u of uses) {
    const dish = dishesById.get(u.dishId);
    if (!dish || u.entryStep === null) continue;
    const step = dish.componentSteps.find((s) => s.stepIndex === u.entryStep);
    if (!step) continue;
    const rows = scaled.get(u.dishId) ?? [];
    const members = new Set(
      steps
        .filter((s) => s.bowlName === u.name || s.components.some((c) => c.measures.some((m) => m.destination === u.name)))
        .flatMap((s) => s.components.map((c) => ingredientGroupKey(c.ingredientName))),
    );
    // A food this session already put in ANOTHER of the dish's containers joins as
    // that container ("…combine it with the Cranberry-Orange Sauce vegetables").
    const otherContainer = new Map<string, string>();
    for (const s of steps) {
      if (s.demoted) continue;
      for (const c of s.components) {
        for (const m of c.measures) {
          const into = m.destination ?? s.bowlName;
          if (m.dishId === u.dishId && into && into !== u.name) otherContainer.set(ingredientGroupKey(c.ingredientName), into);
        }
      }
    }
    const joins: string[] = [];
    for (const id of [...new Set(step.ingredientIds)]) {
      const row = rows.find((r) => r.ingredientId === id);
      if (!row || members.has(ingredientGroupKey(row.ingredientName))) continue;
      const elsewhere = otherContainer.get(ingredientGroupKey(row.ingredientName));
      if (elsewhere) {
        if (!joins.includes(elsewhere)) joins.push(elsewhere);
        continue;
      }
      // Equipment is not something that joins (water is: "dissolve it in the gallon of water").
      if (isNeverMeasured(row.ingredientName) && !/\bwater\b/i.test(row.ingredientName)) continue;
      const amount = formatMeasure(row.quantity, row.unit, row.ingredientName);
      // Mid-sentence, the catalog's capitals go ("2 Large eggs", "¼ cup Whole milk").
      const name = /^[A-Z][a-z]/.test(row.ingredientName) ? `${row.ingredientName[0].toLowerCase()}${row.ingredientName.slice(1)}` : row.ingredientName;
      joins.push(`${amount} ${name}`.trim());
    }
    const body = step.text.replace(MAKE_AHEAD, "").replace(ON_DAY, "");
    const verb = VERBS.find(([re]) => re.test(body))?.[1] ?? "add it to";
    const when = u.day ? `On ${u.day.day}${u.day.night ? " night" : ""}, ` : "On cook day, ";
    const line = joins.length > 0
      ? `That's the ${u.name}. ${when}${verb} the ${listOf(joins)}.`
      : `That's the ${u.name}. ${when.replace(/, $/, "")} it goes into the recipe.`;
    lineOf.set(u.name, line);
  }
  const out = new Map<string, string>();
  for (const st of steps) {
    if (st.demoted) continue;
    const closing = [...new Set([...(st.closes ?? []), ...(st.bowlName && !(st.closes ?? []).length && !steps.some((o) => o !== st && (o.closes ?? []).includes(st.bowlName!)) ? [st.bowlName] : [])])];
    const lines = closing.map((n) => lineOf.get(n)).filter((x): x is string => !!x);
    if (lines.length > 0) out.set(st.stepKey, lines.join(" "));
  }
  return out;
}
