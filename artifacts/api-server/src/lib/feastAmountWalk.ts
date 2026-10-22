// THX-3d (B, R2) — EVERY FEAST STEP AMOUNT EQUALS ITS INGREDIENT LINE.
//
// Hans, October 21: the cranberry mix said ⅔ cup sugar and the step said 1½ cups.
// The step's amountRef had the unit "½ cups" (the matcher read "1" as the number of
// "1½ cups"), the client treats such a unit as corrupt and prints the authored text,
// and the authored text does not scale. This walk is the check behind the fix: for one
// dish, each step amount against the dish's own rows. Pure; the test (dev DB, opt-in)
// and patch.ts both run it.
//
// A finding is one of:
//   corrupt   — a ref whose unit carries a number ("½ cups"): printed unscaled.
//   unbound   — an ingredient amount in the text with no ref: printed unscaled.
//   mismatch  — a ref that is neither the row's amount nor a share of a split the
//               dish's refs add up to ("3 for the brine, 3 for the butter").
//   count     — a count in words or a structural count that is really an ingredient
//               ("both oranges", "the 2 sheets"): it cannot scale.

import { deriveAmountRefs, detectSpans, isByDesign, normalizeUnit, type AmountRef, type MatcherIngredient } from "./stepAmountRefs";

export interface WalkRow extends MatcherIngredient {
  /** "plus more for boiling water": the steps may use more than the row says. */
  preparationNote?: string | null;
}
export interface WalkStep {
  stepIndex: number;
  text: string;
  amountRefs: unknown;
}
export interface AmountFinding {
  stepIndex: number;
  kind: "corrupt" | "unbound" | "mismatch" | "count";
  detail: string;
}

const TO_TSP: Record<string, number> = { tsp: 1, tbsp: 3, cup: 48 };
const TO_OZ: Record<string, number> = { oz: 1, lb: 16, g: 1 / 28.3495, kg: 35.274 };

/** `q` of unit `from`, in unit `to`; null when the two are not one family. */
export function convertAmount(q: number, from: string, to: string): number | null {
  const a = normalizeUnit(from);
  const b = normalizeUnit(to);
  if (a === b) return q;
  if (TO_TSP[a] && TO_TSP[b]) return (q * TO_TSP[a]) / TO_TSP[b];
  if (TO_OZ[a] && TO_OZ[b]) return (q * TO_OZ[a]) / TO_OZ[b];
  // A count against a count-ish row ("2 oranges" / 2 each).
  const count = (u: string) => u === "" || u === "each";
  if (count(a) && count(b)) return q;
  return null;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02 * Math.abs(b), 1e-6);

/** A ref's unit carries a number or a fraction: the matcher split a mixed number. */
export const corruptUnit = (unit: string) => /[\d½¼¾⅓⅔⅛⅜⅝⅞]/.test(unit);

const COUNT_WORDS = /\b(both|two|three|four|five|six|a couple of|a dozen)\s+(?:of\s+the\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)/gi;
const STRUCTURAL = /^\s*(sheets?|crusts?|caps?|boxes|box|packages?|bags?|cans?|jars?)\b/i;

/** "oranges" → "orange", "potatoes" → "potato", "boxes" → "box". */
export const singular = (w: string) => w.toLowerCase().replace(/(?:(?<=[sxz]|ch|sh|o)es|s)$/, "");

function headWord(name: string): string {
  const w = name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/);
  return singular(w[w.length - 1] ?? "");
}

export function feastAmountFindings(
  rows: readonly WalkRow[],
  steps: readonly WalkStep[],
  opts: { derive?: boolean } = {},
): AmountFinding[] {
  const out: AmountFinding[] = [];
  const refsOf = (s: WalkStep): AmountRef[] =>
    opts.derive ? deriveAmountRefs(s.text, [...rows]).amountRefs : Array.isArray(s.amountRefs) ? (s.amountRefs as AmountRef[]) : [];
  const all = steps.map((s) => ({ s, refs: refsOf(s) }));
  // A ref scales with its dish, so a SHARE of a row ("1 egg" of 2, the other "the second
  // beaten egg") prints right at any household. What cannot is a ref MORE than the dish
  // lists of that food — all its rows (a food listed twice is two rows) — or refs that
  // add up to more: those are bound to the wrong food or say another amount.
  const totalOf = (id: string, unit: string) => {
    let t = 0;
    for (const row of rows.filter((x) => x.ingredientId === id)) {
      const q = convertAmount(row.quantity, row.unit, unit);
      if (q === null) return null;
      t += q;
    }
    return t;
  };
  // "Add the 1½ lb chopped cremini" restates the amount "Chop 1½ lb cremini" measured
  // (THX-3c F's rule (h)): one use, said twice. Only a ref not after "the" is a use.
  const restates = (s: WalkStep, r: AmountRef) => /\bthe\s+$/i.test(s.text.slice(Math.max(0, r.charStart - 5), r.charStart));
  const sumOf = new Map<string, number>();
  for (const { s, refs } of all) {
    for (const r of refs) {
      if (restates(s, r)) continue;
      const row = rows.find((x) => x.ingredientId === r.ingredientId);
      const q = row ? convertAmount(r.quantity, r.unit, row.unit) : null;
      if (row && q !== null && !corruptUnit(r.unit)) sumOf.set(row.ingredientId, (sumOf.get(row.ingredientId) ?? 0) + q);
    }
  }
  for (const { s, refs } of all) {
    for (const r of refs) {
      const span = s.text.slice(r.charStart, r.charEnd);
      if (corruptUnit(r.unit)) { out.push({ stepIndex: s.stepIndex, kind: "corrupt", detail: `"${span}" unit "${r.unit}"` }); continue; }
      const row = rows.find((x) => x.ingredientId === r.ingredientId);
      if (!row) continue;
      const q = convertAmount(r.quantity, r.unit, row.unit);
      const total = totalOf(row.ingredientId, row.unit);
      if (q === null || total === null) continue; // another measure of the food ("48 oz (6 cups)")
      const over = (x: number) => x > total * 1.02 + 1e-6;
      // A step that states the WHOLE amount is that food's one use, however often a list
      // repeats it ("pick 2 tbsp thyme", then "add … 2 tbsp thyme"): only shares add up.
      const listings = rows.filter((x) => x.ingredientId === row.ingredientId);
      const whole = all.some(({ refs: rs }) => rs.some((x) => x.ingredientId === row.ingredientId && [total, ...listings.map((l) => convertAmount(l.quantity, l.unit, row.unit) ?? -1)].some((t) => close(convertAmount(x.quantity, x.unit, row.unit) ?? -1, t))));
      if (listings.some((l) => /\bplus more\b/i.test(l.preparationNote ?? ""))) continue;
      if (!over(q) && (whole || !over(sumOf.get(row.ingredientId) ?? 0))) continue;
      out.push({ stepIndex: s.stepIndex, kind: "mismatch", detail: `"${span}" → ${row.name}: the dish lists ${+total.toFixed(3)} ${row.unit}, the steps use ${+(sumOf.get(row.ingredientId) ?? 0).toFixed(3)}` });
    }
    for (const span of detectSpans(s.text)) {
      if (isByDesign(s.text, span)) {
        // A structural count that names a food the dish lists ("the 2 sheets" of puff pastry).
        const after = s.text.slice(span.end, span.end + 20);
        const m = STRUCTURAL.exec(after);
        if (m && rows.some((row) => headWord(row.name) === singular(m[1]) || row.unit.toLowerCase().includes(singular(m[1])))) {
          out.push({ stepIndex: s.stepIndex, kind: "count", detail: `"${s.text.slice(span.start, span.end)}${m[0]}" counts a listed food` });
        }
        continue;
      }
      if (refs.some((r) => r.charStart <= span.start && r.charEnd >= span.end)) continue;
      out.push({ stepIndex: s.stepIndex, kind: "unbound", detail: `"${span.text}" ${s.text.slice(span.end, span.end + 24).trim()}…` });
    }
    for (const m of s.text.matchAll(COUNT_WORDS)) {
      const noun = singular(m[2].split(/\s+/).pop()!);
      if (rows.some((row) => headWord(row.name) === noun)) out.push({ stepIndex: s.stepIndex, kind: "count", detail: `"${m[0]}" counts a listed food in words` });
    }
  }
  return out;
}
