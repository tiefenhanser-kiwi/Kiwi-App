// CAT-Q1 — amounts in step text: the decimal and ⅜/⅝/⅞ spans no cook measures,
// and their rewrite to the cook's fraction (Part B), plus the list of them the
// Part C limits use so an edit can never ADD one. Pure.
//
// Ounces are NOT amounts here: a decimal ounce is the package size printed on
// the can ("14.5 oz diced tomatoes") — CAT-Q0's prose_decimal rule, kept.
import { isCookFraction, snapToCookFraction } from "../../thx2/thx2Checks";
import * as clientQuantity from "../../../../kiwi/lib/format/quantity";

// kiwi/ loads as CommonJS under tsx: the named exports sit on default.
type Q = { formatNeedGlyph: (q: number) => string };
const Qx: Q = (clientQuantity as unknown as Partial<Q>).formatNeedGlyph ? (clientQuantity as unknown as Q) : (clientQuantity as unknown as { default: Q }).default;

export const SPOON_OR_CUP = /^(teaspoons?|tsp|tablespoons?|tbsp|cups?)$/i;
const GLYPH: Record<string, number> = { "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8 };
const SINGULAR: Record<string, string> = { cups: "cup", teaspoons: "teaspoon", tablespoons: "tablespoon", pounds: "pound", lbs: "lb" };
const singular = (u: string, q: number) => (q <= 1 ? (SINGULAR[u.toLowerCase()] ?? u) : u);

export const PROSE_DECIMAL = /(?<![\d.\-])(\d*\.\d+)(\s*|-)(cups?|teaspoons?|tsp|tablespoons?|tbsp|pounds?|lbs?)\b/gi;
export const PROSE_EIGHTH = /(?<![\d.])(\d*)([⅜⅝⅞])(\s*|-)(cups?|teaspoons?|tsp|tablespoons?|tbsp)\b/g;

/** The step text with every decimal / eighth amount rewritten, plus what was left. */
export function fixProse(text: string): { text: string; left: string[] } {
  const left: string[] = [];
  let out = text.replace(PROSE_DECIMAL, (all, num: string, sep: string, unit: string) => {
    const v = Number(num);
    const spoon = SPOON_OR_CUP.test(unit);
    const q = spoon ? snapToCookFraction(v) : v;
    if (!(q > 0) || (!spoon && !isCookFraction(v))) { left.push(all); return all; }
    return `${Qx.formatNeedGlyph(q)}${sep}${singular(unit, q)}`;
  });
  out = out.replace(PROSE_EIGHTH, (_all, whole: string, g: string, sep: string, unit: string) => {
    const q = snapToCookFraction((whole ? Number(whole) : 0) + GLYPH[g]);
    return `${Qx.formatNeedGlyph(q)}${sep}${singular(unit, q)}`;
  });
  return { text: out, left };
}


/** Every decimal or ⅜/⅝/⅞ amount span in the text, as written. */
export function proseFlaws(text: string): string[] {
  return [...text.matchAll(PROSE_DECIMAL), ...text.matchAll(PROSE_EIGHTH)].map((m) => m[0]);
}
