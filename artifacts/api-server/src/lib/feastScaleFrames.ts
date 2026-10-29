// THX-3d round 2 (O) — A COUNT THAT BECOMES ONE REWRITES ITS FRAME, AT READ TIME.
//
// The client scales a step's amounts; it cannot rewrite the sentence around them. At
// household 4 Vegetarian's Wellington read "lay out 1 puff pastry sheets. Divide the
// duxelles between the 1 sheet … top each mound", New Twist's cornbread "Bake 1 box …
// in two separate 8×8 pans, each with 1 egg", Classic's pie "Fit one refrigerated pie
// crust into each of two 9-inch pie dishes". When the plan scales a dish's countable
// row (crusts, sheets, boxes) from two or more to ONE, these frames say the one; and a
// serve step's portions follow the servings ("slice into 10 portions" at 4 → 4).
//
// Read time only (GET /meals/:id?planItemId=, feast meals), from the plan's own load:
// the stored recipe keeps its authored words. Every amountRef moves with its text.

import type { LoadPrepWeekInputResult } from "./prepWeekAggregation";
import { dishRowMultipliers, displayedPrepQuantity } from "./prepQuantity";
import type { WordingRef, WordingStep } from "./feastCookWording";

/** A countable row's frame words: the row's name, and the nouns its frames say. */
const COUNTABLES: ReadonlyArray<{ row: RegExp; nouns: string[] }> = [
  { row: /\bpie (?:crusts?|shells?)\b/i, nouns: ["crust", "shell", "pie dish", "dish"] },
  { row: /\bpuff pastry\b/i, nouns: ["sheet", "mound", "Wellington"] },
  { row: /\bmix\b/i, nouns: ["box", "pan"] },
];

export interface DishScale {
  /** The plan's servings for the dish, and the recipe's own. */
  servings: number;
  authoredServings: number;
  /** Frame nouns whose countable row the plan shows as ONE (authored two or more). */
  ones: Set<string>;
  /** The countable row's authored and shown counts, by frame noun (for "each into N"). */
  counts: Map<string, { authored: number; shown: number }>;
  /** Each row's multiplier and name, by ingredient id (a step amount's shown number). */
  rows: Map<string, { mult: number; name: string; unit: string }>;
}

/** Each feast dish's scale in this plan (the adapter's own multipliers). */
export function dishScalesOf(load: Pick<LoadPrepWeekInputResult, "input">): Map<string, DishScale> {
  const out = new Map<string, DishScale>();
  for (const meal of load.input.meals) {
    for (const dish of meal.dishes) {
      const authored = (dish.authoredBaseServings ?? dish.baseServings) || 1;
      const servings = meal.servingsOverride ?? dish.baseServings;
      // THX-4 (D-WS9-324) — the turkey's dish follows the weight the cook chose.
      const birdLb = meal.bird?.dishId === dish.dishId ? { birdLb: meal.bird.lb } : {};
      const mult = dishRowMultipliers(dish.ingredients.map((i) => ({ quantity: i.quantity, unit: i.unit, name: i.ingredientName, note: i.preparationNote })), servings / authored, { feast: !!meal.feast, ...birdLb });
      const scale: DishScale = { servings, authoredServings: authored, ones: new Set(), counts: new Map(), rows: new Map() };
      dish.ingredients.forEach((ing, row) => {
        if (!scale.rows.has(ing.ingredientId)) scale.rows.set(ing.ingredientId, { mult: mult[row], name: ing.ingredientName, unit: ing.unit });
        const c = COUNTABLES.find((x) => x.row.test(ing.ingredientName));
        // "1 package (2-count)" of pie crusts is two crusts: the frame counts the pieces.
        const per = Number(/\((\d+)-count\)/i.exec(ing.unit)?.[1] ?? 1);
        const count = ing.quantity * per;
        if (!c || !(count >= 2)) return;
        const shown = per > 1 ? Math.max(1, Math.round(count * mult[row])) : displayedPrepQuantity(ing.quantity * mult[row], ing.unit, ing.ingredientName);
        for (const n of c.nouns) scale.counts.set(n.toLowerCase(), { authored: count, shown });
        if (shown === 1) for (const n of c.nouns) scale.ones.add(n.toLowerCase());
      });
      out.set(dish.dishId, scale);
    }
  }
  return out;
}

export type Edit = { start: number; end: number; text: string };

/** "leaves" → "leaf", "potatoes" → "potato", "cherries" → "cherry", "jalapeños" → "jalapeño". */
export function singularOf(w: string): string {
  if (/(?:lea|loa|hal|shea)ves$/i.test(w)) return w.replace(/ves$/i, "f");
  if (/knives$/i.test(w)) return w.replace(/ves$/i, "fe");
  if (/(?:tomato|potato)es$/i.test(w)) return w.replace(/es$/i, "");
  if (/[^aeiou]ies$/i.test(w)) return w.replace(/ies$/i, "y");
  if (/(?:ch|sh|x|ss)es$/i.test(w)) return w.replace(/es$/i, "");
  return w.replace(/s$/i, "");
}
const NUMBER = String.raw`(?:two|three|four|\d+)`;
const article = (w: string) => (/^(?:[aeiou]|8|11|18)/i.test(w) ? "an" : "a");

/** The step with its one-count frames and its portions said for this plan. Unchanged when nothing applies. */
export function scaleFrames(step: WordingStep, scale: DishScale | undefined): WordingStep {
  if (!scale) return step;
  const text = step.text;
  const edits: Edit[] = [];
  const add = (m: RegExpExecArray, to: string) => edits.push({ start: m.index, end: m.index + m[0].length, text: to });
  const one = (phrase: string) => [...scale.ones].some((n) => new RegExp(`\\b${n}s?\\b`, "i").test(phrase));
  if (scale.ones.size > 0) {
    // "into each of two 9-inch pie dishes" → "into a 9-inch pie dish"
    for (const m of text.matchAll(new RegExp(String.raw`\binto each of ${NUMBER} ([^,;.()]+?)(e?s)\b`, "gi"))) {
      if (one(m[1])) add(m, `into ${article(m[1])} ${m[1]}`);
    }
    // "Divide the filling evenly between the two prepared pie shells" → "Pour the filling into the prepared pie shell"
    for (const m of text.matchAll(new RegExp(String.raw`\b([Dd])ivide (the [^,;.]+?) (?:evenly )?between the ${NUMBER} ([^,;.()]+?)s\b`, "g"))) {
      if (!one(m[3])) continue;
      const pour = /\b(?:filling|batter|custard)\b/i.test(m[2]);
      add(m, `${m[1] === "D" ? (pour ? "Pour" : "Spoon") : pour ? "pour" : "spoon"} ${m[2]} ${pour ? "into" : "onto"} the ${m[3]}`);
    }
    // "in two separate 8×8 pans, each with" → "in an 8×8 pan with"
    for (const m of text.matchAll(new RegExp(String.raw`\bin ${NUMBER} separate ([^,;.]*?\bpan)s, each with\b`, "gi"))) {
      if (one(m[1])) add(m, `in ${article(m[1])} ${m[1]} with`);
    }
    // "(8.5 oz each)" → "(8.5 oz)"
    for (const m of text.matchAll(/\((\d+(?:\.\d+)?\s*oz) each\)/gi)) if (scale.ones.has("box")) add(m, `(${m[1]})`);
    // "each mound", "each shell", "each Wellington" → "the …"; "the Wellingtons" → "the Wellington"
    for (const m of text.matchAll(/\beach (mound|shell|wellington|pie dish|crust)\b/gi)) if (one(m[1])) add(m, `the ${m[1]}`);
    for (const m of text.matchAll(/\b([Tt])he (wellington|shell|mound)s\b/gi)) if (one(m[2])) add(m, `${m[1]}he ${m[2]}`);
  }
  // Portions follow the servings: "slice into 10 portions" at 4 → 4; "slice each into 5
  // portions" over two Wellingtons, one at 4 → "slice it into 4 portions".
  if (scale.servings !== scale.authoredServings) {
    const factor = scale.servings / scale.authoredServings;
    for (const m of text.matchAll(/\b((?:slice|cut)) (each |it |them )?into (\d+) (portions|pieces|bars|squares|slices|servings)\b/gi)) {
      const n = Number(m[3]);
      if (m[2]?.trim().toLowerCase() === "each") {
        const c = scale.counts.get("wellington") ?? null;
        if (!c) continue;
        const per = Math.max(1, Math.round((n * c.authored * factor) / c.shown));
        add(m, `${m[1]} ${c.shown === 1 ? "it " : "each "}into ${per} ${m[4]}`);
      } else {
        add(m, `${m[1]} ${m[2] ?? ""}into ${Math.max(1, Math.round(n * factor))} ${m[4]}`);
      }
    }
  }
  // "2 oranges" that the plan shows as 1 says "1 orange": the client changes the number,
  // the noun after it is said here ("1 bay leaf", "1 beaten egg", "1 celery stalk").
  edits.push(...refNounEdits(step, scale.rows, edits));
  return applyEdits(step, edits);
}

/** A row's multiplier, name and unit, by ingredient id: what a ref's shown number is. */
export type RefRows = ReadonlyMap<string, { mult: number; name: string; unit: string }>;

/** "lime" → "limes", "leaf" → "leaves", "tomato" → "tomatoes", "cherry" → "cherries". */
export function pluralOf(w: string): string {
  if (/^(?:anise|zucchini|broccoli|shrimp|fish|salmon|cod|tuna|lettuce|celery)$/i.test(w)) return w;
  if (/(?:lea|loa|hal|shea)f$/i.test(w)) return w.replace(/f$/i, "ves");
  if (/mango$/i.test(w)) return `${w}es`;
  if (/kni(?:fe)$/i.test(w)) return w.replace(/fe$/i, "ves");
  if (/(?:tomato|potato)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return w.replace(/y$/i, "ies");
  if (/(?:s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  return `${w}s`;
}

const NOUN_STOP = /^(?:and|or|with|into|in|to|for|from|of|on|over|until|at|then|each|the|a|an)$/i;
/** The words that count a food whatever its name says ("1 garlic clove", "1 celery stalk"). */
const COUNT_NOUN = /^(?:clove|stalk|rib|sprig|leaf|head|slice|piece|strip|wedge|stick|packet|pouch|ball|half|heart|fillet|breast|thigh|yolk|white|ear|bulb)$/i;

/**
 * SERVER-10 E (BUG-597) — the noun after a unit-less amount, said for the number the
 * plan shows. The server serves the authored text and its amountRefs; the client puts
 * the plan's number in the ref's place and cannot re-word the prose after it, so at a
 * scaled serving it read "1 limes", "1 eggs", "1 porterhouse steaks" (QA-COOK-1).
 * Both directions:
 *   - authored more than one, shown one or less: the plural head goes singular
 *     ("2 limes" at ×0.5 → "… lime"); THX-3d round 2 (O) had this, for feasts;
 *   - authored one or less, shown more than one: the head goes plural
 *     ("1 lime" at ×2 → "… limes").
 * The head is the last noun-like word within five after the number, before a joining
 * word ("Cut 2 limes into wedges", "2 large egg yolks, beaten"). Going PLURAL, the head
 * must also name the ref's own food or be a count noun ("1 lime, juiced", "1 garlic
 * clove"): a sweep of the 21,140 public dish steps at ×2 showed what a bare
 * last-word rule writes otherwise ("1 lengthwises", "1 yellows"). A ref that carries
 * its unit ("2 cups") is the client's to agree, as it already does. `taken` are edits
 * a caller already made: a noun inside one is left alone.
 */
export function refNounEdits(step: WordingStep, rows: RefRows, taken: readonly Edit[] = []): Edit[] {
  const text = step.text;
  const out: Edit[] = [];
  for (const r of step.amountRefs ?? []) {
    const row = rows.get(r.ingredientId);
    if (!row || /[a-z]/i.test(text.slice(r.charStart, r.charEnd))) continue;
    const shown = displayedPrepQuantity(r.quantity * row.mult, r.unit || row.unit, row.name);
    const toOne = r.quantity > 1 && shown <= 1;
    const toMany = r.quantity <= 1 && shown > 1;
    if (!toOne && !toMany) continue;
    const after = /^((?:\s+[A-Za-zÀ-ÿ'-]+){1,5})/.exec(text.slice(r.charEnd))?.[1] ?? "";
    const words = [...after.matchAll(/[A-Za-zÀ-ÿ'-]+/g)];
    // The food's own head noun ("red bell pepper" → pepper), never a modifier of it.
    const named = new Set(row.name.toLowerCase().split(/[,(]/)[0].split(/[^a-zà-ÿ'-]+/).filter(Boolean).slice(-1).map(singularOf));
    let head: RegExpMatchArray | undefined;
    for (const w of words) {
      if (NOUN_STOP.test(w[0])) break;
      const plural = /s$/i.test(w[0]) && !/(?:ss|us)$/i.test(w[0]);
      const own = named.has(w[0].toLowerCase()) || COUNT_NOUN.test(w[0]);
      if (toOne ? plural : !plural && own) head = w;
    }
    if (!head) continue;
    const at = r.charEnd + head.index!;
    if ([...taken, ...out].some((e) => e.start <= at && at < e.end)) continue;
    out.push({ start: at, end: at + head[0].length, text: toOne ? singularOf(head[0]) : pluralOf(head[0]) });
  }
  return out;
}

/** SERVER-10 E — a step with its unit-less amounts' nouns agreed (refNounEdits). */
export function agreeScaledNouns(step: WordingStep, rows: RefRows): WordingStep {
  return applyEdits(step, refNounEdits(step, rows));
}

/** The step with `edits` applied; every ref outside an edit moves with its text. */
function applyEdits(step: WordingStep, edits: Edit[]): WordingStep {
  const text = step.text;
  if (edits.length === 0) return step;
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  const refs: WordingRef[] = [];
  const shift: { at: number; by: number }[] = [];
  for (const e of edits) {
    if (e.start < cursor) continue;
    out += text.slice(cursor, e.start) + e.text;
    shift.push({ at: e.end, by: e.text.length - (e.end - e.start) });
    cursor = e.end;
  }
  out += text.slice(cursor);
  for (const r of step.amountRefs ?? []) {
    // A ref inside a rewritten frame goes (its number is gone); the rest move.
    if (edits.some((e) => r.charStart < e.end && e.start < r.charEnd)) continue;
    const by = shift.filter((s) => s.at <= r.charStart).reduce((t, s) => t + s.by, 0);
    refs.push({ ...r, charStart: r.charStart + by, charEnd: r.charEnd + by });
  }
  return { ...step, text: out, amountRefs: step.amountRefs ? refs : null };
}
