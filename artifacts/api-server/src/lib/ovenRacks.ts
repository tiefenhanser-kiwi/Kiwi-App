// THX-3d round 4 (BUG-496) — WHAT A DISH TAKES UP IN THE OVEN, IN RACKS.
//
// Measured on production's five feasts (as release #4 left them): Classic put the bird
// and three 9×13 casseroles in at once (2.5 racks), Small the breast, two 9×13s and a
// sheet pan (3), New Twist the spatchcock and four sheet pans of potatoes beside a 9×13
// (5.5 at its own 10 servings), Vegetarian the Wellington beside two pans of sprouts (3).
// A home oven has two racks. The rule (chat-Claude, round 4):
//
//   • a rimmed sheet pan takes a rack; a 9×13 / casserole / baking dish / pie plate half
//     of one (two side by side); a Dutch oven, loaf pan or 8×8 half; the bird's pan a
//     rack (the scheduler's, by kind — not here); an unknown vessel half;
//   • the vessel is the one the dish's own steps name last up to its first oven step on
//     the day (the 9×13 is often named on a make-ahead day: "transfer to a buttered
//     9×13-inch baking dish, cover tightly with foil, and refrigerate overnight");
//   • the COUNT scales with the quantity, never the recipe's literal: sheet pans =
//     ceil(pounds of the roasted food / 2), at least one (recipeRules: a rimmed sheet pan
//     roasts about 2 lb in one layer); a dish the recipe names at its authored servings
//     scales with the servings (its cups are what the 9×13 was written to hold).
//
// Pure. The callers (Cook Mode, the stamp, the patch) read a dish's steps, rows and
// servings and hand the scheduler the number on SchedulerDish.ovenRacks.
import { isOvenStep, isReheatStep, type SchedulerPhase } from "./cookingScheduler";

export type OvenVessel = "sheet" | "dish" | "half" | "unknown";

const SHEET = /\b(?:rimmed\s+)?(?:sheet\s+pans?|baking\s+sheets?)\b/gi;
const DISH = /\b(?:9\s*[x×]\s*13(?:-inch)?(?:\s+(?:baking|casserole))?\s+(?:dish|pan)|casserole\s+dish|baking\s+dish|gratin\s+dish|pie\s+(?:plate|dish|pan)s?)\b/gi;
const HALF = /\b(?:dutch\s+oven|loaf\s+pan|8\s*[x×]\s*8(?:-inch)?(?:\s+baking)?\s+(?:dish|pan)|oven-?safe\s+skillet|cast[- ]iron\s+skillet)\b/gi;
const COUNT_WORD: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, both: 2, three: 3, four: 4 };
const COUNT_BEFORE = /\b(a|an|one|two|both|three|four)\s+(?:[\w-]+\s+){0,3}$/i;

/** The vessel the dish's text names last, and how many of it ("two rimmed sheet pans" → 2). */
export function ovenVesselOf(texts: readonly string[]): { vessel: OvenVessel; named: number } {
  let out: { vessel: OvenVessel; named: number; at: number } = { vessel: "unknown", named: 1, at: -1 };
  texts.forEach((t, i) => {
    for (const [vessel, re] of [["sheet", SHEET], ["dish", DISH], ["half", HALF]] as const) {
      for (const m of t.matchAll(re)) {
        const pos = i * 100_000 + (m.index ?? 0);
        if (pos < out.at) continue;
        const n = COUNT_BEFORE.exec(t.slice(Math.max(0, (m.index ?? 0) - 40), m.index))?.[1]?.toLowerCase();
        // "the two oiled sheet pans" names the count again; "the sheet pan" keeps the one named before.
        const named = n ? COUNT_WORD[n] : out.vessel === vessel ? out.named : /s$/i.test(m[0]) ? 2 : 1;
        out = { vessel, named, at: pos };
      }
    }
  });
  return { vessel: out.vessel, named: out.named };
}

const POUNDS: Record<string, number> = {
  pound: 1, pounds: 1, lb: 1, lbs: 1,
  ounce: 1 / 16, ounces: 1 / 16, oz: 1 / 16,
  gram: 1 / 453.6, grams: 1 / 453.6, g: 1 / 453.6,
  kilogram: 2.2046, kilograms: 2.2046, kg: 2.2046,
};

/** Pounds of the food a pan roasts: the dish's weighed rows, the small ones (the cheese, the herbs) left out. */
export function roastedPounds(rows: readonly { quantity: number; unit: string }[], factor = 1): number {
  const w = rows.map((r) => (POUNDS[r.unit.trim().toLowerCase()] ?? 0) * r.quantity * factor).filter((x) => x > 0);
  if (w.length === 0) return 0;
  const top = Math.max(...w);
  return w.filter((x) => x >= top / 4).reduce((a, b) => a + b, 0);
}

/** Sheet pans for this many pounds: about 2 lb a pan in one layer, at least one. */
export function sheetPanCount(pounds: number): number {
  return Math.max(1, Math.ceil(pounds / 2 - 1e-9));
}

export interface DishOvenRacks {
  vessel: OvenVessel;
  /** Pans (or dishes) at these servings. */
  count: number;
  /** The racks they take: a sheet pan 1, a dish ½. */
  racks: number;
}

/** A dish's footprint from the texts that name its vessel, its rows and its servings factor. */
export function dishOvenRacks(texts: readonly string[], rows: readonly { quantity: number; unit: string }[], factor = 1): DishOvenRacks {
  const { vessel, named } = ovenVesselOf(texts);
  if (vessel === "sheet") {
    const lb = roastedPounds(rows, factor);
    const count = lb > 0 ? sheetPanCount(lb) : Math.max(1, Math.ceil(named * factor - 1e-9));
    return { vessel, count, racks: count };
  }
  if (vessel === "unknown") return { vessel, count: 1, racks: 0.5 };
  const count = Math.max(1, Math.ceil(named * factor - 1e-9));
  return { vessel, count, racks: count / 2 };
}

/**
 * A feast dish's racks, from all its steps (every day's, in step order) and the steps it
 * cooks on the day: the vessel named last up to its first oven step on the day. Null when
 * the dish puts nothing in the oven on the day.
 */
export function feastDishOvenRacks(
  allSteps: readonly { stepIndex: number; text: string }[],
  daySteps: readonly { stepIndex: number; text: string; phaseType: string }[],
  rows: readonly { quantity: number; unit: string }[],
  servings: { servingsDefault: number; authoredServingsDefault: number | null },
): DishOvenRacks | null {
  const first = daySteps.find((s) => s.phaseType !== "preheat" && isOvenStep({ phaseType: s.phaseType as SchedulerPhase, text: s.text }) && !isReheatStep({ text: s.text }));
  if (!first) return null;
  const texts = [...allSteps].sort((a, b) => a.stepIndex - b.stepIndex).filter((s) => s.stepIndex <= first.stepIndex).map((s) => s.text);
  const authored = servings.authoredServingsDefault ?? servings.servingsDefault;
  const factor = authored > 0 ? servings.servingsDefault / authored : 1;
  return dishOvenRacks(texts, rows, factor);
}

const COUNT_WORDS = ["", "one", "two", "three", "four", "five", "six"];

/**
 * THX-3d round 4 (A1) — a step's sheet-pan count corrected to `count` ("Line two rimmed
 * sheet pans" for 1¼ lb → "Line a rimmed sheet pan"). Only the count named before the
 * vessel, and the vessel's own number; null when the text names no count or already
 * names this one.
 */
export function withSheetPanCount(text: string, count: number): string | null {
  let changed = false;
  const out = text.replace(/\b(the\s+)?(a|an|one|two|three|four|both)\s+((?:[\w-]+\s+){0,3}?)(sheet\s+pans?|baking\s+sheets?)\b/gi, (all, the: string | undefined, n: string, mid: string, noun: string) => {
    const had = COUNT_WORD[n.toLowerCase()];
    if (had === count) return all;
    changed = true;
    const singular = noun.replace(/s$/i, "");
    const plural = /s$/i.test(noun) ? noun : `${noun}s`;
    if (count === 1) return the ? `${the}${mid}${singular}` : `${/^[aeiou]/i.test(mid || singular) ? "an" : "a"} ${mid}${singular}`;
    const word = COUNT_WORDS[count] ?? String(count);
    return `${the ?? ""}${/^[A-Z]/.test(n) ? word[0].toUpperCase() + word.slice(1) : word} ${mid}${plural}`;
  });
  return changed ? out : null;
}
