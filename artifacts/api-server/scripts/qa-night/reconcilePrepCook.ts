// QA-NIGHT-1 — R4–R11. Pure: evidence in, { checked, findings } out.
//
// What the wire lets these see, and what it does not (README "Reach"):
//   • a prep step carries NO structured ingredient or amount — only prose, the
//     meals it contributes to, the cook steps it covers and its containers. So
//     R4's amount arm reads amounts out of the prose, and only for an
//     ingredient of a contributing meal, in a unit that converts; everything
//     else is counted "not comparable", never guessed.
//   • prepped Cook Mode wording is read-time (GET /meals/:id?planItemId), and a
//     cook step's link to prep is the week build's `coversCookSteps`.
import { ovenTempOf } from "../thx2/thx2Oven";
import { appFold, type FoldInput, planFold } from "./appFold";

import { dishFactor, type Finding, type GroceryRow, type PlanMeal, type PrepSession, type PrepStep, type RecipeStep, type RuleResult, type Severity } from "./types";
import { comparable, foodKey, foodWords, headNoun, normName, parseQty, sameFood } from "./units";

const LABEL_KEYS = new Set(["week-labels", "feast#feast-labels"]);
const isLabelStep = (s: PrepStep) => LABEL_KEYS.has(s.stepKey) || /^Label \d+ containers?\b/.test(s.title);
const short = (id: string) => id.slice(0, 8);

function finding(
  rule: Finding["rule"],
  kind: string,
  subject: string,
  severity: Severity,
  household: string,
  detail: string,
  extra: Partial<Finding> = {},
): Finding {
  return { rule, signature: `${rule}:${kind}${subject ? `:${subject}` : ""}`, severity, household, detail, ...extra };
}

const factorOf = dishFactor;

// ── R4 — prep stays inside the recipes ──────────────────────────────────────

const NUM = String.raw`(\d+\s+\d+/\d+|\d+\s*[¼½¾⅓⅔⅛⅜⅝⅞]|\d+/\d+|\d+(?:\.\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])`;
const UNIT = String.raw`(cups?|tablespoons?|tbsp|teaspoons?|tsp|pounds?|lbs?|lb|ounces?|oz|grams?|g|kg|ml|liters?|l|cloves?|cans?|heads?|bunch(?:es)?|stalks?|sprigs?|slices?|large|medium|small|whole)?`;

/**
 * Amounts the prose states for one food: "Mince 6 cloves garlic", "2 cups
 * diced onion", "1½ lb chicken thighs". The number, an optional unit, then at
 * most three words before a word that names the food.
 */
export function proseAmounts(text: string, food: string): { qty: number; unit: string }[] {
  const head = headNoun(food);
  if (!head) return [];
  const out: { qty: number; unit: string }[] = [];
  // The head must END the food phrase: "2 cups of the onion dip" names the dip.
  const re = new RegExp(String.raw`(?:^|[^\d/.])${NUM}\s*${UNIT}\b((?:\s+[A-Za-z-]+){0,3}?)\s+(${head}e?s?)\b(?!\s+(?:dip|mix|sauce|powder|soup|salt|paste|oil|broth|stock|seasoning|dressing|butter)\b)`, "gi");
  for (const m of text.matchAll(re)) {
    const qty = parseQty(m[1]);
    if (qty === null) continue;
    // QA-NIGHT-2: "the lemon zest from produce step 2 and garlic already in it" states no garlic:
    // a number that names a step, or one joined to the food by "and"/"or", is not its amount.
    if (/\bsteps?\s*$/i.test(text.slice(0, (m.index ?? 0) + m[0].indexOf(m[1])))) continue;
    if (/\b(and|or|then|with)\b/i.test(m[3] ?? "")) continue;
    // The words between the unit and the food must be the food's own words or
    // descriptors — "2 cups of the onion mix" names the mix, not 2 cups of onion.
    const between = foodWords(m[3] ?? "");
    const own = foodWords(food);
    if (between.some((w) => !own.includes(w))) continue;
    out.push({ qty, unit: (m[2] ?? "").toLowerCase() });
  }
  return out;
}

export function reconcileR4(household: string, session: PrepSession, meals: PlanMeal[], rows?: GroceryRow[]): RuleResult {
  const findings: Finding[] = [];
  let checked = 0;
  const byMeal = new Map(meals.map((m) => [m.mealId, m]));

  // a. one key, one step.
  const seen = new Map<string, number>();
  for (const s of session.steps) seen.set(s.stepKey, (seen.get(s.stepKey) ?? 0) + 1);
  for (const [k, n] of seen) {
    checked++;
    if (n > 1) findings.push(finding("R4", "duplicate-step-key", "", "high", household, `${session.kind} prep serves step key "${k}" ${n} times`, { step: k, numbers: { times: n } }));
  }

  for (const s of session.steps) {
    if (isLabelStep(s) || s.skipSuggested) continue;
    // b. it contributes to plan meals only.
    for (const id of s.contributesToMealIds) {
      checked++;
      if (!byMeal.has(id)) findings.push(finding("R4", "contributes-to-unknown-meal", "", "high", household, `${session.kind} step "${s.title}" contributes to meal ${short(id)}, which is not on the plan`, { step: s.stepKey }));
    }
    // c. what it covers is a cook step of a meal it is for. (Whether its output
    // reaches Cook Mode at all, a chip, a collapse or a reworded step, is R7's job:
    // most steps carry no coversCookSteps, and the chip is read-time.)
    const covers = s.coversCookSteps ?? [];
    for (const c of covers) {
      checked++;
      const meal = byMeal.get(c.mealId);
      const dish = meal?.dishes.find((d) => d.dishId === c.dishId);
      const exists = !!dish?.steps.some((x) => x.stepIndex === c.stepIndex);
      if (!s.contributesToMealIds.includes(c.mealId)) {
        findings.push(finding("R4", "covers-other-meal", "", "high", household, `${session.kind} step "${s.title}" covers a cook step of ${meal?.title ?? short(c.mealId)}, a meal it does not contribute to`, { step: s.stepKey, meal: meal?.title }));
      } else if (!exists) {
        findings.push(finding("R4", "covers-missing-cook-step", "", "medium", household, `${session.kind} step "${s.title}" covers ${meal?.title ?? short(c.mealId)} dish ${short(c.dishId)} step ${c.stepIndex}, which the meal does not have`, { step: s.stepKey, meal: meal?.title }));
      }
    }
  }

  // d. amounts: per food, what the session tells the cook to prep, against
  //    (1) the scaled recipes of the meals it serves — "prepped twice" lands here:
  //        the same onions stated in two steps sum to twice the recipe;
  //    (2) the grocery list's need for that food — prep that asks for more than the
  //        list buys leaves the cook short, whatever the scaling rule.
  // A narrated step states its TOTAL on its first line and then one line per
  // destination ("Work through 3 carrots …" / "1 carrot … — into …" / "2 carrots …"):
  // the first line counts when it states an amount, else the list lines; prose
  // about later (" On Wednesday night, dissolve it in the 7 sprigs …") never does.
  const foods = new Map<string, { name: string; mealIds: Set<string>; bird: boolean }>();
  for (const m of meals) {
    for (const d of m.dishes) {
      for (const ing of d.ingredients) {
        const key = foodKey(ing.name);
        if (!key) continue;
        const e = foods.get(key) ?? { name: ing.name, mealIds: new Set<string>(), bird: false };
        e.mealIds.add(m.mealId);
        if (d.isBirdDish) e.bird = true;
        foods.set(key, e);
      }
    }
  }
  for (const [key, food] of foods) {
    const steps = session.steps.filter((s) => !isLabelStep(s) && !s.skipSuggested && s.contributesToMealIds.some((id) => food.mealIds.has(id)));
    const stated: { qty: number; unit: string; step: string }[] = [];
    for (const s of steps) for (const a of stepAmounts(s, food.name)) stated.push({ ...a, step: s.title });
    if (stated.length === 0) continue;

    // (1) the recipes. The bird's dish scales by the bird weight (prepQuantity
    // dishRowMultipliers), which the wire does not carry: its foods go to (2) only.
    const servedMeals = new Set(steps.flatMap((s) => s.contributesToMealIds).filter((id) => food.mealIds.has(id)));
    const need: { qty: number; unit: string }[] = [];
    for (const m of meals) {
      if (!servedMeals.has(m.mealId)) continue;
      for (const d of m.dishes) {
        const f = factorOf(m, d);
        for (const ing of d.ingredients) if (foodKey(ing.name) === key) need.push({ qty: ing.quantity * f, unit: ing.unit });
      }
    }
    const total = sumIn(need, need[0]);
    const statedBase = total ? sumIn(stated, need[0]) : null;
    if (!food.bird && total && statedBase !== null) {
      checked++;
      if (statedBase.value > allowance(total.value, total.unit, linesIn(need, need[0]))) {
        const twice = stated.length > 1 && Math.abs(statedBase.value - 2 * total.value) / total.value < 0.15;
        findings.push(finding("R4", twice ? "prepped-twice" : "prep-exceeds-recipe", key, twice ? "high" : "medium", household,
          `${session.kind} prep states ${round(statedBase.value)} ${total.unit} of ${food.name} across ${stated.length} step(s) (${stated.map((x) => `"${x.step}"`).join(", ")}); the recipes need ${round(total.value)} ${total.unit}`,
          { numbers: { prepAmount: round(statedBase.value), recipeAmount: round(total.value), unit: total.unit, steps: stated.length } }));
      }
    }

    // (2) the list.
    // Every row the list has for the food (a list can carry three "Kosher salt" rows).
    const listRows = (rows ?? []).filter((r) => [r.displayName, r.canonicalName].some((n) => !!n && sameFood(n, food.name)));
    const row = listRows[0];
    if (row) {
      const have = { qty: row.quantity, unit: row.unit };
      const asked = sumIn(stated, have);
      const listed = sumIn(listRows.map((r) => ({ qty: r.quantity, unit: r.unit })), have);
      if (asked && listed) {
        checked++;
        if (asked.value > allowance(listed.value, asked.unit, linesIn(listRows.map((r) => ({ qty: r.quantity, unit: r.unit })), have))) {
          findings.push(finding("R4", "prep-exceeds-list", key, "high", household,
            `${session.kind} prep asks for ${round(asked.value)} ${asked.unit} of ${food.name} (${stated.map((x) => `${x.qty} ${x.unit} in "${x.step}"`).join(", ")}); the grocery list buys ${listRows.map((r) => `${r.quantity} ${r.unit}`).join(" + ")} of "${row.displayName}"`,
            { numbers: { prepAmount: round(asked.value), listAmount: round(listed.value), unit: asked.unit, listQty: row.quantity, listUnit: row.unit } }));
        }
      }
    }
  }
  return { rule: "R4", checked, findings };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The amounts a narrated step states for one food (see R4 d). */
export function stepAmounts(s: PrepStep, food: string): { qty: number; unit: string }[] {
  const lines = s.instructions.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = proseAmounts(lines[0] ?? "", food);
  if (head.length) return head;
  const list = lines.slice(1).filter((l) => /^[\d¼½¾⅓⅔⅛⅜⅝⅞]/.test(l)).flatMap((l) => proseAmounts(l, food));
  if (list.length) return list;
  return lines.length ? [] : proseAmounts(s.title, food);
}

/** Σ amounts in the unit `like` converts to; null when one does not convert. */
function sumIn(xs: { qty: number; unit: string }[], like: { qty: number; unit: string } | undefined): { value: number; unit: string } | null {
  if (!like || xs.length === 0) return null;
  let value = 0;
  let unit = "";
  for (const x of xs) {
    const c = comparable(x, like);
    if (!c) return null;
    value += c.a;
    unit = c.unit;
  }
  return { value, unit };
}

const toBaseOf = (x: { qty: number; unit: string }) => sumIn([x], x);

/**
 * How far a stated amount may run over the need before it is a finding: a
 * measure rounds to the next measurable amount (⅛ tsp ≈ 0.6 ml; ⅓ cup over 0.3
 * cup). QA-NIGHT-2 C: a whole count rounds UP to the next whole one, line by line
 * (each recipe line or list row: ¾ clove is minced as a clove), and may run ONE
 * whole unit past that (6 cloves minced where 4.5 are needed); further over is a
 * finding. A shortfall is never rounding (R1).
 */
export function allowance(need: number, unit: string, lines: number[] = [need]): number {
  if (unit === "ml") return need * 1.25 + 1.25;
  if (unit === "g") return need * 1.15 + 15;
  return lines.reduce((n, x) => n + Math.ceil(x - 1e-9), 0) + 1 + 1e-6;
}

/** Each amount in the unit of `like` (the lines `allowance` rounds one by one). */
const linesIn = (xs: { qty: number; unit: string }[], like: { qty: number; unit: string }) => xs.map((x) => comparable(x, like)?.a ?? 0);

// ── R5 — the subset is the subset ───────────────────────────────────────────
//
// Three reads of every meal OUTSIDE the subset: before the subset prep was asked
// for, after it was served (nothing ticked), and after its steps were ticked. A
// change between the first two is the request itself moving another meal's Cook
// Mode; between the last two, the ticks leaking into it.

export interface SubsetEvidence {
  session: PrepSession;
  /** Cook Mode reads per meal NOT in the subset ("dishId#idx" → step). */
  before: Record<string, Record<string, RecipeStep>>;
  served: Record<string, Record<string, RecipeStep>>;
  ticked: Record<string, Record<string, RecipeStep>>;
  titles: Record<string, string>;
}

/** The first step whose words or chips differ, as "#idx: "before" → "after"". */
export function firstDiff(a: Record<string, RecipeStep>, b: Record<string, RecipeStep>): string | null {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k];
    const y = b[k];
    const chips = (s?: RecipeStep) => (s?.preppedRefs ?? []).map((r) => r.label).join(",");
    if (x?.text !== y?.text || chips(x) !== chips(y)) {
      return `step ${k.split("#")[1]}: "${(x?.text ?? "(none)").slice(0, 90)}"${chips(x) ? ` [${chips(x)}]` : ""} → "${(y?.text ?? "(none)").slice(0, 90)}"${chips(y) ? ` [${chips(y)}]` : ""}`;
    }
  }
  return null;
}

export function reconcileR5(household: string, ev: SubsetEvidence): RuleResult {
  const findings: Finding[] = [];
  let checked = 0;
  const chosen = new Set(ev.session.mealIds);
  for (const s of ev.session.steps) {
    if (isLabelStep(s)) continue;
    checked++;
    const outside = [...s.contributesToMealIds, ...(s.coversCookSteps ?? []).map((c) => c.mealId)].filter((id) => !chosen.has(id));
    if (outside.length > 0) {
      findings.push(finding("R5", "step-outside-subset", "", "high", household,
        `${ev.session.kind} prep for ${ev.session.mealIds.length} meal(s) has "${s.title}" for ${[...new Set(outside)].map((id) => ev.titles[id] ?? short(id)).join(", ")}`,
        { step: s.stepKey, numbers: { outsideMeals: new Set(outside).size } }));
    }
  }
  for (const mealId of Object.keys(ev.before)) {
    checked++;
    const title = ev.titles[mealId] ?? short(mealId);
    const byRequest = firstDiff(ev.before[mealId], ev.served[mealId] ?? {});
    const byTicks = firstDiff(ev.served[mealId] ?? {}, ev.ticked[mealId] ?? {});
    if (byRequest) {
      findings.push(finding("R5", "subset-request-changed-other-meal", "", "high", household,
        `asking for the ${ev.session.kind} prep (nothing ticked) changed Cook Mode of ${title}, a meal outside it — ${byRequest}`, { meal: title }));
    }
    if (byTicks) {
      findings.push(finding("R5", "other-meal-cook-mode-changed", "", "high", household,
        `ticking the ${ev.session.kind} prep changed Cook Mode of ${title}, a meal outside it — ${byTicks}`, { meal: title }));
    }
  }
  return { rule: "R5", checked, findings };
}

// ── R6 — labels add up ──────────────────────────────────────────────────────

export interface CookRef {
  mealTitle: string;
  dishId: string;
  stepIndex: number;
  containerId: string;
  label: string;
}

export function reconcileR6(household: string, session: PrepSession, cookRefs: CookRef[]): RuleResult {
  const findings: Finding[] = [];
  let checked = 0;
  const filling = session.steps.filter((s) => !isLabelStep(s) && !s.skipSuggested && !s.holdsNoContainer);
  const names = new Set(filling.flatMap((s) => s.containerNames ?? []));
  const label = session.steps.find(isLabelStep);
  if (label) {
    checked++;
    const titleN = Number(/Label (\d+) containers?/.exec(label.title)?.[1] ?? NaN);
    const count = label.labelCount ?? null;
    const distinct = names.size;
    const agree = count === titleN && titleN === distinct;
    if (!agree) {
      findings.push(finding("R6", "label-count-mismatch", session.kind, "medium", household,
        `${session.kind} prep: labelCount ${count}, the card says ${Number.isNaN(titleN) ? "?" : titleN}, the steps fill ${distinct} distinct container(s)`,
        { step: label.stepKey, numbers: { labelCount: count, cardN: Number.isNaN(titleN) ? null : titleN, distinctContainers: distinct } }));
    }
  } else if (names.size > 0) {
    checked++;
    findings.push(finding("R6", "no-label-step", session.kind, "low", household, `${session.kind} prep fills ${names.size} named container(s) but serves no label step`, { numbers: { distinctContainers: names.size } }));
  }
  const ids = new Set(session.steps.map((s) => s.containerId).filter((x): x is string => !!x));
  for (const r of cookRefs) {
    checked++;
    if (!ids.has(r.containerId) && !names.has(r.label)) {
      findings.push(finding("R6", "cook-names-unmade-container", "", "high", household,
        `${r.mealTitle} step ${r.stepIndex} says "You prepped this · ${r.label}", a container ${session.kind} prep never makes`,
        { meal: r.mealTitle, step: `${short(r.dishId)}#${r.stepIndex}` }));
    }
  }
  return { rule: "R6", checked, findings };
}

// ── R7 — prep → cook ────────────────────────────────────────────────────────
//
// How a tick reaches Cook Mode, read off the wire (measured: most week steps
// carry no coversCookSteps):
//   • a CHIP — the server rewords a cook step that uses a prepped container and
//     puts `preppedRefs` on it (lib/feastCookWording weeknightCookWordingFor);
//   • a DROPPED CLAUSE — the server rewords the step without a chip ("Dice the 2
//     roma tomatoes, roughly chop …" → "Roughly chop …");
//   • a COLLAPSE — the client folds a cook step into "Done in prep", and gives a
//     step it shows in full a chip per ticked covering step (cookSession.ts
//     doneInPrepStepKeys / prepChips). QA-NIGHT-2 A: both come from the APP'S
//     OWN functions (appFold.ts), on the plan's ticks or, after "Yes, I
//     prepped", on this week's structure (preppedAnswerFold), never a model.
// The invariants, in the brief's words:
//   • a ticked step: no cook step of its meals still tells the cook to do it
//     ("Cook Mode that still says chop after the cook ticked it");
//   • partial prep mutes only what was ticked: no chip from an unticked step, no
//     rewording nothing ticked explains, no collapse over a food whose own prep
//     step is unticked (read here from the step's words, apart from the app's
//     own food rule: a fold the app makes over an unticked food is still found);
//   • a "Yes, I prepped" read words, folds or chips every covered step.

export interface PrepToCookMeal {
  meal: PlanMeal;
  /** Cook steps read with no tick on the plan (the unprepped words). */
  baseline: Record<string, RecipeStep>;
  /** The same read after the ticks (or with prepped=1). */
  after: Record<string, RecipeStep>;
}

export interface PrepToCookEvidence {
  /** "after partial prep", "Recipes · Yes, I prepped". */
  label: string;
  meals: PrepToCookMeal[];
  /** The week's steps (the cached structure Cook Mode words from). */
  prepSteps: PrepStep[];
  /** Ticked step keys; for a prepped=1 read, every key. */
  ticked: Set<string>;
  /** A "Yes, I prepped" read (prepped=1). */
  prepped: boolean;
  /**
   * What the app's fold reads (appFold.ts). Left out: a plan read folds by the
   * week's steps and the ticks, a prepped read by nothing. null: nothing folds.
   */
  fold?: FoldInput | null;
}

export const cookKey = (dishId: string, stepIndex: number) => `${dishId}#${stepIndex}`;

/** Words a dropped clause carries that are not foods. */
const NOT_FOOD = new Set(["teaspoon", "tablespoon", "minute", "until", "into", "with", "each", "about", "inch", "then", "while", "small", "bowl", "half", "thin", "thinly", "seed"]);

/** Steps that change no cook step by design. */
const UTILITY = /#wash-all$/;

const PREP_VERBS = "dice|chop|slice|mince|grate|peel|cut|trim|julienne|shred|halve|quarter|crush|zest|juice|measure|whisk|mix|seed|core|cube|smash|pick";
const VERB_WORDS = new Set([...PREP_VERBS.split("|"), "prep", "all", "the", "finely", "roughly", "thinly", "make", "finish", "wash", "dry", "and", "into", "for"]);
/** Heads too common to stand alone: "black pepper" is not "poblano pepper". */
const AMBIGUOUS = new Set(["pepper", "oil", "sauce", "cheese", "juice", "powder", "salt", "mix", "spice", "item", "seasoning", "green", "leave"]);

/** The food a prep step works on, from its title: "Prep all yellow onions" → onion; "Dice the poblano pepper" → poblano pepper. */
export function prepFood(title: string): { head: string; words: string[] } | null {
  const words = foodWords(title.replace(/\s+—.*$/, "").replace(/\bfor the\b.*$/i, "")).filter((w) => !VERB_WORDS.has(w));
  if (!words.length) return null;
  return { head: words[words.length - 1], words };
}

/** "the cook is told to <verb> the <food>" in a cook step's words. */
export function tellsToPrep(text: string, food: { head: string; words: string[] }): boolean {
  const near = (w: string) => new RegExp(`\\b(${PREP_VERBS})\\b[^.;]{0,40}?\\b${w}`, "i").test(text);
  if (AMBIGUOUS.has(food.head)) return food.words.length > 1 && near(food.words.join(" ")) ;
  return near(food.head);
}

export function reconcileR7(household: string, ev: PrepToCookEvidence): RuleResult {
  const findings: Finding[] = [];
  let checked = 0;
  const live = ev.prepSteps.filter((s) => !isLabelStep(s) && !s.skipSuggested);
  const all = live.every((s) => ev.ticked.has(s.stepKey));
  const producers = (ref: { containerId: string; label: string }) =>
    live.filter((s) => (s.containerId && s.containerId === ref.containerId) || (s.containerNames ?? []).includes(ref.label));
  // Plain words, not normName: that one is for ingredient names and drops all after a comma.
  const words = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z]+/).filter(Boolean).map((w) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w));
  const byDroppedFood = (before: string, after: string) => {
    const kept = new Set(words(after));
    const gone = words(before).filter((w) => !kept.has(w));
    const goneText = gone.join(" ");
    const goneFoods = foodWords(goneText).filter((w) => w.length > 3 && !NOT_FOOD.has(w));
    return live.filter((s) => {
      const f = prepFood(s.title);
      if (f && f.head.length > 2 && new RegExp(`\\b${f.head}`, "i").test(goneText)) return true;
      // "Measure the Chicken chili spices" names no spice in its title; its instructions do.
      const said = new Set(foodWords(s.instructions));
      return goneFoods.length > 0 && goneFoods.every((w) => said.has(w));
    });
  };
  /** "stepKey|mealId": the step reached that meal's Cook Mode (a chip, a fold, a dropped clause). */
  const reached = new Set<string>();
  const reach = (key: string, mealId: string) => reached.add(`${key}|${mealId}`);
  /** "mealId|dishId#idx" of cook steps the client folds into "Done in prep". */
  const collapsed = new Set<string>();
  const inScope = new Set(ev.meals.map((m) => m.meal.mealId));
  const fold = ev.fold !== undefined ? ev.fold : ev.prepped ? null : planFold(live, ev.ticked);

  for (const { meal, baseline, after } of ev.meals) {
    const app = appFold(meal, after, fold);
    const covering = new Map<string, string[]>();
    for (const s of live) for (const c of s.coversCookSteps ?? []) if (c.mealId === meal.mealId) {
      const k = cookKey(c.dishId, c.stepIndex);
      covering.set(k, [...(covering.get(k) ?? []), s.stepKey]);
    }
    const mine = live.filter((s) => s.contributesToMealIds.includes(meal.mealId));
    for (const [k, base] of Object.entries(baseline)) {
      const now = after[k];
      checked++;
      if (!now) {
        findings.push(finding("R7", "cook-step-missing", "", "high", household, `${ev.label}: ${meal.title} lost cook step ${k} after prep (it read "${base.text.slice(0, 120)}")`, { meal: meal.title, step: k }));
        continue;
      }
      const serverChips = now.preppedRefs ?? [];
      // The app's own chips for a step it shows in full (prepChips): each names a ticked covering step.
      const added = app.chips.get(k) ?? [];
      const chips = [...serverChips, ...added];
      const keys = covering.get(k) ?? [];
      let linkedTicked = keys.some((x) => ev.ticked.has(x));
      if (added.length > 0) for (const x of keys) if (ev.ticked.has(x)) reach(x, meal.mealId);
      for (const ref of serverChips) {
        const from = producers(ref);
        for (const s of from) if (ev.ticked.has(s.stepKey)) reach(s.stepKey, meal.mealId);
        if (from.some((s) => ev.ticked.has(s.stepKey))) linkedTicked = true;
        else if (from.length > 0) {
          findings.push(finding("R7", "chip-from-unticked-prep", "", "high", household,
            `${ev.label}: ${meal.title} step ${k} shows "You prepped this · ${ref.label}", but ${from.map((s) => `"${s.title}"`).join(", ")} is not ticked`,
            { meal: meal.title, step: k }));
        }
      }
      if (app.done.has(k)) {
        for (const x of keys) reach(x, meal.mealId);
        collapsed.add(`${meal.mealId}|${k}`);
        // The fold hides the whole step: every food it tells the cook to prep must have been prepped.
        const missed = mine.filter((s) => !ev.ticked.has(s.stepKey) && !keys.includes(s.stepKey)).filter((s) => {
          const f = prepFood(s.title);
          return !!f && tellsToPrep(base.text, f);
        });
        if (missed.length > 0) {
          findings.push(finding("R7", "collapsed-over-unticked-food", "", "high", household,
            `${ev.label}: ${meal.title} step ${k} folds into "Done in prep" (its covering steps ${keys.join(", ")} are ticked), but it also says "${base.text.slice(0, 100)}" and ${missed.map((s) => `"${s.title}"`).join(", ")} is not ticked`,
            { meal: meal.title, step: k }));
        }
        continue;
      }
      if (keys.length > 0 && keys.every((x) => ev.ticked.has(x))) {
        // Shown in full though every covering step is ticked (the app's food rule kept it):
        // a chip or the server's rewording says what was prepped; with neither it still says it all.
        const worded = chips.length > 0 || now.text !== base.text;
        // Not worded on a plan read: "cook-still-says-chop" below reports it; on a prepped read, this does.
        if (worded || ev.prepped) for (const x of keys) reach(x, meal.mealId);
        if (ev.prepped && !worded) {
          findings.push(finding("R7", "prepped-read-not-worded", "", "high", household,
            `${ev.label}: ${meal.title} step ${k} is covered by prep (${keys.join(", ")}), but after "Yes, I prepped" Cook Mode still reads "${base.text.slice(0, 110)}" — no chip, not folded into "Done in prep"`,
            { meal: meal.title, step: k }));
        }
        continue;
      }
      if (!linkedTicked && chips.length === 0 && now.text !== base.text) {
        const from = byDroppedFood(base.text, now.text);
        for (const s of from) if (ev.ticked.has(s.stepKey)) reach(s.stepKey, meal.mealId);
        if (from.some((s) => ev.ticked.has(s.stepKey)) || all) continue;
      }
      if (!linkedTicked && (now.text !== base.text || chips.length > 0)) {
        findings.push(finding("R7", "unticked-muted", "", "high", household,
          `${ev.label}: ${meal.title} step ${k}: no ticked step's chip, covers or named food explains the rewording${chips.length ? ` and shows ${chips.map((c) => `"${c.label}"`).join(", ")}` : ""}: "${base.text.slice(0, 80)}" → "${now.text.slice(0, 80)}"`,
          { meal: meal.title, step: k, numbers: { coveringSteps: keys.length, chips: chips.length } }));
      }
    }
  }
  // Every ticked step: no cook step of its meals still tells the cook to do it.
  for (const s of live) {
    if (!ev.ticked.has(s.stepKey) || UTILITY.test(s.stepKey)) continue;
    const food = prepFood(s.title);
    if (!food) continue;
    for (const { meal, after } of ev.meals) {
      if (!s.contributesToMealIds.includes(meal.mealId) || !inScope.has(meal.mealId) || reached.has(`${s.stepKey}|${meal.mealId}`)) continue;
      checked++;
      const still = Object.entries(after).find(([k, st]) => !collapsed.has(`${meal.mealId}|${k}`) && tellsToPrep(st.text, food));
      if (still) {
        findings.push(finding("R7", "cook-still-says-chop", "", "high", household,
          `${ev.label}: "${s.title}" is ticked, but ${meal.title} step ${still[0].split("#")[1]} still reads "${still[1].text.slice(0, 120)}" — no chip, not folded into "Done in prep"`,
          { meal: meal.title, step: s.stepKey }));
      }
    }
  }
  return { rule: "R7", checked, findings };
}

// ── R8 — Cook Mode is complete ──────────────────────────────────────────────

export interface SequencedStep {
  dishId: string;
  originalStepIndex: number;
  sequenceIndex: number;
  startOffsetMinutes: number;
}

export interface CookModeEvidence {
  meal: PlanMeal;
  /** The sequencer's order for a multi-dish meal; null for one dish (naive order). */
  sequence: SequencedStep[] | null;
  /** The sequence's own total, else the serial sum for one dish. */
  sequenceTotalMinutes: number | null;
  /** What the card says (the meal's `minutes`). */
  cardTotalMinutes: number | null;
}

export function reconcileR8(household: string, ev: CookModeEvidence): RuleResult {
  const findings: Finding[] = [];
  let checked = 0;
  const m = ev.meal;
  // a. every recipe ingredient is used in some step of its dish (or the meal). Not
  // for the feast: its Cook Mode is worded from the feast build, where prep owns
  // the measured mixes ("add the Pie spice mix" stands for five spices).
  const plain = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const allText = m.dishes.flatMap((d) => d.steps.map((s) => plain(s.text))).join("\n");
  for (const d of m.isFeast ? [] : m.dishes) {
    const dishText = d.steps.map((s) => plain(s.text)).join("\n");
    for (const ing of d.ingredients) {
      if (ing.isOptional) continue;
      const head = headNoun(ing.name);
      if (!head || ["salt", "pepper", "water"].includes(head)) continue;
      checked++;
      const re = new RegExp(`\\b${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
      const anyWord = foodWords(ing.name).some((w) => w.length > 3 && new RegExp(`\\b${w}`, "i").test(allText));
      if (!re.test(dishText) && !re.test(allText) && !anyWord) {
        findings.push(finding("R8", "ingredient-unused", normName(ing.name), "low", household,
          `${m.title} · ${d.title}: "${ing.name}" is in the ingredients but no Cook Mode step names it`, { meal: m.title }));
      }
    }
  }
  if (ev.sequence) {
    // b. in order. The sequencer may pull a PREP step forward (chop the garnish while
    // the soup simmers is K-R5's whole point), so a step running before an earlier
    // step of its own dish is a defect only when it is not prep; steps sharing a
    // parallelGroup (D-WS9-239) may run in either order.
    for (const d of m.dishes) {
      const seq = ev.sequence.filter((s) => s.dishId === d.dishId).sort((a, b) => a.sequenceIndex - b.sequenceIndex);
      if (seq.length < 2) continue;
      checked++;
      const own = (idx: number) => d.steps.find((x) => x.stepIndex === idx);
      const said = (idx: number) => { const x = own(idx); return x ? `${x.phaseType} "${x.text.slice(0, 70)}"` : "?"; };
      outer: for (let i = 0; i < seq.length; i++) {
        for (let j = i + 1; j < seq.length; j++) {
          const early = seq[i];
          const late = seq[j];
          if (early.originalStepIndex < late.originalStepIndex) continue;
          const st = own(early.originalStepIndex);
          if (st?.phaseType === "prep") continue;
          const g = st?.parallelGroup ?? null;
          if (g !== null && g === (own(late.originalStepIndex)?.parallelGroup ?? null)) continue;
          findings.push(finding("R8", "steps-out-of-order", "", "high", household,
            `${m.title} · ${d.title}: step ${early.originalStepIndex} (T${early.startOffsetMinutes}, ${said(early.originalStepIndex)}) runs before step ${late.originalStepIndex} (T${late.startOffsetMinutes}, ${said(late.originalStepIndex)})`,
            { meal: m.title, step: `${short(d.dishId)}#${early.originalStepIndex}` }));
          break outer;
        }
      }
    }
    // c. one oven temperature at a time.
    const minutes = new Map(m.dishes.flatMap((d) => d.steps.map((s) => [cookKey(d.dishId, s.stepIndex), s] as const)));
    const oven = ev.sequence
      .map((s) => {
        const st = minutes.get(cookKey(s.dishId, s.originalStepIndex));
        if (!st || /^\s*preheat/i.test(st.text)) return null;
        const temp = ovenTempOf(st.text);
        if (temp === null || !/\b(bake|roast|oven|broil)/i.test(st.text)) return null;
        return { dishId: s.dishId, step: s.originalStepIndex, temp, from: s.startOffsetMinutes, to: s.startOffsetMinutes + st.estimatedMinutes };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (oven.length > 1) checked++;
    for (let i = 0; i < oven.length; i++) {
      for (let j = i + 1; j < oven.length; j++) {
        const a = oven[i], b = oven[j];
        if (a.dishId === b.dishId || a.temp === b.temp) continue;
        if (a.from < b.to && b.from < a.to) {
          const ta = m.dishes.find((d) => d.dishId === a.dishId)?.title ?? short(a.dishId);
          const tb = m.dishes.find((d) => d.dishId === b.dishId)?.title ?? short(b.dishId);
          findings.push(finding("R8", "oven-two-temperatures", "", "medium", household,
            `${m.title}: ${ta} #${a.step} at ${a.temp}°F (T${a.from}→${a.to}) overlaps ${tb} #${b.step} at ${b.temp}°F (T${b.from}→${b.to})`,
            { meal: m.title, numbers: { tempA: a.temp, tempB: b.temp, overlapMin: Math.min(a.to, b.to) - Math.max(a.from, b.from) } }));
        }
      }
    }
  }
  // d. the card's time is within 10 % of the sequence's.
  if (ev.cardTotalMinutes && ev.sequenceTotalMinutes) {
    checked++;
    const off = Math.abs(ev.cardTotalMinutes - ev.sequenceTotalMinutes) / ev.sequenceTotalMinutes;
    if (off > 0.1) {
      findings.push(finding("R8", "card-time-off", "", "low", household,
        `${m.title}: the card says ${ev.cardTotalMinutes} min, Cook Mode's sequence runs ${ev.sequenceTotalMinutes} min (${Math.round(off * 100)}% off)`,
        { meal: m.title, numbers: { cardMinutes: ev.cardTotalMinutes, sequenceMinutes: ev.sequenceTotalMinutes } }));
    }
  }
  return { rule: "R8", checked, findings };
}

// ── R9 — the feast's dates ──────────────────────────────────────────────────

export interface MakeAheadRow {
  kind: "thaw" | "make" | "brine";
  dayName: string;
  date: string | null;
  daysBefore: number;
  dishId: string;
  dishName: string;
  keepsDays?: number;
  thawDays?: number;
}

export interface FeastEvidence {
  label: string;
  feastDate: string | null;
  feastDayName: string;
  rows: MakeAheadRow[];
  /** The weight chosen, else null (the recipe's own weight applies). */
  birdWeightLb: number | null;
  /** The recipe's own weight range when no weight is chosen ("12–14 lb"). */
  recipeLb: { min: number; max: number } | null;
  /** Prep the feast's `sessionDay`. */
  sessionDay: string | null;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function reconcileR9(household: string, ev: FeastEvidence): RuleResult {
  const findings: Finding[] = [];
  let checked = 0;
  const feastMs = ev.feastDate ? Date.parse(`${ev.feastDate}T00:00:00Z`) : null;
  for (const r of ev.rows) {
    checked++;
    const where = `${ev.label}: ${r.kind} ${r.dishName} on ${r.dayName}${r.date ? ` ${r.date}` : ""}`;
    if (r.daysBefore < 1) findings.push(finding("R9", "not-before-feast", r.kind, "high", household, `${where} is ${r.daysBefore} days before the feast`, { step: r.dishName }));
    if (feastMs !== null && r.date) {
      const want = new Date(feastMs - r.daysBefore * 86_400_000).toISOString().slice(0, 10);
      if (r.date !== want || Date.parse(`${r.date}T00:00:00Z`) >= feastMs) {
        findings.push(finding("R9", "date-mismatch", r.kind, "high", household, `${where}: daysBefore ${r.daysBefore} puts it on ${want}`, { step: r.dishName }));
      }
      const dow = DAYS[new Date(`${r.date}T00:00:00Z`).getUTCDay()];
      if (dow !== r.dayName) findings.push(finding("R9", "weekday-mismatch", r.kind, "medium", household, `${where}: ${r.date} is a ${dow}`, { step: r.dishName }));
    }
    if (r.kind === "make" && r.keepsDays !== undefined && r.daysBefore > r.keepsDays) {
      findings.push(finding("R9", "outside-keep-window", "", "high", household,
        `${where}: made ${r.daysBefore} days ahead, keeps ${r.keepsDays}`, { step: r.dishName, numbers: { daysBefore: r.daysBefore, keepsDays: r.keepsDays } }));
    }
    if (r.daysBefore >= 7) {
      findings.push(finding("R9", "a-week-early", r.kind, "medium", household,
        `${where}: ${r.daysBefore} days before the feast (a tag on the feast's own weekday reads as a week out)`, { step: r.dishName, numbers: { daysBefore: r.daysBefore } }));
    }
  }
  // Order: the server sorts by daysBefore descending; within a dish thaw ≥ brine ≥ the feast.
  checked++;
  for (let i = 1; i < ev.rows.length; i++) {
    if (ev.rows[i].daysBefore > ev.rows[i - 1].daysBefore) {
      findings.push(finding("R9", "rows-out-of-order", "", "medium", household, `${ev.label}: ${ev.rows[i].kind} ${ev.rows[i].dishName} (${ev.rows[i].daysBefore} d) is listed after ${ev.rows[i - 1].kind} ${ev.rows[i - 1].dishName} (${ev.rows[i - 1].daysBefore} d)`));
      break;
    }
  }
  // The thaw: ⌈lb ÷ 4⌉ fridge days ending on the bird's brine, else the feast.
  for (const t of ev.rows.filter((r) => r.kind === "thaw")) {
    checked++;
    const brine = ev.rows.find((r) => r.kind === "brine" && r.dishId === t.dishId);
    const lead = brine?.daysBefore ?? 0;
    const fridge = t.daysBefore - lead;
    const range = ev.birdWeightLb !== null
      ? { min: Math.ceil(ev.birdWeightLb / 4 - 1e-9), max: Math.ceil(ev.birdWeightLb / 4 - 1e-9) }
      : ev.recipeLb
        ? { min: Math.ceil(ev.recipeLb.min / 4 - 1e-9), max: Math.ceil(ev.recipeLb.max / 4 - 1e-9) }
        : null;
    if (brine && brine.daysBefore >= t.daysBefore) {
      findings.push(finding("R9", "thaw-after-brine", "", "high", household, `${ev.label}: the thaw (${t.daysBefore} d) does not start before the brine (${brine.daysBefore} d)`, { step: t.dishName }));
    } else if (range && (fridge < range.min || fridge > range.max)) {
      findings.push(finding("R9", "thaw-weight-rule", "", "high", household,
        `${ev.label}: the thaw gives ${fridge} fridge day(s) before ${brine ? "the brine" : "the feast"}; ${ev.birdWeightLb !== null ? `${ev.birdWeightLb} lb` : `the recipe's ${ev.recipeLb!.min}–${ev.recipeLb!.max} lb`} needs ${range.min === range.max ? range.min : `${range.min}–${range.max}`}`,
        { step: t.dishName, numbers: { fridgeDays: fridge, wantMin: range.min, wantMax: range.max, lb: ev.birdWeightLb } }));
    }
  }
  // Prep the feast runs the day before the feast.
  if (ev.sessionDay) {
    checked++;
    const want = DAYS[(DAYS.indexOf(ev.feastDayName) + 6) % 7];
    if (ev.sessionDay !== want) {
      findings.push(finding("R9", "session-day", "", "medium", household, `${ev.label}: Prep the feast is on ${ev.sessionDay}; the feast is ${ev.feastDayName}`, { numbers: { sessionDay: ev.sessionDay, feastDay: ev.feastDayName } }));
    }
  }
  return { rule: "R9", checked, findings };
}

// ── R10 — lifecycle facts ───────────────────────────────────────────────────

export interface LifecycleEvidence {
  /** planId → ticks the run PUT, and plan_prep_started rows the database holds. */
  plans: { planId: string; label: string; ticksPut: number; prepStartedRows: number }[];
  /** cook finishes the run posted with `recorded: true`, and cook_finished rows. */
  finishesRecorded: number;
  cookFinishedRows: number;
}

export function reconcileR10(household: string, ev: LifecycleEvidence): RuleResult {
  const findings: Finding[] = [];
  let checked = 0;
  for (const p of ev.plans) {
    checked++;
    const want = p.ticksPut > 0 ? 1 : 0;
    if (p.prepStartedRows !== want) {
      findings.push(finding("R10", p.prepStartedRows > want ? "prep-started-repeated" : "prep-started-missing", "", "medium", household,
        `${p.label}: ${p.ticksPut} tick(s), ${p.prepStartedRows} plan_prep_started row(s); want ${want}`,
        { numbers: { ticks: p.ticksPut, rows: p.prepStartedRows, want } }));
    }
  }
  checked++;
  if (ev.cookFinishedRows !== ev.finishesRecorded) {
    findings.push(finding("R10", "cook-finished-count", "", "medium", household,
      `${ev.finishesRecorded} cook finish(es) recorded, ${ev.cookFinishedRows} cook_finished row(s)`,
      { numbers: { finishes: ev.finishesRecorded, rows: ev.cookFinishedRows } }));
  }
  return { rule: "R10", checked, findings };
}

// ── R11 — health ────────────────────────────────────────────────────────────

import type { CallRecord } from "./types";

export const SLOW_MS = 20_000;

export function reconcileR11(household: string, calls: CallRecord[], consoleErrors: string[] = []): RuleResult {
  const findings: Finding[] = [];
  for (const c of calls) {
    const where = `${c.step}: ${c.method} ${c.path}`;
    if (c.status >= 500 || c.status === 0) {
      findings.push(finding("R11", c.status === 0 ? "no-response" : "5xx", `${c.method} ${normPath(c.path)}`, "high", household, `${where} → ${c.status} ${c.error ?? ""}`.trim(), { step: c.step, numbers: { status: c.status, ms: c.ms } }));
    } else if (c.status >= 400 && !c.expected.includes(c.status)) {
      findings.push(finding("R11", "unexpected-4xx", `${c.method} ${normPath(c.path)} ${c.status}`, "medium", household, `${where} → ${c.status} ${c.error ?? ""}`.trim(), { step: c.step, numbers: { status: c.status } }));
    }
    if (c.ms > SLOW_MS) {
      findings.push(finding("R11", "slow", `${c.method} ${normPath(c.path)}`, "low", household, `${where} took ${(c.ms / 1000).toFixed(1)} s`, { step: c.step, numbers: { ms: c.ms } }));
    }
  }
  for (const e of consoleErrors) {
    findings.push(finding("R11", "console-error", e.replace(/[0-9a-f-]{36}/g, "<id>").slice(0, 60), "medium", household, `UI console: ${e.slice(0, 240)}`));
  }
  return { rule: "R11", checked: calls.length + consoleErrors.length, findings };
}

/** /plans/1e41fc0c-…/items/… → /plans/:id/items/:id */
export function normPath(p: string): string {
  return p.replace(/\?.*$/, "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
}
