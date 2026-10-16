// CAT-Q1 Part B — the deterministic fixes. Pure: a stored meal in, Edits out.
// No AI, no judgment: each rule is a rule the generator already applies to new
// meals (thx2Checks), or the client's own rounding written into the row.
//
//   garlic_clove    "N each garlic" with no "clove" in the name → unit clove
//                   (thx2Checks.fixUnit's garlic branch; name untouched); a
//                   "cloves" in the note is dropped ("cloves, minced" → "minced").
//   spoon_eighth    a spoon/cup line the screen prints as ⅜ ⅝ ⅞ (no spoon
//                   measures it) → snapToCookFraction (⅜→⅓, ⅝→⅔, ⅞→¾).
//   prose_decimal   a decimal amount in step text → the cook's fraction, as the
//                   glyph the screen uses (formatNeedGlyph): spoon/cup amounts
//                   snapped (0.33 cup → ⅓ cup); pounds only when the decimal
//                   already IS a quarter, half or third (0.75 lb → ¾ lb; 0.4 lb
//                   is a rounding call, left to Part C). Never ounces: a decimal
//                   ounce is the size printed on the can ("14.5 oz"). A unit word after an
//                   amount of 1 or less goes singular ("0.5 cups" → "½ cup").
//   prose_eighth    ⅜ ⅝ ⅞ before a spoon/cup word in step text → the same snap
//                   as spoon_eighth, so a line and its step stay in step.
//   swap_self       thx2Checks.swapProblem → the substitution removed — ONLY
//                   when no bought-path row belongs to it: removing a path is a
//                   structure change, so those are reported, not edited.
// Every path's steps are scanned (a decimal is a decimal on the bought path too).
import { fixUnit, snapToCookFraction, swapKey, swapProblem } from "../../thx2/thx2Checks";
import * as clientQuantity from "../../../../kiwi/lib/format/quantity";
import type { CatDish, CatMeal } from "../cat-q0/catalogDb";
import type { Edit, IngFields } from "./edits";
import { fixProse, PROSE_DECIMAL } from "./prose";

// kiwi/ loads as CommonJS under tsx: the named exports sit on default.
type Q = { displayedQuantity: (q: number, u: string) => number; formatNeedGlyph: (q: number) => string };
const Qx: Q = (clientQuantity as unknown as Partial<Q>).displayedQuantity ? (clientQuantity as unknown as Q) : (clientQuantity as unknown as { default: Q }).default;

export type BRule = "garlic_clove" | "spoon_eighth" | "prose_decimal" | "prose_eighth" | "swap_self";
export interface BSkip { mealId: string; dish: string; rule: BRule; detail: string }

const SPOON_OR_CUP = /^(teaspoons?|tsp|tablespoons?|tbsp|cups?)$/i;
const EIGHTHS = [3 / 8, 5 / 8, 7 / 8];

const fieldsOf = (i: CatDish["ingredients"][number]): IngFields => ({ quantity: i.quantity, unit: i.unit, name: i.name, preparationNote: i.preparationNote, isOptional: i.isOptional });

export function partBEdits(m: CatMeal): { edits: Edit[]; skips: BSkip[] } {
  const edits: Edit[] = [];
  const skips: BSkip[] = [];
  for (const d of m.dishes) {
    const base = { source: "B" as const, dishId: d.dishId, dishTitle: d.title, answers: [] as number[] };
    for (const i of d.ingredients) {
      if (!i.id) throw new Error("partB: ingredient rows need ids (catalogDb ≥ CAT-Q1)");
      const unit = i.unit.trim();
      const clone = { name: i.name, quantity: i.quantity, unit: i.unit };
      // fixUnit's test is /\bgarlic\b/ anywhere in the name, so it also turned "1 each
      // frozen garlic bread" into "1 clove frozen garlic bread" (applied on production
      // in follow-up A). Garlic only when garlic IS the thing: the name's last word.
      const isGarlic = /\b(garlic|cloves?)$/i.test(i.name.replace(/\([^)]*\)/g, " ").replace(/[^a-z\s]/gi, " ").trim());
      if (isGarlic && fixUnit(clone) && clone.unit === "clove" && !/\bcloves?\b/i.test(i.name)) {
        // Follow-up B: a note that says cloves does NOT make the line read right — the
        // screen counts the name ("4 each garlic (cloves, minced)" prints "4 garlics
        // (cloves, minced)"). Unit clove, and the note loses the word the unit now
        // says: "4 cloves garlic (minced)". A note that COUNTS cloves ("about 10
        // cloves") is a whole head counted "each" — reported, not edited.
        const note = i.preparationNote ?? "";
        if (/\d+\s*(?:-|–|to)?\s*\d*\s*cloves?\b/i.test(note)) {
          skips.push({ mealId: m.id, dish: d.title, rule: "garlic_clove", detail: `"${i.quantity} ${i.unit} ${i.name} (${note})" — the note counts cloves, so "each" may mean a head; left` });
          continue;
        }
        const cleaned = note.replace(/\bcloves?\b\s*,?\s*/gi, "").replace(/^[\s,;]+|[\s,;]+$/g, "").replace(/\s{2,}/g, " ");
        edits.push({ ...base, kind: "ingredient", rule: "garlic_clove", lineId: i.id, old: fieldsOf(i), new: { ...fieldsOf(i), unit: "clove", preparationNote: i.preparationNote == null ? null : cleaned || null } });
        continue;
      }
      const shown = Qx.displayedQuantity(i.quantity, unit);
      if (SPOON_OR_CUP.test(unit) && EIGHTHS.some((f) => Math.abs(shown - Math.floor(shown) - f) < 1e-6)) {
        const q = snapToCookFraction(i.quantity);
        if (q > 0) edits.push({ ...base, kind: "ingredient", rule: "spoon_eighth", lineId: i.id, old: fieldsOf(i), new: { ...fieldsOf(i), quantity: q } });
      }
    }
    for (const s of d.allSteps) {
      if (!s.id) throw new Error("partB: step rows need ids (catalogDb ≥ CAT-Q1)");
      const f = fixProse(s.text);
      for (const l of f.left) skips.push({ mealId: m.id, dish: d.title, rule: "prose_decimal", detail: `step ${s.stepIndex}: "${l}" — not a cook's fraction; left for Part C` });
      if (f.text !== s.text) {
        const rule = new RegExp(PROSE_DECIMAL.source, "i").test(s.text) ? "prose_decimal" : "prose_eighth";
        edits.push({ ...base, kind: "step", rule, stepId: s.id, stepIndex: s.stepIndex, old: { text: s.text, minutes: s.estimatedMinutes }, new: { text: f.text, minutes: s.estimatedMinutes } });
      }
    }
    for (const sub of d.substitutions) {
      const why = swapProblem(sub);
      if (!why) continue;
      // The component(s) this swap stands for: scratch lines it replaces.
      const keys = new Set(d.ingredients.filter((i) => i.pathKey === "scratch" && i.componentKey && sub.replaces.some((r) => swapKey(r) === swapKey(i.name))).map((i) => i.componentKey!));
      const bought = [...d.allSteps, ...d.ingredients].filter((x) => x.pathKey === "bought" && (keys.size === 0 || keys.has(x.componentKey ?? "")));
      if (bought.length) {
        skips.push({ mealId: m.id, dish: d.title, rule: "swap_self", detail: `${why} — ${bought.length} bought-path row(s)${keys.size ? ` on component ${[...keys].join(",")}` : " (component unknown)"}; removing the path is a structure change, not done` });
        continue;
      }
      edits.push({ ...base, kind: "swap_remove", rule: "swap_self", old: sub, new: null });
    }
  }
  return { edits, skips };
}
