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
      const mult = dishRowMultipliers(dish.ingredients.map((i) => ({ quantity: i.quantity, unit: i.unit, name: i.ingredientName })), servings / authored, { feast: !!meal.feast });
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

type Edit = { start: number; end: number; text: string };

/** "leaves" → "leaf", "potatoes" → "potato", "cherries" → "cherry", "jalapeños" → "jalapeño". */
export function singularOf(w: string): string {
  if (/leaves$/i.test(w)) return w.replace(/ves$/i, "f");
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
  for (const r of step.amountRefs ?? []) {
    const row = scale.rows.get(r.ingredientId);
    if (!row || r.quantity === 1 || /[a-z]/i.test(text.slice(r.charStart, r.charEnd))) continue;
    if (displayedPrepQuantity(r.quantity * row.mult, r.unit || row.unit, row.name) !== 1) continue;
    const after = /^((?:\s+[A-Za-zÀ-ÿ'-]+){1,5})/.exec(text.slice(r.charEnd))?.[1] ?? "";
    const words = [...after.matchAll(/[A-Za-zÀ-ÿ'-]+/g)];
    let head: RegExpMatchArray | undefined;
    for (const w of words) {
      if (/^(?:and|or|with|into|in|to|for|from|of|on|over)$/i.test(w[0])) break;
      if (/s$/i.test(w[0]) && !/(?:ss|us)$/i.test(w[0])) head = w;
    }
    if (!head || edits.some((e) => e.start <= r.charEnd + head!.index! && r.charEnd + head!.index! < e.end)) continue;
    const at = r.charEnd + head.index!;
    edits.push({ start: at, end: at + head[0].length, text: singularOf(head[0]) });
  }
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
