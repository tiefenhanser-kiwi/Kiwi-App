// THX-3d (B, R2) — "every feast step equals its ingredient line": the content half.
// Pure; patch.ts runs it on each feast dish, no AI.
//
//   missingRows  — a step that measures stock, broth or water the dish does not list
//                  ("Measure 48 oz (6 cups) store-bought turkey or chicken stock",
//                  "cover with 8 cups water"): the amount has no row to scale by, so it
//                  printed as written at every household. The row is added on the
//                  step's own component and path (a bought-path stock is bought only
//                  when the cook takes that path, grocery B3's per-component rule).
//   countsInWords — "Zest and juice both oranges" is 2 oranges at 10 and 1 at 4: the
//                  word cannot scale, the number can ("2 oranges", then its ref).
//   mergeRefs    — the re-derived refs, plus any stored ref the matcher no longer
//                  makes (THX-3: re-deriving from today's names lost a ref once), never
//                  a corrupt one ("½ cups") or a duration ("2 days").

import { detectSpans, isByDesign, type AmountRef } from "../../src/lib/stepAmountRefs";
import { corruptUnit, singular } from "../../src/lib/feastAmountWalk";

export interface RowsStep {
  stepIndex: number;
  text: string;
  componentKey: string | null;
  pathKey: string | null;
  amountRefs: unknown;
}
export interface RowsRow {
  name: string;
  quantity: number;
  unit: string;
}
export interface MissingRow {
  /** The Ingredient's canonical name the patch looks up. */
  canonicalName: string;
  quantity: number;
  unit: string;
  preparationNote: string | null;
  componentKey: string | null;
  pathKey: string | null;
  stepIndex: number;
}

const LIQUIDS: ReadonlyArray<{ word: RegExp; canonical: string; note: string | null; has: RegExp }> = [
  { word: /^\s*(?:\([^)]*\)\s*)?(?:of the\s+)?(?:store-bought\s+)?(?:low-sodium\s+)?(?:turkey or chicken|chicken or turkey|turkey|chicken)\s+(?:stock|broth)\b/i, canonical: "chicken or turkey stock", note: "store-bought", has: /\b(stock|broth)\b/i },
  { word: /^\s*(?:cold\s+)?water\b/i, canonical: "water", note: null, has: /\bwater\b/i },
];

const UNIT_OF: Record<string, string> = { cup: "cup", cups: "cup", oz: "ounce", ounce: "ounce", ounces: "ounce", quart: "quart", quarts: "quart" };

/** The stock and water rows the dish's steps measure but never list. */
export function missingRows(rows: readonly RowsRow[], steps: readonly RowsStep[]): MissingRow[] {
  const out: MissingRow[] = [];
  for (const liquid of LIQUIDS) {
    if (rows.some((r) => liquid.has.test(r.name))) continue;
    for (const s of steps) {
      if (out.some((m) => m.canonicalName === liquid.canonical)) break;
      for (const span of detectSpans(s.text)) {
        if (isByDesign(s.text, span) || span.num === null) continue;
        const unit = UNIT_OF[span.unit.toLowerCase()];
        if (!unit || !liquid.word.test(s.text.slice(span.end))) continue;
        out.push({ canonicalName: liquid.canonical, quantity: span.num, unit, preparationNote: liquid.note, componentKey: s.componentKey, pathKey: s.pathKey, stepIndex: s.stepIndex });
        break;
      }
    }
  }
  return out;
}

const WORD_COUNT: Record<string, number> = { both: 2, two: 2, three: 3, four: 4 };



/** "both oranges" → "2 oranges", when the dish lists exactly that many of that food. */
export function countsInWords(text: string, rows: readonly RowsRow[]): string {
  return text.replace(/\b(both|two|three|four)\s+([a-z]+)\b/gi, (all, word: string, noun: string) => {
    const n = WORD_COUNT[word.toLowerCase()];
    const stem = singular(noun);
    const row = rows.find((r) => {
      const head = r.name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).pop() ?? "";
      return singular(head) === stem && Math.abs(r.quantity - n) < 1e-9 && /^(?:each|whole|)$/i.test(r.unit.trim());
    });
    return row ? `${n} ${noun}` : all;
  });
}

/** The re-derived refs, keeping a stored ref the matcher no longer makes (never a corrupt one). */
export function mergeRefs(text: string, derived: readonly AmountRef[], stored: unknown): AmountRef[] {
  const out = [...derived];
  const DURATION_AFTER = /^\s*(?:-\s*)?(?:days?|weeks?|nights?|months?)\b(?!-old)/i;
  for (const r of (Array.isArray(stored) ? stored : []) as AmountRef[]) {
    if (corruptUnit(r.unit ?? "") || DURATION_AFTER.test(text.slice(r.charEnd, r.charEnd + 10))) continue;
    if (r.charEnd > text.length || out.some((d) => d.charStart < r.charEnd && r.charStart < d.charEnd)) continue;
    // Only where the text at the span still reads the same amount.
    const span = detectSpans(text).find((x) => x.start === r.charStart && x.end === r.charEnd);
    if (!span || isByDesign(text, span)) continue;
    out.push(r);
  }
  return out.sort((a, b) => a.charStart - b.charStart);
}
