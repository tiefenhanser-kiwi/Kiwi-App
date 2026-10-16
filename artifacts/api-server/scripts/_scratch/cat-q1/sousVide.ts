// CAT-Q1 — the sous vide call under D-WS9-315, as refined in follow-up B: a
// sous vide poultry or meat step is safe as written only when its stated time
// covers BOTH the come-up (COME_UP_MINUTES, for a piece up to about 1½ inches
// thick, from the fridge) AND the FSIS hold at that bath temperature. Then its
// fix is one added sentence saying the full time is what makes it safe. When
// it falls short, the fix lengthens the time to the next half hour that passes
// (`passingMinutes`) and then adds the sentence. The gate re-checks the final
// time in code (`sousVideFailures`) and rejects a patch that leaves one short.
//
// The tables: FSIS, "Appendix A: Compliance Guidelines for Meeting Lethality
// Performance Standards for Certain Meat and Poultry Products" (7-log
// Salmonella). Poultry is the chicken 12%-fat column (the longest); meat is the
// beef/pork table. Hold times are AT core temperature. Transcribed in CAT-Q1;
// chat-Claude spot-checked them against the published figures (poultry ≈10 min
// at 145°F and 27–35 min at 140°F; meat ≈12 min at 140°F).
//
// Pure. Reads the dish's own step text; nothing else.
import type { CatDish, CatMeal } from "../cat-q0/catalogDb";

/** °F → minutes held at core temperature. */
export const FSIS_POULTRY: Record<number, number> = {
  136: 81.4, 137: 64.6, 138: 51.4, 139: 40.9, 140: 32.6, 141: 25.9, 142: 20.6, 143: 16.4, 144: 13.0, 145: 10.4,
  146: 8.3, 147: 6.6, 148: 5.2, 149: 4.2, 150: 3.3, 151: 2.7, 152: 2.1, 153: 1.7, 154: 1.3, 155: 1.1,
  156: 0.9, 157: 0.7, 158: 0.6, 159: 0.5, 160: 0.4, 161: 0.3, 162: 0.3, 163: 0.2, 164: 0.2, 165: 0,
};
export const FSIS_MEAT: Record<number, number> = {
  130: 121, 131: 97, 132: 77, 133: 62, 134: 47, 135: 37, 136: 32, 137: 24, 138: 19, 139: 15, 140: 12,
  141: 10, 142: 8, 143: 6, 144: 5, 145: 4, 146: 3, 147: 2.2, 148: 1.4, 149: 1, 150: 0.7, 155: 0.2, 160: 0,
};
/** From the fridge to core temperature, a piece up to about 1½ inches thick. */
export const COME_UP_MINUTES = 60;

const SOUS_VIDE = /\b(sous[- ]vide|circulator|water bath)\b/i;
const TEMP_F = /(\d{3})\s*°?\s*F\b/g;
/** "1 hour 30 minutes", "1½ hours", "90 minutes", "1 to 4 hours" (the low end). */
function durationsIn(text: string): number[] {
  const out: number[] = [];
  const t = text.replace(/½/g, ".5");
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:(?:-|–|to)\s*\d+(?:\.\d+)?\s*)?(hours?|hrs?)(?:\s*(?:and\s*)?(\d+)\s*(?:minutes?|mins?))?/gi)) out.push(Number(m[1]) * 60 + (m[3] ? Number(m[3]) : 0));
  for (const m of t.matchAll(/(?<!hours?\s*(?:and\s*)?)(?<![\d.])(\d+)\s*(?:(?:-|–|to)\s*\d+\s*)?(?:minutes?|mins?)\b/gi)) out.push(Number(m[1]));
  return out;
}

export type Protein = "poultry" | "meat";
export interface SousVideCheck {
  protein: Protein;
  bathF: number;
  /** The longest duration stated in a bath step (the time the cook is told). */
  holdMinutes: number;
  /** FSIS minutes at core temperature for bathF (null: below the table — never safe). */
  tableMinutes: number | null;
  /** COME_UP_MINUTES + tableMinutes: what the stated time must cover. */
  requiredMinutes: number | null;
  /** THE RULE: the stated time covers come-up plus the FSIS hold. */
  meets: boolean;
  /** The stated time covers the FSIS hold alone (shown, never decisive). */
  meetsAtCore: boolean;
  /** The next half hour at or above requiredMinutes (null: below the table). */
  passingMinutes: number | null;
  /** The bath step that states holdMinutes (the one whose time and minutes a fix changes). */
  holdStep: number;
  steps: number[];
}

export function tableMinutes(protein: Protein, f: number): number | null {
  const t = protein === "poultry" ? FSIS_POULTRY : FSIS_MEAT;
  const keys = Object.keys(t).map(Number).sort((a, b) => a - b);
  if (f < keys[0]) return null;
  // the nearest tabulated temperature at or BELOW f (the longer time)
  const k = keys.filter((x) => x <= f).pop()!;
  return t[k];
}

/** 120 → "2 hours", 90 → "1 hour 30 minutes", 30 → "30 minutes". */
export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60), r = m % 60;
  return [h ? `${h} hour${h > 1 ? "s" : ""}` : "", r ? `${r} minutes` : ""].filter(Boolean).join(" ");
}

/** Null when the dish is not sous vide poultry/meat or states no bath temperature / time. */
export function checkSousVide(d: Pick<CatDish, "title" | "steps" | "ingredients">): SousVideCheck | null {
  const bath = d.steps.filter((s) => SOUS_VIDE.test(s.text));
  if (!bath.length) return null;
  const names = `${d.title} ${d.ingredients.map((i) => i.name).join(" ")}`;
  const protein: Protein | null = /\b(chicken|turkey|duck|poultry|hen)\b/i.test(names) ? "poultry" : /\b(pork|beef|lamb|veal)\b/i.test(names) ? "meat" : null;
  if (!protein) return null;
  const temps = bath.flatMap((s) => [...s.text.matchAll(TEMP_F)].map((m) => Number(m[1]))).filter((t) => t >= 120 && t <= 190);
  const holds = bath.flatMap((s) => durationsIn(s.text).map((m) => ({ m, step: s.stepIndex })));
  if (!temps.length || !holds.length) return null;
  const bathF = Math.min(...temps);
  const longest = holds.reduce((a, b) => (b.m > a.m ? b : a));
  const holdMinutes = longest.m;
  const tm = tableMinutes(protein, bathF);
  const required = tm === null ? null : COME_UP_MINUTES + tm;
  return {
    protein, bathF, holdMinutes, tableMinutes: tm, requiredMinutes: required,
    meets: required !== null && holdMinutes >= required,
    meetsAtCore: tm !== null && holdMinutes >= tm,
    passingMinutes: required === null ? null : Math.ceil(required / 30) * 30,
    holdStep: longest.step,
    steps: bath.map((s) => s.stepIndex),
  };
}

/** Every sous vide poultry/meat dish of the meal whose stated time is short — the gate's reasons. */
export function sousVideFailures(m: Pick<CatMeal, "dishes">): string[] {
  const out: string[] = [];
  for (const d of m.dishes) {
    const c = checkSousVide(d);
    if (!c || c.meets) continue;
    out.push(c.tableMinutes === null
      ? `sous vide ${d.title}: ${c.bathF}°F is below the FSIS table for ${c.protein} — no hold time makes it safe`
      : `sous vide ${d.title}: ${c.bathF}°F for ${c.holdMinutes} min is short of ${COME_UP_MINUTES} min come-up + ${c.tableMinutes} min FSIS hold (${c.requiredMinutes!.toFixed(1)} min; next half hour ${c.passingMinutes} min)`);
  }
  return out;
}

/** The sentence the ruling adds (the editor is told to write it; the gate looks for it). */
export const SAFETY_SENTENCE = /\b(hold(?:ing)?|time)\b[^.]*\bwhat makes\b[^.]*\bsafe\b/i;
