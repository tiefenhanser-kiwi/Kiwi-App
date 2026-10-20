// THX-2G follow-up C — the deterministic checks on a GENERATED meal, run through
// runStoreFill's `postGenerate` hook: after the completeness gate, before the
// substitution sanitize and the finalize call, so the steps are written from
// what survives. Pure; every rule has a test (thx2Checks.test.ts).
//
// Two kinds of edit, both reported per meal:
//   swap_dropped — a substitution that is not a shortcut:
//     • the product names the same thing it replaces ("store-bought refrigerated
//       pie crust" for "refrigerated pie crust");
//     • a bought broth or stock for a bought broth or stock. Hans: store-bought
//       stock IS a shortcut for stock the recipe MAKES ("getting turkey stock
//       from the store would be a shortcut to making your own") — a replaced
//       neck-and-giblets list keeps its swap; only bought-for-bought goes.
//   unit_fixed — garlic counted "each" → "clove"; a teaspoon amount under ⅛ →
//     "1 pinch"; a spoon or cup amount whose fraction is no cook's fraction
//     (0.06, 0.33) snapped to the nearest one, so nothing prints as a decimal.

import type { WizardExpandEnrichedMealDetails, WizardFinalizeStepsResult } from "../../src/lib/ai/schemas/wizard";
import { mentionWord, nameKey, usesIngredient } from "./thx2Core";

export interface CheckNote {
  dish: string;
  kind: "swap_dropped" | "unit_fixed" | "minutes_capped" | "replaces_extended" | "replaces_unmapped" | "keeps_fixed" | "thursday_added";
  detail: string;
}

// ── swaps ───────────────────────────────────────────────────────────────────

const NOISE = /\b(store[- ]bought|refrigerated|carton|cartons|low[- ]sodium|reduced[- ]sodium)\b/g;

const singular = (w: string) =>
  w.length > 3 && /(ches|shes|sses|xes|oes)$/.test(w) ? w.slice(0, -2)
  : w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y`
  : w.length > 2 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1)
  : w;

/** The name with packaging words, parentheticals, punctuation and plurals gone. */
export function swapKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(NOISE, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

const BROTH = /\b(broth|stock)s?\b/i;
const MADE = /\bhomemade\b/i;

/** Why a substitution is not a shortcut, or null when it is one. */
export function swapProblem(sub: { product: string; replaces: string[] }): string | null {
  const p = swapKey(sub.product);
  const same = sub.replaces.find((r) => swapKey(r) === p);
  if (same) return `"${sub.product}" replaces "${same}" — the same thing`;
  if (BROTH.test(sub.product) && sub.replaces.length > 0 && sub.replaces.every((r) => BROTH.test(r) && !MADE.test(r))) {
    return `"${sub.product}" replaces store-bought ${sub.replaces.map((r) => `"${r}"`).join(", ")} — bought for bought`;
  }
  return null;
}

// ── units ───────────────────────────────────────────────────────────────────

const COOK_FRACTIONS = [0, 1 / 8, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1];
const SPOON_OR_CUP = /^(teaspoons?|tsp|tablespoons?|tbsp|cups?)$/i;
const TEASPOON = /^(teaspoons?|tsp)$/i;
const EACH = /^(each|whole|piece|pieces)$/i;
const GARLIC_NOT_CLOVES = /\b(head|heads|bulb|bulbs|powder|salt|granulated|paste|jar|jarred)\b/i;

/** The nearest cook's fraction (whole part kept). 0.06 → 0 (the pinch rule runs first). */
export function snapToCookFraction(q: number): number {
  const whole = Math.floor(q);
  const frac = q - whole;
  let best = COOK_FRACTIONS[0];
  for (const f of COOK_FRACTIONS) if (Math.abs(frac - f) < Math.abs(frac - best)) best = f;
  return whole + best;
}

/** True when q is already a whole number plus a cook's fraction. */
export function isCookFraction(q: number): boolean {
  return Math.abs(snapToCookFraction(q) - q) < 1e-6;
}

export function fixUnit(ing: { name: string; quantity: number; unit: string }): string | null {
  const before = `${ing.quantity} ${ing.unit} ${ing.name}`;
  if (/\bgarlic\b/i.test(ing.name) && EACH.test(ing.unit.trim()) && !GARLIC_NOT_CLOVES.test(ing.name)) {
    ing.unit = "clove";
    // "4 each garlic cloves" must not become "4 clove garlic cloves".
    ing.name = ing.name.replace(/\s*\bcloves?\b/i, "").replace(/\s{2,}/g, " ").trim() || "garlic";
    return `${before} → ${ing.quantity} clove ${ing.name}`;
  }
  if (TEASPOON.test(ing.unit.trim()) && ing.quantity < 1 / 8 - 1e-9) {
    ing.quantity = 1;
    ing.unit = "pinch";
    return `${before} → 1 pinch`;
  }
  if (SPOON_OR_CUP.test(ing.unit.trim()) && !isCookFraction(ing.quantity)) {
    const snapped = snapToCookFraction(ing.quantity);
    if (snapped > 0) {
      ing.quantity = snapped;
      return `${before} → ${Number(snapped.toFixed(4))} ${ing.unit}`;
    }
  }
  return null;
}

// ── follow-up F: after finalize (runStoreFill `postFinalize`) ───────────────

/** A make-ahead step that is not hands-on keeps at most this many minutes. */
export const MAKE_AHEAD_MINUTES_CAP = 15;
const MAKE_AHEAD = /^\s*make ahead \(/i;
const ON_THURSDAY = /^\s*on thursday:/i;
const HANDS_ON = new Set(["prep", "assemble"]);

/**
 * A step whose text opens "Make ahead (" keeps at most its hands-on minutes:
 * a `prep` or `assemble` step is hands-on and keeps its minutes; any other
 * phase (a simmer, a bake, a chill) is capped at MAKE_AHEAD_MINUTES_CAP. The
 * long duration stays in the text as the note. The brief says so; the model
 * still gave Classic's Tuesday stock its full 2-hour simmer, so code enforces it.
 */
export function capMakeAheadMinutes(meal: WizardExpandEnrichedMealDetails, fin: WizardFinalizeStepsResult): CheckNote[] {
  const notes: CheckNote[] = [];
  for (const entry of fin.dishSteps) {
    const dish = meal.dishes[entry.dishIndex]?.title ?? `dish ${entry.dishIndex}`;
    // The make-ahead RUN: from a step opening "Make ahead (" up to the step that
    // opens "On Thursday:". The dev re-pilot showed the model prefixing only the
    // run's first step — the stock's 2-hour simmer and the pie's 55-minute bake
    // sat unprefixed inside their runs.
    let inRun = false;
    for (const s of entry.steps) {
      if (MAKE_AHEAD.test(s.text)) inRun = true;
      else if (ON_THURSDAY.test(s.text)) inRun = false;
      if (inRun && !HANDS_ON.has(s.phaseType) && s.estimatedMinutes > MAKE_AHEAD_MINUTES_CAP) {
        notes.push({ dish, kind: "minutes_capped", detail: `${s.phaseType} ${s.estimatedMinutes} → ${MAKE_AHEAD_MINUTES_CAP} min: "${s.text.slice(0, 70)}…"` });
        s.estimatedMinutes = MAKE_AHEAD_MINUTES_CAP;
      }
    }
  }
  return notes;
}

/**
 * Shortcut paths stay complete: every ingredient used ONLY in one component's
 * scratch steps is added to that component's swap `replaces`, so the bought
 * path does not buy it (the stock's carrots and bay leaves; the stuffing's sage
 * under a seasoned mix). Uses are read with the negation-aware matcher. The
 * component → swap link is the registry entry's `order` (the finalize contract
 * writes one component per substitution, in order); a dish with exactly one
 * swap maps to it directly. Anything else is reported, not guessed.
 */
export function extendReplaces(meal: WizardExpandEnrichedMealDetails, fin: WizardFinalizeStepsResult): CheckNote[] {
  const notes: CheckNote[] = [];
  for (const entry of fin.dishSteps) {
    const dish = meal.dishes[entry.dishIndex];
    if (!dish?.substitutions?.length || !entry.steps.some((s) => s.pathKey)) continue;
    const registry = entry.components ?? [];
    const subFor = (key: string) => {
      const c = registry.find((r) => r.key === key);
      if (c && dish.substitutions![c.order]) return dish.substitutions![c.order];
      return dish.substitutions!.length === 1 ? dish.substitutions![0] : undefined;
    };
    for (const ing of dish.ingredients) {
      const w = mentionWord(ing.name);
      const where = entry.steps.filter((s) => usesIngredient(s.text, w));
      if (where.length === 0) continue;
      const keys = new Set(where.map((s) => (s.pathKey === "scratch" ? s.componentKey : null)));
      if (keys.size !== 1 || keys.has(null) || keys.has(undefined)) continue; // used in base, bought, or several components
      const key = [...keys][0] as string;
      const same = (r: string) => nameKey(r) === nameKey(ing.name);
      if (dish.substitutions.some((s) => s.replaces.some(same))) continue; // already replaced by a swap
      const sub = subFor(key);
      if (!sub) { notes.push({ dish: dish.title, kind: "replaces_unmapped", detail: `"${ing.name}" (component ${key}) — no swap to attach it to` }); continue; }
      sub.replaces.push(ing.name);
      notes.push({ dish: dish.title, kind: "replaces_extended", detail: `"${sub.product}" now also replaces "${ing.name}"` });
    }
  }
  return notes;
}

// ── THX-3 — the steps code writes (BUG-425, BUG-450), shared with patch.ts ──

/** Keep clauses the model writes: "keeps up to 7 days", "refrigerate up to 4 days", "(up to 1 day)". */
const KEEP_CLAUSE = /\b((?:keeps?|keeping|refrigerat\w*|store\w*|chill\w*)\b[^.;—]*?\bup to )(\d+|one|two|three|four|five|six|seven)( days?)\b/gi;

/**
 * 🔴 THX-3 (BUG-450) — the keep-days in a make-ahead step are the TABLE's
 * (thx2Core.keepsDaysFor), never the model's: "the sauce keeps up to 7 days"
 * becomes 4, the gravy's "refrigerate up to 4 days" 2. Text outside a keep
 * clause is untouched. Returns the text unchanged when it holds none.
 */
export function fixKeepClause(text: string, keeps: number): string {
  return text.replace(KEEP_CLAUSE, (_m, head: string) => `${head}${keeps} ${keeps === 1 ? "day" : "days"}`);
}

/**
 * THX-3 (BUG-425) — a make-ahead dish with no `On Thursday:` step never reaches
 * Thursday's Cook Mode (Classic and Vegetarian cranberry sauce, Vegetarian apple
 * pie). Code writes the serve step, by course; the model is not asked.
 */
export function thursdayServeStep(dishTitle: string, course: string | undefined): { text: string; phaseType: "assemble"; estimatedMinutes: number; isTimingSensitive: false } {
  const text = course === "course-cranberry"
    ? `On Thursday: Spoon the ${dishTitle} into a serving bowl straight from the fridge; serve chilled or at room temperature.`
    : course === "course-dessert"
      ? `On Thursday: Slice the ${dishTitle} and serve.`
      : `On Thursday: Serve the ${dishTitle}.`;
  return { text, phaseType: "assemble", estimatedMinutes: 2, isTimingSensitive: false };
}

/** True when a dish's steps already open a Thursday part. */
export function hasThursdayStep(texts: readonly string[]): boolean {
  return texts.some((t) => ON_THURSDAY.test(t));
}

/**
 * THX-3 (D-WS9-316 decision 4) — a dish whose make-ahead day MOVED (Make-Ahead's
 * gravy, Monday → Tuesday) has its "Make ahead (<Day>):" phrase rewritten to the
 * new day. Only the plain day phrase; a "(<Day> night)" brine phrase is left alone.
 */
export function retargetMakeAheadDay(text: string, fromDay: string, toDay: string): string {
  return text.replace(new RegExp(`^(\\s*Make ahead \\()${fromDay}(\\):)`, "i"), `$1${toDay}$2`);
}

/**
 * THX-3 — the generator's side of the same rules: on each make-ahead dish's
 * finalized steps, the table's keep-days and a code-written Thursday step.
 */
export function applyThx3Steps(meal: WizardExpandEnrichedMealDetails, fin: WizardFinalizeStepsResult, specFor: (title: string, index: number) => { course?: string; keeps?: number } | null): CheckNote[] {
  const notes: CheckNote[] = [];
  for (const entry of fin.dishSteps) {
    const title = meal.dishes[entry.dishIndex]?.title ?? `dish ${entry.dishIndex}`;
    const spec = specFor(title, entry.dishIndex);
    if (!spec || spec.keeps === undefined) continue;
    for (const s of entry.steps) {
      const fixed = fixKeepClause(s.text, spec.keeps);
      if (fixed !== s.text) { notes.push({ dish: title, kind: "keeps_fixed", detail: `"${s.text.slice(0, 60)}…" → keeps ${spec.keeps}` }); s.text = fixed; }
    }
    if (!hasThursdayStep(entry.steps.map((s) => s.text)) && entry.steps.length < 20) {
      const step = thursdayServeStep(title, spec.course);
      entry.steps.push(step as (typeof entry.steps)[number]);
      notes.push({ dish: title, kind: "thursday_added", detail: step.text });
    }
  }
  return notes;
}

/** The postFinalize hook: cap make-ahead minutes, then complete the swaps, then THX-3's step rules. */
export function applyPostFinalize(
  meal: WizardExpandEnrichedMealDetails,
  fin: WizardFinalizeStepsResult,
  specFor?: (title: string, index: number) => { course?: string; keeps?: number } | null,
): CheckNote[] {
  return [...capMakeAheadMinutes(meal, fin), ...extendReplaces(meal, fin), ...(specFor ? applyThx3Steps(meal, fin, specFor) : [])];
}

// ── the hook ────────────────────────────────────────────────────────────────

/** Apply every check to a generated meal IN PLACE; return what changed. */
export function applyChecks(meal: WizardExpandEnrichedMealDetails): CheckNote[] {
  const notes: CheckNote[] = [];
  for (const dish of meal.dishes) {
    if (dish.substitutions && dish.substitutions.length > 0) {
      const kept = dish.substitutions.filter((s) => {
        const why = swapProblem(s);
        if (why) notes.push({ dish: dish.title, kind: "swap_dropped", detail: why });
        return !why;
      });
      dish.substitutions = kept.length > 0 ? kept : undefined;
    }
    for (const ing of dish.ingredients) {
      const fixed = fixUnit(ing);
      if (fixed) notes.push({ dish: dish.title, kind: "unit_fixed", detail: fixed });
    }
  }
  return notes;
}
