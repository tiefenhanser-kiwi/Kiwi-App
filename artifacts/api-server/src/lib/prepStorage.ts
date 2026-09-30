// WS9 BUG-338 / D-WS9-298 — STORAGE, AND THE COOK DAY.
//
// Pure, I/O-free, deterministic. Everything here is computed at ASSEMBLY and
// RENDER, on every read, and none of it is cached or sent to the model.
//
// ── WHY THE MODEL NO LONGER WRITES STORAGE TEXT ─────────────────────────────
//
// The census (P-R3) found 57 storage windows that expire before their own cook
// day across 7 of 13 plans, 15 of them raw flesh, max lag 5 days. The cause was
// structural: `loadPrepWeekInput` read no date field at all, so every "up to 2
// days" was a guess by a model that could not know when the meal was cooked.
//
// The fix is not a better prompt. A shelf life is a FACT about a food, the cook
// day is a FACT about the plan, and comparing two facts is arithmetic. The model
// writes the instruction; the code writes how long it keeps.
//
// ⚠️ THE OVERLAY MUST BE APPLIED ON THE CACHE-HIT PATH TOO. `PrepWeekStructure`
// holds the ASSEMBLED result, and these notes depend on the day. A hit that
// returns `structureJson` untouched serves yesterday's dates. Cache what the AI
// wrote; apply this on every read. See `applyStorageOverlay`.

import type { PrepWeekResult } from "./ai/schemas/prepWeek";

/** How long a food class keeps once prepped, in days. Room-temp classes noted. */
export interface StorageClass {
  key: string;
  /** Days in the fridge, unless `roomTemp`. */
  days: number;
  roomTemp?: boolean;
  /** The sentence the step shows. */
  note: string;
  /** Matched against the ingredient names the step covers. */
  match: RegExp;
}

// ── THE TABLE ───────────────────────────────────────────────────────────────
//
// Ordered: the FIRST match wins, so the specific classes come before the general
// ones. Every window is the conservative end of the usual range — a note that
// says 3 days for something that keeps 5 wastes a little food; the other
// direction makes someone ill.
export const STORAGE_TABLE: readonly StorageClass[] = [
  // ── the P1 class: raw flesh ───────────────────────────────────────────────
  {
    key: "raw-fish",
    days: 2,
    note: "Covered in the fridge — cook within 2 days.",
    match: /\b(salmon|cod|halibut|tilapia|tuna|snapper|trout|bass|shrimp|prawns?|scallops?|fish|fillets?)\b/i,
  },
  {
    key: "raw-meat",
    days: 2,
    note: "Covered in the fridge — cook within 2 days.",
    match: /\b(chicken|turkey|beef|pork|lamb|veal|steak|brisket|tenderloin|sausages?|bacon|chorizo|ground (?:beef|turkey|pork|chicken|lamb)|breasts?|thighs?|drumsticks?|cutlets?|(?:pork|lamb|veal) chops?)\b/i,
  },
  // ── produce, by how fast it turns ─────────────────────────────────────────
  {
    key: "leafy-herbs",
    days: 3,
    note: "Airtight in the fridge, with a barely damp paper towel — up to 3 days.",
    match: /\b(cilantro|parsley|basil|mint|dill|tarragon|chives|scallions?|green onions?|arugula|spinach|lettuce|romaine|herbs?)\b/i,
  },
  {
    key: "citrus-juice",
    days: 3,
    note: "Small sealed jar in the fridge — up to 3 days.",
    match: /\b(lime juice|lemon juice|orange juice|grapefruit juice|citrus juice)\b/i,
  },
  {
    key: "citrus-wedges",
    days: 3,
    note: "Airtight in the fridge — up to 3 days.",
    match: /\b(wedges?|zest)\b/i,
  },
  {
    key: "cut-alliums",
    days: 4,
    note: "Airtight in the fridge — up to 4 days. It will scent the shelf; a sealed jar helps.",
    // Same trap as the chiles below, and the smoke run found it: "garlic
    // POWDER" is a dry spice and was getting the 4-day fridge note, scent-of-
    // the-shelf advice and all. Every allium here has a ground form.
    match: /\b(onions?|shallots?|garlic|leeks?|scallion)(?!\s+(?:powder|salt|granules))\b/i,
  },
  {
    key: "cut-peppers",
    days: 4,
    note: "Airtight in the fridge — up to 4 days.",
    // ⚠️ "chili" AND "pepper" ARE SPICES TOO. The first version matched `chilis?`
    // and sent "ground cumin, chili powder, spice blend" to the 4-day fridge
    // class instead of the room-temperature one — a fresh-chile pattern eating a
    // ground spice. The lookaheads exclude the ground forms; a fresh chile keeps
    // its short window.
    match: /\b(?:peppers?(?!\s+(?:powder|flakes))|chil[ei]s?(?!\s+(?:powder|flakes))|jalapeños?|jalapenos?|serranos?|poblanos?|tomatillos?|tomatoes?|cucumbers?|celery|carrots?|radishes?|cabbage|broccoli|cauliflower|zucchini|squash|green beans?|asparagus|mushrooms?)\b/i,
  },
  // ── made things ───────────────────────────────────────────────────────────
  {
    key: "cooked-grains",
    days: 4,
    note: "Airtight in the fridge — up to 4 days.",
    match: /\b(rice|quinoa|couscous|farro|barley|orzo|pasta|noodles?|grains?)\b/i,
  },
  {
    key: "sauces-dressings",
    days: 5,
    note: "Sealed jar in the fridge — up to 5 days. Shake or stir before using.",
    match: /\b(sauce|dressing|vinaigrette|marinade|glaze|crema|aioli|remoulade|pesto|chimichurri|tzatziki|salsa|relish|chutney)\b/i,
  },
  {
    key: "spice-blend",
    days: 7,
    roomTemp: true,
    note: "Small airtight container at room temperature — it keeps for weeks.",
    match: /\b(spice blend|seasoning|rub|blend|spices?)\b/i,
  },
];

/** The fallback when nothing matches: the shortest produce window. */
export const DEFAULT_STORAGE: StorageClass = {
  key: "default",
  days: 3,
  note: "Airtight in the fridge — up to 3 days.",
  match: /(?:)/,
};

/** The classes D-WS9-298 treats as the P1 (raw flesh) class. */
const P1_KEYS = new Set(["raw-fish", "raw-meat"]);

/** First match wins. `text` is the step's ingredient names and prep notes. */
export function storageClassFor(text: string): StorageClass {
  for (const c of STORAGE_TABLE) if (c.match.test(text)) return c;
  return DEFAULT_STORAGE;
}

export const isP1Class = (c: StorageClass) => P1_KEYS.has(c.key);

// ── the proteins phase ──────────────────────────────────────────────────────

/**
 * D-WS9-298 item 3 — shown on the Proteins phase ALWAYS, in the quiet
 * storage-note tier. No alert, no modal: it explains why the phase is short.
 */
export const PROTEINS_PHASE_NOTE =
  "Fish, poultry and meat keep about two days once handled, so this phase only preps what you'll cook soon.";

/** D-WS9-298 item 2 — what happens to one raw-flesh step, given its lag. */
export type ProteinVerdict =
  | { kind: "keep"; note: string }
  | { kind: "demote"; note: string }
  | { kind: "unknown-day"; note: string };

/**
 * ⚠️ `daysUntilCook` IS THE WHOLE INPUT, and `undefined` is not zero. A plan with
 * no day assignment (4 of the 13 census plans) genuinely does not know, and
 * saying "cook within 2 days" to someone whose meal is on Saturday is the defect
 * this rule exists to remove. The unknown case gets its own sentence.
 */
export function judgeProteinStep(daysUntilCook: number | undefined): ProteinVerdict {
  if (daysUntilCook === undefined) {
    return {
      kind: "unknown-day",
      note:
        "Raw fish, poultry and meat keep about 2 days once handled — prep this the day before you cook, or leave it for cook day.",
    };
  }
  if (daysUntilCook <= 2) {
    return { kind: "keep", note: "Covered in the fridge — cook within 2 days." };
  }
  return {
    kind: "demote",
    note: `This one is ${daysUntilCook} days out — leave it for cook day.`,
  };
}

/**
 * D-WS9-298 item 2 / D-WS9-297 ruling 11 — a demoted step's title names the
 * THING, never the action it forbids. "Halve the baby yellow potatoes" over
 * "keep them whole until cook day" is two lines arguing with each other.
 *
 * Derived from the step's ingredient names rather than rewriting the model's
 * title, because the model's title is an imperative by construction.
 */
export function nounFormTitle(ingredientNames: string[]): string {
  const names = [...new Set(ingredientNames.map((n) => n.trim()).filter(Boolean))];
  if (names.length === 0) return "Cook day";
  const head = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  // Sentence case on the first letter only; catalog names are already lowercase
  // except for proper nouns, which must keep their capitals.
  return `${head.charAt(0).toUpperCase()}${head.slice(1)} — cook day`;
}

// ── THE OVERLAY ─────────────────────────────────────────────────────────────

/** What the overlay needs about one planned step, by stepKey. */
export interface StorageContext {
  /** Days from the prep session to the LATEST meal this step feeds. */
  daysUntilCook?: number;
  /** The phase the step sits in — proteins has its own rules. */
  phase: string;
  /** The ingredient names and prep notes the step covers, for the table. */
  text: string;
  /** Ingredient names, for the noun-form title of a demoted step. */
  ingredientNames: string[];
}

/**
 * D-WS9-298 — rewrite every storage note, demote the proteins that will not
 * keep, and add the Proteins phase line.
 *
 * 🔴 CALLED ON EVERY READ, INCLUDING A CACHE HIT. The cached blob is the
 * assembled result and these notes depend on the DAY, so a hit that returned
 * `structureJson` untouched would serve the dates the plan had when it was
 * generated. Cache what the AI wrote; compute this fresh.
 *
 * 🔴 THE MODEL'S OWN `storageNote` IS DISCARDED, not merged. It was a guess by
 * something that could not see a date (57 windows expired before their own
 * cook day across the census). Keeping it as a fallback would leave exactly
 * the wrong answers in place on exactly the steps the table does not cover.
 */
export function applyStorageOverlay(
  result: PrepWeekResult,
  contextByStepKey: ReadonlyMap<string, StorageContext>,
): PrepWeekResult {
  return {
    ...result,
    phases: result.phases.map((phase) => ({
      ...phase,
      // Item 3 — always, on Proteins, whatever the phase contains.
      ...(phase.phase === "proteins" ? { note: PROTEINS_PHASE_NOTE } : {}),
      steps: phase.steps.map((step) => {
        const ctx = contextByStepKey.get(step.stepKey);
        if (!ctx) {
          // No context means the step plan does not know this key — drop the
          // model's note rather than keep an unverifiable one.
          const { storageNote: _drop, ...rest } = step;
          return rest;
        }
        if (ctx.phase === "proteins") {
          const verdict = judgeProteinStep(ctx.daysUntilCook);
          if (verdict.kind === "demote") {
            return {
              ...step,
              title: nounFormTitle(ctx.ingredientNames),
              storageNote: verdict.note,
              skipSuggested: true,
            };
          }
          return { ...step, storageNote: verdict.note };
        }
        return { ...step, storageNote: storageClassFor(ctx.text).note };
      }),
    })),
  };
}