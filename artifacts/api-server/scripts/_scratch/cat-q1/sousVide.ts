// CAT-Q1 — the sous vide call under D-WS9-315 (chat-Claude's, §1): a sous vide
// recipe that states a bath temperature and a hold time meeting the USDA
// time-and-temperature table for that temperature is NOT a doneness block; its
// fix is one added sentence saying the hold time is what makes it safe.
//
// ⚠️ THE TABLES BELOW WERE TRANSCRIBED FROM MEMORY of the FSIS lethality tables
// (poultry: the 7-log Salmonella table, the 12%-fat chicken column — the
// longest; meat: Appendix A's 7-log beef/pork table). The values at 1-minute
// granularity may be off by a few percent; verify against the FSIS PDF before
// any sous vide patch is applied. Hold times are AT core temperature: the
// table says nothing about come-up time, so `withComeUp` adds a conservative
// 60 minutes for a piece up to ~1 inch thick and the report prints both.
//
// Pure. Reads the dish's own step text; nothing else.
import type { CatDish } from "../cat-q0/catalogDb";

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
  /** The longest duration stated in a bath step (the hold the cook is told). */
  holdMinutes: number;
  /** FSIS minutes at core temperature for bathF (null: below the table — never safe). */
  tableMinutes: number | null;
  meets: boolean;
  /** meets with COME_UP_MINUTES added — the conservative reading. */
  meetsWithComeUp: boolean;
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

/** Null when the dish is not sous vide or states no bath temperature / hold. */
export function checkSousVide(d: Pick<CatDish, "title" | "steps" | "ingredients">): SousVideCheck | null {
  const bath = d.steps.filter((s) => SOUS_VIDE.test(s.text));
  if (!bath.length) return null;
  const names = `${d.title} ${d.ingredients.map((i) => i.name).join(" ")}`;
  const protein: Protein | null = /\b(chicken|turkey|duck|poultry|hen)\b/i.test(names) ? "poultry" : /\b(pork|beef|lamb|veal)\b/i.test(names) ? "meat" : null;
  if (!protein) return null;
  const temps = bath.flatMap((s) => [...s.text.matchAll(TEMP_F)].map((m) => Number(m[1]))).filter((t) => t >= 120 && t <= 190);
  const holds = bath.flatMap((s) => durationsIn(s.text));
  if (!temps.length || !holds.length) return null;
  const bathF = Math.min(...temps);
  const holdMinutes = Math.max(...holds);
  const tm = tableMinutes(protein, bathF);
  return {
    protein, bathF, holdMinutes, tableMinutes: tm,
    meets: tm !== null && holdMinutes >= tm,
    meetsWithComeUp: tm !== null && holdMinutes >= tm + COME_UP_MINUTES,
    steps: bath.map((s) => s.stepIndex),
  };
}

/** The sentence the ruling adds (the editor is told to write it; the gate looks for it). */
export const SAFETY_SENTENCE = /\b(hold(?:ing)?|time)\b[^.]*\bwhat makes\b[^.]*\bsafe\b/i;
