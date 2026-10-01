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
    // `ham` was missing until BUG-340's own test asked for it: "deli ham" and
    // "smoked ham hock" fell to the 3-day default, which is the only direction
    // this table is not allowed to be wrong in. `\bham\b` cannot reach
    // "hamburger" — the boundary fails on the following letter — and the
    // dry-cured hams (prosciutto, capicola) are stripped before this runs.
    match: /\b(chicken|turkey|beef|pork|lamb|veal|steak|brisket|tenderloin|sausages?|bacon|ham|chorizo|ground (?:beef|turkey|pork|chicken|lamb)|breasts?|thighs?|drumsticks?|cutlets?|(?:pork|lamb|veal) chops?)\b/i,
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

// ── BUG-340 — SHELF-STABLE PROTEINS ─────────────────────────────────────────
//
// Anchovy paste's `Ingredient.category` is Protein, so it landed in the
// Proteins phase and a jar that keeps for months was told to cook within 2
// days. The category is not the problem to solve: grocery aisles read it, and
// D-WS9-211 already ruled it is not a usable cross-check. The form is.
//
// 🔴 AN ADJECTIVE LIST WOULD HAVE REPEATED THE "CHILI POWDER" MISTAKE TWICE
// OVER. The obvious regex is /cured|smoked|dried/ — and BACON, HAM, SMOKED
// SAUSAGE and KIELBASA are all cured or smoked and all live in the fridge. A
// dev sweep of the 59 Protein-category names carrying one of those words found
// 53 of them refrigerated. So this is a list of SHELF-STABLE FORMS, not of
// preservation adjectives: a paste, a can, a jar, something dried, and the
// dry-cured salumi that hang at room temperature. Fresh sausage, bacon, ham and
// smoked poultry are deliberately absent and must stay absent.
//
// ⚠️ TWO REGEXES FROM ONE SOURCE, ON PURPOSE. A `/g` regex carries `lastIndex`
// between calls, so `.test()` on a shared global instance answers differently
// every other time it is asked. The exported one is NOT global and is the only
// one anything calls `.test()` on; the stripper below builds its own global
// copy and `.replace()` resets it.
const SHELF_STABLE_SRC =
  "\\b(?:anchovy paste|shrimp paste|fish paste|(?:canned|tinned|jarred)\\s+\\w+" +
  "|dried (?:shrimp|anchovies|anchovy|fish|beef)" +
  "|salami|genoa salami|soppressata|capicola|coppa|bresaola|pepperoni" +
  "|prosciutto(?: di parma)?|cured chorizo|spanish cured chorizo|dry-cured \\w+|jerky)\\b";

export const SHELF_STABLE_PROTEIN = new RegExp(SHELF_STABLE_SRC, "i");
const SHELF_STABLE_ALL = new RegExp(SHELF_STABLE_SRC, "gi");

/** Remove every shelf-stable form from a contents string. */
export function stripShelfStable(text: string): string {
  return text.replace(SHELF_STABLE_ALL, " ");
}

/** BUG-340 — what a shelf-stable protein's step says instead of the 2-day line. */
export const SHELF_STABLE_STORAGE: StorageClass = {
  key: "shelf-stable",
  days: 30,
  roomTemp: true,
  note: "Shelf-stable — it keeps in its own jar or packet, so portion it whenever suits you.",
  match: /(?:)/,
};

/** The fallback when nothing matches: the shortest produce window. */
export const DEFAULT_STORAGE: StorageClass = {
  key: "default",
  days: 3,
  note: "Airtight in the fridge — up to 3 days.",
  match: /(?:)/,
};

/** The classes D-WS9-298 treats as the P1 (raw flesh) class. */
const P1_KEYS = new Set(["raw-fish", "raw-meat"]);

export const isP1Class = (c: StorageClass) => P1_KEYS.has(c.key);

/**
 * First match wins.
 *
 * ⚠️ THE BOWL NAME IS A LABEL, NOT CONTENTS, AND THE P1 CLASSES MUST NOT SEE IT.
 * Two opposite mistakes, one after the other:
 *
 *   • without the bowl name, "Loaded Vegetarian Nachos seasoning" holding cumin,
 *     chili powder and garlic powder read as loose produce, because none of
 *     those three words says "blend";
 *   • WITH it, "Sheet-Pan Chicken Fajitas seasoning bowl" — a jar of dry spices
 *     — matched the raw-meat class on the word CHICKEN and was told to cook
 *     within 2 days.
 *
 * So the label decides what KIND of mixture it is, and the contents decide
 * whether raw flesh is in the container. The raw classes read `contents` alone.
 *
 * BUG-340 — and a shelf-stable form is SUBTRACTED from the contents before any
 * of that, rather than short-circuiting it. "Anchovy paste" alone then matches
 * nothing and comes back shelf-stable; "salmon fillets and anchovy paste" still
 * matches raw-fish on what is left, which is the whole reason this is a strip
 * and not an early return. Same shape as the label split above: remove what is
 * not flesh, then ask whether flesh remains.
 */
export function storageClassFor(
  contents: string,
  bowlName = "",
  /**
   * BUG-346 (a) — THE IDENTITIES of the ingredients in the container, with no
   * preparation notes attached. The raw-flesh classes read ONLY this.
   *
   * 🔴 A FREE-TEXT NOTE IS NOT AN INGREDIENT. `"baking soda (for tenderizing
   * beef)"` matched the raw-meat class on the word BEEF, and a sauce jar holding
   * nothing but powders was told to cook within 2 days. So did `"cornstarch (for
   * velveting the chicken)"`. The note says what the powder is FOR — the dish it
   * serves, the protein it will act on — and the one thing it never says is what
   * is in the container.
   *
   * Defaults to `contents` so every existing caller keeps today's behaviour; the
   * overlay passes the real list.
   */
  ingredientNames?: readonly string[],
): StorageClass {
  const identity = ingredientNames ? ingredientNames.join(" ") : contents;
  const shelfStable = stripShelfStable(contents);
  const isShelfStable = shelfStable !== contents;
  const fleshIdentity = stripShelfStable(identity);
  const labelled = bowlName ? `${shelfStable} ${bowlName}` : shelfStable;
  for (const c of STORAGE_TABLE) {
    if (c.match.test(isP1Class(c) ? fleshIdentity : labelled)) return c;
  }
  return isShelfStable ? SHELF_STABLE_STORAGE : DEFAULT_STORAGE;
}

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
  /** The ingredient names and prep notes the step covers — the CONTENTS. */
  text: string;
  /** The bowl's name, when the step has one. A LABEL, never contents. */
  bowlName?: string;
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
        // ── D-WS9-301 H2.3 — A STEP THAT IS NOT DONE HAS NOTHING TO STORE ────
        //
        // The corpus shipped: "Pre-measuring 1½ tbsp olive oil to drizzle over
        // asparagus saves nothing — just pour it straight from the bottle when
        // you roast. Skip this one and do it at the stove. » Airtight in the
        // fridge — up to 3 days." Two sentences arguing with each other, and the
        // second one is advice about a container that will never exist.
        //
        // Applies to a step that arrives ALREADY demoted — by the narrator or by
        // the engine. The protein demotion BELOW is different: it writes "This
        // one is 4 days out — leave it for cook day" into the same field, and
        // that sentence is the reason, not a storage instruction.
        if (step.skipSuggested) {
          const { storageNote: _drop, ...rest } = step;
          return rest;
        }
        const ctx = contextByStepKey.get(step.stepKey);
        if (!ctx) {
          // No context means the step plan does not know this key — drop the
          // model's note rather than keep an unverifiable one.
          const { storageNote: _drop, ...rest } = step;
          return rest;
        }
        // BUG-340 — a shelf-stable form in the Proteins phase is not raw flesh,
        // whatever the phase says. The phase classifier below also keeps these
        // out of the phase; this is the second half of the same fix, and it is
        // the half the user is protected by: a category the catalog gets wrong
        // tomorrow must not be able to put "cook within 2 days" on a jar.
        const identityHere = ctx.ingredientNames.join(" ");
        const shelfStableHere = stripShelfStable(identityHere) !== identityHere;
        if (ctx.phase === "proteins" && !shelfStableHere) {
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
        return {
          ...step,
          // BUG-346 (a) — the identities, so a note cannot name a protein.
          storageNote: storageClassFor(ctx.text, ctx.bowlName, ctx.ingredientNames).note,
        };
      }),
    })),
  };
}