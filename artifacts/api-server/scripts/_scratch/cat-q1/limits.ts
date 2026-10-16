// CAT-Q1 Part C — the hard limits, in code. The editor's tool input becomes
// Edits here or the WHOLE patch is rejected with every reason. Pure: the one
// database fact it needs (which existing Ingredient row a new name resolves
// to) is passed in, looked up beforehand by the resolver's own read half.
//
//   types     every quantity a finite JS number > 0 (THX-2G: the model writes
//             "½" into numeric fields; the schema says number, this checks it);
//             minutes an integer 0–1440; answers cite real issue numbers.
//   ids       every id is one the payload showed (the default path only).
//   old       every `old` equals the stored value exactly.
//   named     every edit targets a step or line an issue it answers names, or
//             one that edit strictly requires (below).
//   amounts   cook's fractions (a third may come as 0.3333; it is stored as
//             1/3 exactly), units from the catalog vocabulary or unchanged,
//             and no step text gains a decimal or ⅜/⅝/⅞ spoon amount.
//   lines     a new line names an EXISTING Ingredient (never created) that a
//             default-path step of its dish uses, and is not already listed.
import { isCookFraction, snapToCookFraction } from "../../thx2/thx2Checks";
import { mentionWord } from "../../thx2/thx2Core";
import type { CatDish, CatMeal } from "../cat-q0/catalogDb";
import type { Edit, IngFields, IngRow } from "./edits";
import type { EditorIng, IdMap, PatchInput } from "./editor";
import type { Q0Issue } from "./issues";
import { proseFlaws } from "./prose";

export const VALID_UNITS = new Set([
  "teaspoon", "tablespoon", "cup", "ounce", "pound", "each", "clove", "sprig", "slice", "head", "stalk", "can", "bunch",
  "inch", "fluid ounce", "quart", "leaf", "pinch", "pint", "gram", "packet", "strip", "jar", "sheet", "loaf",
]);

export interface LimitResult {
  /** Empty when anything is rejected: a patch is accepted whole or not at all. */
  edits: Edit[];
  /** What the patch would have done, for the diff a human reads (never applied). */
  proposed: Edit[];
  rejections: string[]; declined: Array<{ issue: number; reason: string }>; notes: string[] }

const norm = (s: string) => s.toLowerCase().replace(/[“”"']/g, "").replace(/\s+/g, " ").trim();
const wordIn = (hay: string, w: string) => w.length >= 3 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:e?s)?\\b`, "i").test(hay);
const stepMentions = (why: string) => [...why.matchAll(/\bsteps?\s+(\d+)\b/gi)].map((m) => Number(m[1]));

/** Which dishes an issue is about: its title, else the meal as a whole, else the only dish. */
export function issueDishes(m: CatMeal, i: Pick<Q0Issue, "dish">): CatDish[] {
  const t = norm(i.dish);
  const exact = m.dishes.filter((d) => norm(d.title) === t);
  if (exact.length) return exact;
  if (t === norm(m.title) || t === norm(m.displayTitle ?? "") || m.dishes.length === 1) return m.dishes;
  return [];
}

export function stepNamedBy(d: CatDish, s: CatDish["steps"][number], i: Q0Issue): boolean {
  if (i.stepIndex === s.stepIndex) return true;
  if (i.quote.length >= 8 && norm(s.text).includes(norm(i.quote).replace(/…$/, ""))) return true;
  return [...stepMentions(i.why), ...stepMentions(i.fix)].includes(s.stepIndex);
}

export function lineNamedBy(printed: string, ing: CatDish["ingredients"][number], i: Q0Issue): boolean {
  if (i.ingredient && norm(i.ingredient) === norm(printed)) return true;
  const q = norm(i.quote);
  if (q.length >= 8 && (q.includes(norm(printed)) || norm(printed).includes(q))) return true;
  const text = `${i.ingredient ?? ""} ${i.quote} ${i.why} ${i.fix}`;
  return [ing.name, ing.canonicalName].some((n) => n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text));
}

function checkIng(v: EditorIng, where: string, oldUnit: string | null, bad: string[]): IngFields | null {
  const q = v.quantity as unknown;
  if (typeof q !== "number" || !Number.isFinite(q)) { bad.push(`${where}: quantity ${JSON.stringify(q)} is not a plain number`); return null; }
  if (q <= 0) { bad.push(`${where}: quantity ${q} is not positive`); return null; }
  const snapped = snapToCookFraction(q);
  if (Math.abs(snapped - q) > 0.005 || snapped <= 0) { bad.push(`${where}: quantity ${q} is not a cook's fraction`); return null; }
  if (typeof v.unit !== "string" || (!VALID_UNITS.has(v.unit.trim().toLowerCase()) && v.unit !== oldUnit)) { bad.push(`${where}: unit ${JSON.stringify(v.unit)} is not a catalog unit`); return null; }
  if (typeof v.name !== "string" || !v.name.trim()) { bad.push(`${where}: empty name`); return null; }
  if (typeof v.optional !== "boolean") { bad.push(`${where}: optional is not a boolean`); return null; }
  return { quantity: isCookFraction(q) ? q : snapped, unit: v.unit, name: v.name, preparationNote: v.note ?? null, isOptional: v.optional };
}

/**
 * `resolved`: lowercased name → the existing Ingredient row it resolves to, or
 * null (a miss). Every new name in the patch must be a key.
 */
export function checkPatch(
  m: CatMeal, input: PatchInput, ids: IdMap, issues: readonly Q0Issue[], resolved: ReadonlyMap<string, IngRow | null>,
  printed: ReadonlyMap<string, string>,
): LimitResult {
  const bad: string[] = [];
  const notes: string[] = [];
  const byN = new Map(issues.map((i) => [i.n, i]));
  const dishById = new Map(m.dishes.map((d) => [d.dishId, d]));
  const answered = new Set<number>();
  const answersOk = (a: unknown, where: string): number[] => {
    if (!Array.isArray(a) || a.length === 0) { bad.push(`${where}: answers no issue`); return []; }
    const xs = a.filter((n) => Number.isInteger(n) && byN.has(n as number)) as number[];
    if (xs.length !== a.length) bad.push(`${where}: answers ${JSON.stringify(a)} cite an issue that does not exist`);
    xs.forEach((n) => answered.add(n));
    return xs;
  };

  // ── shape, ids, old ──
  type S = { e: Extract<Edit, { kind: "step" }>; d: CatDish; s: CatDish["steps"][number] };
  type L = { e: Extract<Edit, { kind: "ingredient" }>; d: CatDish; i: CatDish["ingredients"][number]; printed: string };
  type N = { e: Extract<Edit, { kind: "new_ingredient" }>; d: CatDish };
  const steps: S[] = [];
  const lines: L[] = [];
  const news: N[] = [];
  const seen = new Set<string>();
  for (const x of input.step_edits ?? []) {
    const where = `step ${x.step_id}`;
    const ref = ids.step.get(x.step_id);
    if (!ref) { bad.push(`${where}: not a step the payload showed (default path only)`); continue; }
    if (seen.has(x.step_id)) { bad.push(`${where}: edited twice`); continue; }
    seen.add(x.step_id);
    const d = dishById.get(ref.dishId)!;
    const s = d.steps.find((y) => y.id === ref.rowId)!;
    const answers = answersOk(x.answers, where);
    if (!Number.isInteger(x.new_minutes) || x.new_minutes < 0 || x.new_minutes > 1440) bad.push(`${where}: minutes ${JSON.stringify(x.new_minutes)} is not an integer 0–1440`);
    if (x.old_text !== s.text) bad.push(`${where} (${d.title} step ${s.stepIndex}): old text is not the stored text`);
    if (x.old_minutes !== s.estimatedMinutes) bad.push(`${where}: old minutes ${x.old_minutes} ≠ stored ${s.estimatedMinutes}`);
    if (typeof x.new_text !== "string" || !x.new_text.trim()) { bad.push(`${where}: empty new text`); continue; }
    if (x.new_text === x.old_text && x.new_minutes === x.old_minutes) { notes.push(`${where}: a no-op edit, dropped`); continue; }
    const before = new Set(proseFlaws(s.text));
    for (const f of proseFlaws(x.new_text)) if (!before.has(f)) bad.push(`${where}: new text adds "${f}" — not a cook's fraction`);
    steps.push({ d, s, e: { source: "C", kind: "step", dishId: d.dishId, dishTitle: d.title, answers, stepId: ref.rowId, stepIndex: s.stepIndex, old: { text: s.text, minutes: s.estimatedMinutes }, new: { text: x.new_text, minutes: x.new_minutes } } });
  }
  for (const x of input.line_edits ?? []) {
    const where = `line ${x.line_id}`;
    const ref = ids.line.get(x.line_id);
    if (!ref) { bad.push(`${where}: not a line the payload showed (default path only)`); continue; }
    if (seen.has(x.line_id)) { bad.push(`${where}: edited twice`); continue; }
    seen.add(x.line_id);
    const d = dishById.get(ref.dishId)!;
    const i = d.ingredients.find((y) => y.id === ref.rowId)!;
    const answers = answersOk(x.answers, where);
    const o = x.old;
    if (!o || o.quantity !== i.quantity || o.unit !== i.unit || o.name !== i.name || (o.note ?? null) !== (i.preparationNote ?? null) || o.optional !== i.isOptional) {
      bad.push(`${where} (${d.title} "${printed.get(ref.rowId)}"): old ${JSON.stringify(o)} is not the stored line`);
      continue;
    }
    const old: IngFields = { quantity: i.quantity, unit: i.unit, name: i.name, preparationNote: i.preparationNote, isOptional: i.isOptional };
    if (x.remove) {
      lines.push({ d, i, printed: printed.get(ref.rowId) ?? i.name, e: { source: "C", kind: "ingredient", dishId: d.dishId, dishTitle: d.title, answers, lineId: ref.rowId, old, new: null } });
      continue;
    }
    const nu = checkIng(x.new, where, i.unit, bad);
    if (!nu) continue;
    let ingredient: IngRow | null = null;
    if (nu.name !== i.name) {
      const r = resolved.get(nu.name.toLowerCase().trim());
      if (!r) { bad.push(`${where}: "${nu.name}" resolves to no existing ingredient (Ingredient rows are never created)`); continue; }
      ingredient = r;
      nu.name = r.displayName;
    }
    if (nu.quantity === i.quantity && nu.unit === i.unit && nu.name === i.name && nu.preparationNote === i.preparationNote && nu.isOptional === i.isOptional) { notes.push(`${where}: a no-op edit, dropped`); continue; }
    lines.push({ d, i, printed: printed.get(ref.rowId) ?? i.name, e: { source: "C", kind: "ingredient", dishId: d.dishId, dishTitle: d.title, answers, lineId: ref.rowId, old, new: nu, ingredient } });
  }
  for (const x of input.new_lines ?? []) {
    const where = `new line "${x.line?.name}" in ${x.dish}`;
    const d = m.dishes.find((y) => norm(y.title) === norm(x.dish ?? ""));
    if (!d) { bad.push(`${where}: no dish has that title`); continue; }
    const answers = answersOk(x.answers, where);
    const nu = checkIng(x.line, where, null, bad);
    if (!nu) continue;
    const r = resolved.get(nu.name.toLowerCase().trim());
    if (!r) { bad.push(`${where}: resolves to no existing ingredient (Ingredient rows are never created)`); continue; }
    if (d.ingredients.some((y) => y.ingredientId === r.id)) { bad.push(`${where}: ${d.title} already lists "${r.displayName}"`); continue; }
    news.push({ d, e: { source: "C", kind: "new_ingredient", dishId: d.dishId, dishTitle: d.title, answers, old: null, new: { ...nu, name: r.displayName }, ingredient: r } });
  }

  // ── named, or strictly required ──
  const named = (answers: number[], test: (i: Q0Issue, ds: CatDish[]) => boolean) => answers.some((n) => { const i = byN.get(n)!; const ds = issueDishes(m, i); return test(i, ds); });
  const newTextOf = (d: CatDish) => steps.filter((x) => x.d === d).map((x) => x.e.new.text).join(" \n ");
  const postText = (d: CatDish) => d.steps.map((s) => steps.find((x) => x.s === s)?.e.new.text ?? s.text).join(" \n ");
  const lineNamed = new Map<L, boolean>();
  for (const x of lines) lineNamed.set(x, named(x.e.answers, (i, ds) => ds.includes(x.d) && lineNamedBy(x.printed, x.i, i)));
  const stepNamed = new Map<S, boolean>();
  for (const x of steps) stepNamed.set(x, named(x.e.answers, (i, ds) => ds.includes(x.d) && stepNamedBy(x.d, x.s, i)));
  const shares = (a: number[], b: number[]) => a.some((n) => b.includes(n));
  for (const x of lines) {
    if (lineNamed.get(x)) continue;
    // required: a named step edit in this patch now states this line's item
    const w = mentionWord(x.i.name);
    const by = steps.find((s) => s.d === x.d && stepNamed.get(s) && shares(s.e.answers, x.e.answers) && (wordIn(s.e.new.text, w) || wordIn(s.e.new.text, x.i.name)));
    if (!by) bad.push(`line "${x.printed}" (${x.d.title}): no issue it answers names it, and no edited step requires it`);
  }
  for (const x of steps) {
    if (stepNamed.get(x)) continue;
    // required: it states the amount of a named line this patch changes
    const by = lines.find((l) => l.d === x.d && lineNamed.get(l) && shares(l.e.answers, x.e.answers) && (wordIn(x.s.text, mentionWord(l.i.name)) || wordIn(x.s.text, l.i.name)));
    if (!by) bad.push(`step ${x.s.stepIndex} (${x.d.title}): no issue it answers names it, and no edited line requires it — "${x.s.text.slice(0, 70)}…"`);
  }
  for (const x of news) {
    const w = mentionWord(x.e.ingredient.displayName);
    if (!(wordIn(postText(x.d), w) || wordIn(postText(x.d), x.e.ingredient.displayName) || wordIn(newTextOf(x.d), w))) bad.push(`new line "${x.e.new.name}" (${x.d.title}): no default-path step of the dish uses it`);
    if (!named(x.e.answers, (_i, ds) => ds.includes(x.d))) bad.push(`new line "${x.e.new.name}" (${x.d.title}): the issues it answers are about another dish`);
  }

  // ── every issue answered or declined, never both ──
  const declined = (input.declined ?? []).filter((x) => byN.has(x.issue));
  for (const x of declined) if (answered.has(x.issue)) bad.push(`issue ${x.issue}: both answered and declined`);
  for (const i of issues) if (!answered.has(i.n) && !declined.some((x) => x.issue === i.n)) { declined.push({ issue: i.n, reason: "(not addressed by the editor)" }); notes.push(`issue ${i.n}: neither answered nor declined — counted as declined`); }

  const edits: Edit[] = [...lines.map((x) => x.e), ...news.map((x) => x.e), ...steps.map((x) => x.e)];
  return { edits: bad.length ? [] : edits, proposed: edits, rejections: bad, declined, notes };
}
