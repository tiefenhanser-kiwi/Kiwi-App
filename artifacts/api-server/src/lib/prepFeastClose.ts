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
import { isNeverMeasured, isSaltOrPepper } from "./prepCombineEngine";
import type { PlannedStep } from "./prepWeekAssembly";
import { formatMeasure } from "./prepWeekAssembly";
import { proseNames } from "./prepMoments";
import { ingredientGroupKey } from "./ingredientRelations";
import { deriveAmountRefs } from "./stepAmountRefs";
import { convertAmount } from "./feastAmountWalk";
import { packageUse } from "./prepQuantity";

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

/** A later step that uses the mixture by name ("the salt mixture", "the spice blend"). */
const MIXTURE_WORD = /\b(mixture|blend|seasoning|rub|dry mix)\b/i;

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

/** Where a food's name first appears in a sentence (its last word, singular), for ordering. */
function positionOf(lowerText: string, name: string): number {
  // The HEAD noun — the last word ("large eggs" is found at "eggs", not at "In a large bowl").
  const words = name.toLowerCase().replace(/[^a-zà-ÿ\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const head = words[words.length - 1];
  if (!head) return Number.MAX_SAFE_INTEGER;
  const i = lowerText.indexOf(head.replace(/(?:es|s)$/, ""));
  return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
}

/** A protein is named by its head noun ("Rub the salt mixture all over the turkey" — the whole turkey). */
function namesProtein(lowerText: string, row: { ingredientName: string; category: string }): boolean {
  if (row.category.trim().toLowerCase() !== "protein") return false;
  const head = (row.ingredientName.toLowerCase().split(/\s+/).filter(Boolean).pop() ?? "").replace(/[^a-z]/g, "");
  return head.length > 2 && new RegExp(`\\b${head}\\b`).test(lowerText);
}

/**
 * The food as it reads after its amount: the catalog's leading capital goes unless the
 * name is a proper noun ("2 Large eggs" → "2 large eggs", "Granny Smith apple" kept),
 * and a bare count agrees with its number ("3 egg" → "3 eggs", "¾ carrots" → "¾ carrot").
 */
function spokenName(name: string, amount: string): string {
  // THX-3d (R5) — a package named in the food's name is the unit: "1 box cornbread mix",
  // never "¾ cornbread mix (8.5 oz box)" (the size never scales, so it is not said).
  const pkg = /^(.+?)\s*\(\s*[\d.]+\s*-?\s*(?:oz|ounces?|lbs?|pounds?|g)\s+(box|bag|can|jar|package|packet)\s*\)$/i.exec(name.trim());
  if (pkg && /^[\d½¼¾⅓⅔⅛⅜⅝⅞]+$/.test(amount)) {
    const many = /^\d+$/.test(amount) && Number(amount) > 1;
    return `${many ? (/x$/i.test(pkg[2]) ? `${pkg[2]}es` : `${pkg[2]}s`) : pkg[2]} ${pkg[1].trim()}`;
  }
  const words = name.split(/\s+/);
  let out = /^[A-Z][a-z]/.test(name) && !/^[A-Z]/.test(words[1] ?? "") ? `${name[0].toLowerCase()}${name.slice(1)}` : name;
  if (/^[\d½¼¾⅓⅔⅛⅜⅝⅞]+$/.test(amount)) {
    const n = /^\d+$/.test(amount) ? Number(amount) : 0.5;
    if (n > 1 && /(egg|yolk|lemon|lime|orange|onion|shallot|carrot|apple)$/i.test(out)) out = `${out}s`;
    if (n > 1 && /potato$/i.test(out)) out = `${out}es`;
    if (n <= 1 && /(eggs|yolks|lemons|limes|oranges|onions|shallots|carrots|apples)$/i.test(out)) out = out.slice(0, -1);
  }
  return out;
}

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
  /** The feast's own day: a step no make-ahead phrase precedes is cooked on it. */
  feastDay?: string,
): ContainerUse[] {
  const out = new Map<string, ContainerUse>();
  const ingredientsOf = new Map<string, PrepCombineInput["meals"][number]["dishes"][number]["ingredients"]>();
  for (const m of combineInput.meals) for (const d of m.dishes) ingredientsOf.set(d.dishId, d.ingredients);
  for (const st of steps) {
    if (!st.bowlName || st.demoted || out.has(st.bowlName)) continue;
    const measures = st.components.flatMap((c) => c.measures.map((m) => ({ ...m, name: c.ingredientName })));
    const first = measures.find((m) => m.dishId);
    if (!first?.dishId || !first.mealId) continue;
    const dish = dishesById.get(first.dishId);
    const rows = ingredientsOf.get(first.dishId) ?? [];
    const mine = measures.filter((m) => m.dishId === first.dishId);
    const members = memberIds(mine, rows);
    // THX-3b (BUG-456) — a listing of an ingredient the dish lists twice enters at ITS
    // step (the topping's sugar at the topping's), never at the other listing's.
    const pinned = new Map<string, number>();
    for (const r of rows) {
      if (r.portionStep === undefined || !mine.some((m) => m.portion === r.portion && ingredientGroupKey(m.name) === ingredientGroupKey(r.ingredientName))) continue;
      pinned.set(r.ingredientId, r.portionStep);
    }
    const twice = new Set(rows.filter((r) => r.portion !== undefined).map((r) => r.ingredientId));
    const entry = dish ? entryStepOf(dish.componentSteps, members.ids, members.names, (id, s) => !twice.has(id) || pinned.get(id) === s) : null;
    out.set(st.bowlName, {
      name: st.bowlName,
      dishId: first.dishId,
      mealId: first.mealId,
      entryStep: entry,
      day: dish && entry !== null ? (stepDayOf(dish.componentSteps, entry) ?? (feastDay ? { day: feastDay, night: false } : null)) : null,
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

function entryStepOf(
  steps: readonly ComponentStep[],
  ids: ReadonlySet<string>,
  names: readonly string[],
  /** THX-3b — whether a member's amountRef on this step is the member's own listing. */
  ownsRef: (id: string, stepIndex: number) => boolean = () => true,
): number | null {
  const ordered = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  // THX-3d (R1) — the first step that states TWO of the members (one, for a one-member
  // container), else the first that states any: Small's crisp topping is measured at its
  // own step (oats, flour, sugar, salt, cinnamon), not at the filling's, which names one
  // of them (its own cinnamon). The cheesecake's mix still enters where its sugar and
  // salt do, the step before its spices.
  const stated = (s: ComponentStep) => new Set(s.ingredientIds.filter((id) => ids.has(id) && ownsRef(id, s.stepIndex))).size;
  const need = Math.min(2, ids.size);
  const byRef = ordered.find((s) => stated(s) >= need) ?? ordered.find((s) => stated(s) > 0);
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
  feastDay?: string,
  /** THX-3d — dishId → its servings multiplier, so a SHARE a step uses prints scaled. */
  multiplierOf?: ReadonlyMap<string, number>,
  /** THX-3d round 2 (N) — the labels that are shared tubs: a food, said in lower case ("the lemon juice"). */
  sharedLabels?: ReadonlySet<string>,
): Map<string, string> {
  const uses = containerUses(steps, dishesById, combineInput, feastDay);
  const scaled = new Map<string, { ingredientId: string; ingredientName: string; quantity: number; unit: string; category: string; portionStep?: number; asWritten?: boolean; preparationNote?: string | null }[]>();
  for (const m of combineInput.meals) for (const d of m.dishes) scaled.set(d.dishId, d.ingredients);
  const lineOf = new Map<string, string>();
  for (const u of uses) {
    const dish = dishesById.get(u.dishId);
    if (!dish || u.entryStep === null) continue;
    const entry = dish.componentSteps.find((s) => s.stepIndex === u.entryStep);
    if (!entry) continue;
    const rows = scaled.get(u.dishId) ?? [];
    const members = new Set(
      steps
        .filter((s) => s.bowlName === u.name || s.components.some((c) => c.measures.some((m) => m.destination === u.name)))
        .flatMap((s) => s.components.map((c) => ingredientGroupKey(c.ingredientName))),
    );
    // A food this session already put in ANOTHER of the dish's containers joins as
    // that container ("…combine it with the Cranberry-Orange Sauce vegetables").
    // ⚠️ Never a DRY container: one dry mix is not stirred into another. A food sits
    // in two dry mixes of one dish only when the recipe lists it twice (Sweet Potato
    // Casserole's filling and topping sugar — since THX-3b each listing is its own
    // portion, in its own step's mix), and naming the other mix would tell the cook
    // to combine them.
    const otherContainer = new Map<string, string | null>();
    for (const s of steps) {
      if (s.demoted) continue;
      for (const c of s.components) {
        for (const m of c.measures) {
          const into = m.destination ?? s.bowlName;
          if (m.dishId !== u.dishId || !into || into === u.name) continue;
          otherContainer.set(ingredientGroupKey(c.ingredientName), s.phase === "seasonings_dry" ? null : into);
        }
      }
    }
    // What a step names: its amountRefs, then any of the dish's foods its words name
    // without an amount ("combine the neck, giblets, quartered onion…"), in the order
    // the sentence names them. A salt or pepper counts only by its amountRef: the
    // words "black peppercorns" must not bring in the gravy's black pepper.
    const joinsOf = (step: ComponentStep): string[] => {
      const lower = step.text.toLowerCase();
      // THX-3d (B) — the amount THIS step uses of a row, when it is a share of it: the
      // Brussels dressing whisks in ½ tbsp of the 1½ tbsp olive oil (the rest tosses the
      // sprouts), and the closer named the whole row.
      const factor = multiplierOf?.get(u.dishId);
      const stepRefs = factor === undefined ? [] : deriveAmountRefs(step.text, rows.map((r) => ({ ingredientId: r.ingredientId, name: r.ingredientName, quantity: r.quantity, unit: r.unit }))).amountRefs;
      const shareOf = (row: { ingredientId: string; quantity: number; unit: string }): number => {
        const mine = stepRefs.filter((x) => x.ingredientId === row.ingredientId);
        if (mine.length !== 1 || factor === undefined) return row.quantity;
        const q = convertAmount(mine[0].quantity, mine[0].unit, row.unit);
        return q !== null && q * factor < row.quantity * 0.98 ? q * factor : row.quantity;
      };
      const named = rows
        .filter((r) => step.ingredientIds.includes(r.ingredientId) || (!isSaltOrPepper(r.ingredientName) && (proseNames(step.text, r.ingredientName) || namesProtein(lower, r))))
        .map((r) => ({ r, at: positionOf(lower, r.ingredientName) }))
        .sort((a, b) => a.at - b.at)
        .map((x) => x.r.ingredientId);
      const joins: string[] = [];
      for (const id of [...new Set(named)]) {
        // THX-3b (BUG-456) — a food the dish lists twice joins with the listing THIS step
        // measures (the topping's 3 tbsp butter, not the filling's 4).
        const row = rows.find((r) => r.ingredientId === id && r.portionStep === step.stepIndex) ?? rows.find((r) => r.ingredientId === id);
        if (!row || members.has(ingredientGroupKey(row.ingredientName))) continue;
        const key = ingredientGroupKey(row.ingredientName);
        if (otherContainer.has(key)) {
          // THX-3d — a SHARED tub's label names the food and its dishes ("Juiced lemon —
          // Roasted Green Beans, Apple Crisp"); in a sentence it is the food ("juiced lemon").
          const raw = otherContainer.get(key);
          const elsewhere = raw && raw.includes(" — ") ? spokenName(raw.split(" — ")[0], "") : raw && sharedLabels?.has(raw) ? raw.toLowerCase() : raw;
          if (elsewhere && !joins.includes(elsewhere)) joins.push(elsewhere);
          continue;
        }
        // Equipment is not something that joins (water is: "dissolve it in the gallon of water").
        if (isNeverMeasured(row.ingredientName) && !/\bwater\b/i.test(row.ingredientName)) continue;
        const q = shareOf(row);
        // THX-3d round 2 (P) — the row's own amount at its own servings prints as written.
        const amount = formatMeasure(q, row.unit, row.ingredientName, { asWritten: !!row.asWritten && Math.abs(q - row.quantity) < 1e-9, note: row.preparationNote });
        // THX-3d (R5) — a package rounded up says how much of it: "(use 6 oz)".
        const use = packageUse(q, row.unit, row.ingredientName, step.text);
        // Mid-sentence, the catalog's capitals go ("2 Large eggs", "¼ cup Whole milk").
        joins.push(`${amount} ${spokenName(row.ingredientName, amount)}${use ? ` (${use})` : ""}`.trim());
      }
      return joins;
    };
    // The entry step, or — when it only mixes the members ("Mix the salt, pepper and
    // baking powder in a small bowl") — the next step that day that USES the mixture
    // ("Rub the salt mixture all over the turkey").
    const sameDay = (s: ComponentStep) => {
      const d = stepDayOf(dish.componentSteps, s.stepIndex) ?? (feastDay ? { day: feastDay, night: false } : null);
      return (d?.day ?? null) === (u.day?.day ?? null);
    };
    const later = [...dish.componentSteps]
      .filter((s) => s.stepIndex > entry.stepIndex && sameDay(s))
      .sort((a, b) => a.stepIndex - b.stepIndex);
    const candidates = [entry, ...later.filter((s) => MIXTURE_WORD.test(s.text))];
    let used = entry;
    let joins: string[] = [];
    for (const s of candidates) {
      const j = joinsOf(s);
      if (j.length > 0) { used = s; joins = j; break; }
    }
    const body = used.text.replace(MAKE_AHEAD, "").replace(ON_DAY, "");
    const verb = VERBS.find(([re]) => re.test(body))?.[1] ?? "add it to";
    const when = u.day ? `On ${u.day.day}${u.day.night ? " night" : ""}, ` : "On cook day, ";
    // THX-3d — with nothing new joining it ("Pour in the sherry and soy sauce; whisk in the
    // broth" is the jar itself), the line names the step by what the recipe adds there.
    const dishName = combineInput.meals.flatMap((m) => m.dishes).find((d) => d.dishId === u.dishId)?.dishName ?? "recipe";
    const own = rows
      .filter((r) => members.has(ingredientGroupKey(r.ingredientName)) && (entry.ingredientIds.includes(r.ingredientId) || proseNames(entry.text, r.ingredientName)))
      .map((r) => spokenName(r.ingredientName, ""));
    const line = joins.length > 0
      ? `That's the ${u.name}. ${when}${verb} the ${listOf(joins)}.`
      : own.length > 0
        ? `That's the ${u.name}. ${when}add it to the ${dishName} where the recipe adds the ${listOf([...new Set(own)])}.`
        : `That's the ${u.name}. ${when}add it to the ${dishName}.`;
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
