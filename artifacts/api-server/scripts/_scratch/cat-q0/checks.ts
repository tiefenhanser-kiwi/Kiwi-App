// CAT-Q0 Pass 1 — the deterministic checks, one stored catalog meal at a time.
// Pure: no I/O. Every finding names its class (the CAT-Q0 §1 numbering, or
// "info" for a stored oddity the screen hides), the dish, the ingredient or
// step, and a short quote.
//
// REUSED, not copied:
//   thx2Checks.fixUnit / swapProblem — the generator's own unit and swap rules
//     (fixUnit runs on a CLONE here: it mutates);
//   thx2Core.pathFlags — the path-completeness check;
//   prepMoments.proseNames + thx2Core.mentionWord — the repo's "does this prose
//     name this ingredient" matchers, used only as fallbacks after identity
//     (a default-path step's amountRefs carrying the ingredientId);
//   kiwi/lib/format/quantity.displayedQuantity — the number the member screen
//     prints, so a stored 0.33 cup (shown ⅓) is not reported as a decimal;
//   the default path comes in already selected (catalogDb → selectDefaultPathSteps).

import { proseNames } from "../../../src/lib/prepMoments";
import { fixUnit, swapProblem } from "../../thx2/thx2Checks";
import { mentionWord, pathFlags } from "../../thx2/thx2Core";
// The client's own rounding (pure, no imports): what a cook actually sees.
import * as clientQuantity from "../../../../kiwi/lib/format/quantity";
// kiwi/ has no "type": "module", so tsx loads it as CommonJS: the export sits on default.
const displayedQuantity: (qty: number, unit: string) => number =
  (clientQuantity as unknown as { displayedQuantity?: (qty: number, unit: string) => number }).displayedQuantity ?? (clientQuantity as unknown as { default: { displayedQuantity: (q: number, u: string) => number } }).default.displayedQuantity;
import type { CatDish, CatIngredient, CatMeal, CatStep } from "./catalogDb";

export type CheckCode =
  | "swap_self"
  | "path_unused"
  | "ing_unused"
  | "ing_unused_elsewhere"
  | "ing_unlisted"
  | "ing_unlisted_pantry"
  | "unit_shows_zero"
  | "unit_decimal"
  | "unit_odd"
  | "prose_decimal"
  | "rinse_poultry"
  | "doneness_missing"
  | "doneness_missing_moist"
  | "doneness_low"
  | "time_ratio"
  | "step_minutes_vs_prose"
  | "step_long"
  | "no_steps"
  | "unit_tiny_tsp_hidden"
  | "unit_decimal_hidden"
  | "unit_garlic_each_hidden"
  | "unit_garlic_count"
  | "unit_alias";

export const CLASS_OF: Record<CheckCode, number | "style" | "info"> = {
  swap_self: 6,
  path_unused: 2, ing_unused: 2, ing_unused_elsewhere: 2, ing_unlisted: 2, ing_unlisted_pantry: 2,
  unit_shows_zero: 3, unit_decimal: 3, unit_odd: 3, prose_decimal: 3,
  rinse_poultry: 5, doneness_missing: 5, doneness_missing_moist: 5, doneness_low: 5,
  time_ratio: 7, step_minutes_vs_prose: 7,
  step_long: "style",
  no_steps: 1,
  unit_tiny_tsp_hidden: "info", unit_decimal_hidden: "info", unit_garlic_each_hidden: "info", unit_alias: "info",
  unit_garlic_count: 3,
};

export const DESCRIBE: Record<CheckCode, string> = {
  swap_self: "a swap that is not a shortcut (thx2Checks.swapProblem)",
  path_unused: "an ingredient used on one path only (thx2Core.pathFlags; the NON-default path's leftovers)",
  ing_unused: "listed, never referenced on the default path (amountRefs identity, then prose)",
  ing_unused_elsewhere: "listed in this dish, referenced only in another dish's steps",
  ing_unlisted: "a catalog ingredient named in a default-path step that no dish of the meal lists",
  ing_unlisted_pantry: "as ing_unlisted, for salt / pepper / oil / sugar / flour / butter",
  unit_shows_zero: "a spoon/cup amount the screen prints as 0.00 (under 1/16)",
  unit_decimal: "a spoon/cup amount the screen prints as an eighth no spoon measures (⅜ ⅝ ⅞), or a weight/count with no cook's fraction",
  unit_odd: "a unit outside the catalog's unit vocabulary",
  prose_decimal: "a decimal spoon or cup amount in step text",
  rinse_poultry: "rinsing raw poultry",
  doneness_missing: "raw poultry or ground meat, fast heat, no internal temperature stated",
  doneness_missing_moist: "raw poultry or ground meat, simmered/braised ≥ 25 min, no internal temperature stated",
  doneness_low: "an internal temperature below 165°F (poultry) / 160°F (ground meat)",
  time_ratio: "derived total > 3× or < ⅓ of the summed default-path step minutes",
  step_minutes_vs_prose: "a step's prose states a duration its minutes do not carry (< half)",
  step_long: "a step over 300 characters",
  no_steps: "a dish with no stored steps",
  unit_tiny_tsp_hidden: "stored < ⅛ tsp that the screen still prints as ⅛ (fixUnit would make it a pinch)",
  unit_decimal_hidden: "stored off-fraction (0.33) that the screen rounds to a glyph",
  unit_garlic_each_hidden: "garlic cloves stored as \"each\" — the screen drops \"each\" and prints \"4 garlic cloves\" (BUG-317)",
  unit_garlic_count: "garlic stored as \"each\" with no \"clove\" in the name — the screen prints \"4 garlic\" (heads or cloves?)",
  unit_alias: "a unit spelling variant (lb, tbsp, cups, cloves)",
};

export interface Finding {
  code: CheckCode;
  mealId: string;
  mealTitle: string;
  dish: string;
  where: string; // "ing: <name>" | "step <i>" | "meal" | "dish"
  detail: string;
}

// ── shared vocab ────────────────────────────────────────────────────────────

const KNOWN_UNITS = new Set([
  "teaspoon", "tablespoon", "cup", "ounce", "pound", "each", "clove", "sprig", "slice", "head", "stalk", "can", "bunch",
  "inch", "fluid ounce", "quart", "leaf", "pinch", "pint", "gram", "packet", "strip", "jar", "sheet", "loaf",
]);
const ALIAS_UNITS = new Set(["lb", "lbs", "tbsp", "tsp", "oz", "cups", "cloves", "stalks", "cans", "inches", "teaspoons", "tablespoons", "ounces", "pounds", "slices", "sprigs"]);
const SPOON_OR_CUP = /^(teaspoons?|tsp|tablespoons?|tbsp|cups?)$/i;
const TEASPOON = /^(teaspoons?|tsp)$/i;
const WEIGHT_OR_COUNT = /^(ounce|pound|each|slice|can|head|bunch|stalk)$/i;

const POULTRY = /\b(chicken|turkey|duck|hen|hens|poultry|quail|goose)\b/i;
/** Not a raw bird to cook: already cooked, cured, a liquid, a fat or a seasoning. */
const NOT_RAW = /\b(broth|stock|bouillon|base|gravy|cooked|rotisserie|leftover|deli|smoked|sausages?|bacon|pepperoni|jerky|fat|schmaltz|seasoning|stuffing|mix|meatballs|soup|condensed|canned)\b/i;
const GROUND = /\bground\s+(beef|pork|lamb|veal|turkey|chicken|meat|bison|sirloin|chuck)\b|\b(hamburger|burger\s+patt(y|ies))\b/i;
const NOT_GROUND_MEAT = /\b(cooked|seasoning|spice|pepper|cinnamon|cumin|ginger|coriander|mustard|cloves?|nutmeg|flax|almonds?)\b/i;
const TEMP = /(\d{2,3})\s*(?:°\s*|degrees?\s*)F\b/gi;
const DONENESS_WORDS = /\b(internal|thermometer|registers?|reads?|reaches?|thickest|instant-read|doneness)\b/i;
const MOIST_HEAT = /\b(simmer\w*|brais\w*|slow[- ]cook\w*|pressure[- ]cook\w*|instant pot|stew\w*|poach\w*|boil\w*)\b/i;
// Rinsing a bird, said either way round. Not "rinse the rice … chicken broth".
const RINSE_BIRD = /\brins\w*\s+(?:(?:the|off|and|pat|dry|whole|raw|bone-in|skin-on|boneless|skinless|of|it|them|under|cold|water|inside|out)\s+)*(?:chicken|turkey|duck|hens?|poultry|bird|giblets|thighs|breasts|drumsticks|wings|quail)\b(?!\s+(?:broth|stock|bouillon))|\b(?:chicken|turkey|duck|hens?|poultry|bird|thighs|breasts|drumsticks|wings)\b(?!\s+(?:broth|stock|bouillon))[^.;,]{0,30}\brins(?:e|ed|ing)\b/i;

const lc = (s: string) => s.toLowerCase();
const quote = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);

function namesOf(i: CatIngredient): string[] {
  return [i.name, i.canonicalName, ...i.aliases].filter(Boolean);
}

function wordIn(text: string, word: string): boolean {
  if (!word || word.length < 3) return false;
  const stem = word.replace(/(es|s)$/, "");
  return new RegExp(`\\b(${word}|${stem}|${stem}s|${stem}es)\\b`, "i").test(text);
}

/** Identity first (amountRefs), then the repo's prose matcher, then the head noun. */
function stepNames(step: CatStep, i: CatIngredient): "ref" | "prose" | "head" | null {
  if (step.amountRefs.some((r) => r.ingredientId === i.ingredientId)) return "ref";
  if (namesOf(i).some((n) => proseNames(step.text, n))) return "prose";
  if (namesOf(i).some((n) => wordIn(step.text, mentionWord(n)))) return "head";
  // the first identifying word ("chicken" for "boneless skinless chicken breasts")
  if (namesOf(i).some((n) => { const w = coreWords(n)[0]; return !!w && w.length >= 4 && wordIn(step.text, w); })) return "head";
  return null;
}

/** Ingredients the default path uses: base + scratch, plus bought where its component has no scratch. */
function defaultPathIngredients(d: CatDish): CatIngredient[] {
  const scratchComponents = new Set(d.ingredients.filter((i) => i.pathKey === "scratch" && i.componentKey).map((i) => i.componentKey));
  return d.ingredients.filter((i) => i.pathKey !== "bought" || !i.componentKey || !scratchComponents.has(i.componentKey));
}

// ── the unlisted-ingredient vocabulary (built once from the catalog's own rows) ──

export interface VocabEntry { ingredientId: string; display: string; re: RegExp; core: string[]; pantry: boolean }
export interface Vocab { entries: VocabEntry[] }

const STEM = (w: string) => (w.length > 4 && w.endsWith("oes") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const VOCAB_SKIP = new Set(["water", "ice", "ice water", "boiling water", "hot water", "warm water", "cold water", "cooking spray", "nonstick cooking spray", "ice cubes"]);
/** Words that never decide WHICH ingredient it is — prep, part, size, colour. A
 *  vocabulary name is "covered" by the meal when its remaining core words all
 *  appear in some listed name (so "grated parmesan" and "lime wedges" are). */
const COVER_NOISE = new Set([
  "fresh", "large", "small", "medium", "whole", "kosher", "freshly", "ground", "extra", "virgin", "extra-virgin", "cold", "warm", "hot",
  "boneless", "skinless", "low-sodium", "unsalted", "salted", "grated", "shredded", "sliced", "diced", "minced", "chopped", "crushed",
  "toasted", "roasted", "cooked", "dried", "frozen", "canned", "wedge", "clove", "leave", "leaf", "sprig", "stalk", "floret", "juice",
  "zest", "piece", "chunk", "thinly", "finely", "torn", "baby", "ripe", "yellow", "white", "red", "green", "purple", "plain", "pure",
  "packed", "light", "dark", "sweet", "flat-leaf", "italian", "for", "serving", "garnish", "optional", "and", "the", "with",
]);
const PANTRY_WORDS = new Set(["salt", "sea", "flaky", "table", "pepper", "black", "coarsely", "peppercorn", "oil", "olive", "vegetable", "canola", "neutral", "sugar", "granulated", "flour", "all-purpose", "all", "purpose", "butter"]);
const PANTRY = /^(kosher salt|salt|sea salt|flaky sea salt|table salt|black pepper|ground black pepper|freshly ground black pepper|pepper|olive oil|extra-virgin olive oil|extra virgin olive oil|vegetable oil|canola oil|neutral oil|sugar|granulated sugar|all-purpose flour|flour|butter|unsalted butter)$/i;

const coreWords = (s: string) => lc(s).replace(/\([^)]*\)/g, " ").replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 2).map(STEM).filter((w) => !COVER_NOISE.has(w));

/**
 * Ingredient rows used in at least `minDishes` catalog dishes, by canonicalName.
 * The match is the WHOLE canonical phrase, whole-word, last word's plural
 * optional, and never followed by a word that makes it a different ingredient
 * ("garlic powder" never fires "garlic"; "hot sauce" needs "hot sauce").
 */
export function buildVocab(meals: CatMeal[], minDishes = 5): Vocab {
  const uses = new Map<string, { id: string; dishes: Set<string> }>();
  for (const m of meals) for (const d of m.dishes) for (const i of d.ingredients) {
    const e = uses.get(i.canonicalName) ?? { id: i.ingredientId, dishes: new Set() };
    e.dishes.add(d.dishId);
    uses.set(i.canonicalName, e);
  }
  const entries: VocabEntry[] = [];
  for (const [canon, e] of uses) {
    if (e.dishes.size < minDishes || VOCAB_SKIP.has(canon)) continue;
    const core = coreWords(canon);
    if (core.length === 0) continue;
    const words = lc(canon).replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9\s-]/g, " ").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const last = words.length - 1;
    const phrase = words.map((w, i) => { const esc = (i === last ? STEM(w) : w).replace(/[-]/g, "[- ]"); return i === last ? `${esc}(?:e?s)?` : esc; }).join("\\s+");
    entries.push({
      ingredientId: e.id, display: canon, core, pantry: PANTRY.test(canon) || core.every((w) => PANTRY_WORDS.has(w)),
      re: new RegExp(`\\b${phrase}\\b(?!\\s+(?:powder|salt|flakes|paste|extract|seeds?|sauce|oil|juice|zest|stock|broth|vinegar|water|leaves|cream|cheese|milk|butter|mix|seasoning|syrup))`, "i"),
    });
  }
  // Longest first, so "chicken thighs" claims a span before "chicken" would.
  entries.sort((a, b) => b.display.length - a.display.length);
  return { entries };
}

// ── the checks ──────────────────────────────────────────────────────────────

export function checkMeal(m: CatMeal, vocab: Vocab): Finding[] {
  const out: Finding[] = [];
  const add = (code: CheckCode, dish: string, where: string, detail: string) => out.push({ code, mealId: m.id, mealTitle: m.title, dish, where, detail });

  // Meal-level: everything listed anywhere (any dish, any path, any swap product).
  const listedIds = new Set(m.dishes.flatMap((d) => d.ingredients.map((i) => i.ingredientId)));
  const listedWords = new Set(m.dishes.flatMap((d) => [...d.ingredients.flatMap((i) => namesOf(i).flatMap(coreWords)), ...d.substitutions.flatMap((s) => coreWords(s.product))]));

  for (const p of pathFlags(m.dishes.map((d) => ({ title: d.title, ingredients: d.ingredients, substitutions: d.substitutions, steps: d.allSteps })))) {
    add("path_unused", p.detail.split(":")[0], "path", p.detail);
  }

  let stepMinutes = 0;
  for (const d of m.dishes) {
    if (d.allSteps.length === 0) add("no_steps", d.title, "dish", "the dish has no stored steps");

    for (const s of d.substitutions) {
      const why = swapProblem(s);
      if (why) add("swap_self", d.title, `swap: ${s.product}`, why);
    }

    for (const i of d.ingredients) {
      const unit = i.unit.trim();
      const shown = displayedQuantity(i.quantity, unit);
      const frac = shown - Math.floor(shown);
      const clone = { name: i.name, quantity: i.quantity, unit: i.unit };
      const fixed = fixUnit(clone);
      if (SPOON_OR_CUP.test(unit) && shown === 0) {
        add("unit_shows_zero", d.title, `ing: ${i.name}`, `${i.quantity} ${unit} ${i.name} — the screen prints 0.00`);
      } else if (SPOON_OR_CUP.test(unit) && [3 / 8, 5 / 8, 7 / 8].some((f) => Math.abs(frac - f) < 1e-6)) {
        add("unit_decimal", d.title, `ing: ${i.name}`, `${i.quantity} ${unit} ${i.name} — the screen prints an eighth no spoon measures (${shown})`);
      } else if (fixed) {
        const code: CheckCode = clone.unit === "clove" ? (/\bcloves?\b/i.test(i.name) ? "unit_garlic_each_hidden" : "unit_garlic_count") : clone.unit === "pinch" && TEASPOON.test(unit) ? "unit_tiny_tsp_hidden" : "unit_decimal_hidden";
        add(code, d.title, `ing: ${i.name}`, fixed);
      }
      if (WEIGHT_OR_COUNT.test(unit) && unit !== "each" && Math.abs(i.quantity * 4 - Math.round(i.quantity * 4)) > 1e-6 && Math.abs(i.quantity * 3 - Math.round(i.quantity * 3)) > 0.02) {
        add("unit_decimal", d.title, `ing: ${i.name}`, `${i.quantity} ${unit} ${i.name} — no cook's fraction (the screen prints ${shown})`);
      }
      if (ALIAS_UNITS.has(lc(unit))) add("unit_alias", d.title, `ing: ${i.name}`, `unit "${unit}"`);
      else if (!KNOWN_UNITS.has(lc(unit))) add("unit_odd", d.title, `ing: ${i.name}`, `unit "${unit}" (${i.quantity} ${unit} ${i.name})`);
    }

    const path = d.steps;
    stepMinutes += path.reduce((a, s) => a + s.estimatedMinutes, 0);
    if (path.length > 0) {
      for (const i of defaultPathIngredients(d)) {
        if (i.fromLeftovers) continue;
        if (path.some((s) => stepNames(s, i))) continue;
        const elsewhere = m.dishes.filter((o) => o !== d && o.steps.some((s) => stepNames(s, i))).map((o) => o.title);
        if (elsewhere.length) add("ing_unused_elsewhere", d.title, `ing: ${i.name}`, `${i.quantity} ${i.unit} ${i.name}${i.isOptional ? " (optional)" : ""} — not in this dish's steps; named in: ${elsewhere.join(", ")}`);
        else add("ing_unused", d.title, `ing: ${i.name}`, `${i.quantity} ${i.unit} ${i.name}${i.isOptional ? " (optional)" : ""} — no default-path step references it`);
      }
    }

    const rawPoultry = d.ingredients.filter((i) => POULTRY.test(i.name) && !NOT_RAW.test(i.name) && !/\bground\b/i.test(i.name));
    const ground = d.ingredients.filter((i) => GROUND.test(i.name) && !NOT_GROUND_MEAT.test(i.name));
    const temps: Array<{ t: number; step: CatStep }> = [];
    for (const s of path) {
      const claimed: Array<[number, number]> = [];
      for (const v of vocab.entries) {
        if (listedIds.has(v.ingredientId)) continue;
        const hit = v.re.exec(s.text);
        if (!hit) continue;
        const span: [number, number] = [hit.index, hit.index + hit[0].length];
        if (claimed.some(([a, b]) => span[0] < b && a < span[1])) continue;
        claimed.push(span);
        if (v.core.every((w) => listedWords.has(w))) continue;
        add(v.pantry ? "ing_unlisted_pantry" : "ing_unlisted", d.title, `step ${s.stepIndex}`, `"${hit[0]}" (${v.display}) — no dish lists it — ${quote(s.text, 110)}`);
      }

      if (s.text.length > 300) add("step_long", d.title, `step ${s.stepIndex}`, `${s.text.length} chars — ${quote(s.text, 80)}`);
      // Spoon and cup units only: a decimal ounce is a package size ("14.5 oz diced tomatoes").
      const dec = s.text.match(/(?<![\d-])\d*\.\d+[- ]?(cups?|teaspoons?|tsp|tablespoons?|tbsp)\b/i);
      if (dec) add("prose_decimal", d.title, `step ${s.stepIndex}`, `"${dec[0]}" — ${quote(s.text, 100)}`);

      const rinse = s.text.match(RINSE_BIRD);
      if (rinse && !/\b(don'?t|do not|no need to|never|without)\s+rins/i.test(s.text)) add("rinse_poultry", d.title, `step ${s.stepIndex}`, `"${rinse[0]}" — ${quote(s.text, 120)}`);

      TEMP.lastIndex = 0;
      for (const mt of s.text.matchAll(TEMP)) {
        const t = Number(mt[1]);
        if (t >= 100 && t <= 212 && DONENESS_WORDS.test(s.text)) temps.push({ t, step: s });
      }

      // The prose states a duration the step does not carry. "up to N" is a
      // hold window, not a duration, so it is dropped; a range reads its LOW end.
      const prose = s.text.replace(/\bup to\s+\d+(?:\s*(?:-|–|to)\s*\d+)?\s*(?:minutes?|mins?|hours?|hrs?|days?)/gi, "");
      const durs = [...prose.matchAll(/\b(\d+)(?:\s*(?:-|–|to)\s*\d+)?\s*(minutes?|mins?|hours?|hrs?)\b/gi)].map((x) => Number(x[1]) * (/^h/i.test(x[2]) ? 60 : 1));
      const overnight = /\bovernight\b(?!-)/i.test(prose) ? 480 : 0; // not "the overnight-soaked beans"
      const said = Math.max(0, overnight, ...durs);
      if (said >= 10 && s.estimatedMinutes < said * 0.5) add("step_minutes_vs_prose", d.title, `step ${s.stepIndex}`, `prose says ${said} min, the step carries ${s.estimatedMinutes} — ${quote(s.text, 100)}`);
    }

    if ((rawPoultry.length || ground.length) && path.some((s) => s.phaseType === "cook")) {
      const need = rawPoultry.length ? 165 : 160;
      const kind = rawPoultry.length ? "raw poultry" : "ground meat";
      const names = (rawPoultry.length ? rawPoultry : ground).map((i) => i.name).join(", ");
      if (temps.length === 0) {
        const moist = path.some((s) => s.phaseType === "cook" && MOIST_HEAT.test(s.text) && s.estimatedMinutes >= 25);
        add(moist ? "doneness_missing_moist" : "doneness_missing", d.title, "dish", `${kind} (${names}) — no step states an internal temperature`);
      }
      for (const x of temps.filter((y) => y.t < need && y.t >= 120)) add("doneness_low", d.title, `step ${x.step.stepIndex}`, `${x.t}°F stated for ${kind} (${names}; needs ${need}°F) — ${quote(x.step.text, 100)}`);
    }
  }

  const total = m.derived.totalMinutes;
  if (total != null && stepMinutes > 0 && (total > 3 * stepMinutes || total < stepMinutes / 3)) {
    add("time_ratio", "meal", "meal", `derived total ${total} min vs summed default-path steps ${stepMinutes} min (×${(total / stepMinutes).toFixed(2)})`);
  }
  return out;
}
