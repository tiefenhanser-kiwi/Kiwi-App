// [grocery] B2 · Part A2 — THE SHADOW, rebuilt for H1–H7. READ-ONLY.
//
// A throwaway copy of what Part C would make the real functions do. Part C
// changes the real code and this file stops mattering.
//
// WHAT IS REUSED RATHER THAN REBUILT, and it is still most of it:
//   • the CLUSTER VETO — folds are handed to the SHIPPED buildRelationIndex as
//     synonym-shaped rows, so NEVER_FOLD_PAIRS and the whole-cluster refusal
//     apply with no second implementation.
//   • the fold, the merge, the ladder, the rounding, the pack resolution — the
//     real consolidatePlanIngredients / generateFinalGroceryList are CALLED,
//     not imitated. Part A's preview imitated the first half and skipped the
//     second, which is why its BEFORE printed "1 head Garlic (25 cloves)"
//     where B1's Part E printed "3 heads".
//   • the Instacart search term — instacartSearchName already strips pack
//     prefixes, parentheticals and prep clauses.
//
// WHAT IS NEW: the fold is now CONDITIONAL on what the plan demanded (H3), so
// the index cannot be built once for the catalog — it is built per plan.

import {
  buildRelationIndex,
  type RelationIndex,
  type RelationRow,
} from "../../src/lib/ingredientRelations";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import {
  classifyEdge,
  lowercaseLead,
  packUnitCarriesShares,
  distinguishingTokens,
  NAME_CLEANINGS,
  RULED_DEFAULTS,
} from "./proposals";

export interface SubsumesEdge {
  generic: string;
  specific: string;
}

// ---------------------------------------------------------------------------
// THE PER-PLAN INDEX
// ---------------------------------------------------------------------------

export interface FoldDecision {
  /** the name the line takes */
  target: string;
  /** the names folded into it */
  members: string[];
  rule: "H2" | "H3" | "GENERIC";
  why: string;
}

export interface PlanIndex {
  index: RelationIndex;
  decisions: FoldDecision[];
  /** normalized group key -> the varieties whose share the line must state */
  ridersByKey: Map<string, string[]>;
  vetoed: string[];
  /** H3 folds refused because the generic is sold by weight or volume (H5). */
  h5Refusals: string[];
  /** H3 folds refused because no recipe demanded the generic. */
  h3Refusals: string[];
}

export interface PlanIndexInput {
  realRows: RelationRow[];
  liveEdges: SubsumesEdge[];
  /** normalized canonical names this plan actually demands */
  demanded: Set<string>;
  /** canonicalName -> Ingredient.purchaseUnit, for H5 */
  packUnitOf: Map<string, string | null>;
  /** generics whose H3 fold this pass must NOT make (the collapse fallback) */
  suppressH3?: Set<string>;
}

/**
 * Build the fold map for ONE plan.
 *
 *   GENERIC  always folds — the "specific" is a hedge, not a product.
 *   H2       the generic folds onto its ruled default, always.
 *   H3       the specifics fold onto the generic ONLY IF a recipe demanded the
 *            generic itself AND the generic's pack is a countable whole (H5).
 *   H1       never folds.
 */
export function buildPlanIndex(input: PlanIndexInput): PlanIndex {
  const { realRows, liveEdges, demanded, packUnitOf } = input;
  const suppressH3 = input.suppressH3 ?? new Set<string>();

  const synthetic: RelationRow[] = [];
  const decisions: FoldDecision[] = [];
  const ridersByKey = new Map<string, string[]>();
  const h5Refusals: string[] = [];
  const h3Refusals: string[] = [];
  const pinned = new Map<string, string>(); // member -> the name the line takes

  const addFold = (target: string, member: string, rule: FoldDecision["rule"], why: string) => {
    synthetic.push({
      label: "synonym",
      fromCanonicalName: target,
      toCanonicalName: member,
      yieldQuantity: null,
      yieldUnit: null,
      coHarvestable: null,
      // The admission gate ran when the live edge set was selected. `reviewed`
      // says what is true: a human ruled the CLASS these edges belong to.
      confidence: "high",
      reviewedByHuman: true,
      fromDefaultUnit: "each",
    });
    pinned.set(normalizeIngredientName(member), normalizeIngredientName(target));
    pinned.set(normalizeIngredientName(target), normalizeIngredientName(target));
    decisions.push({ target, members: [member], rule, why });
  };

  // ── H2 — the defaults. The GENERIC joins the DEFAULT and is named as it. ──
  const defaultOf = new Map(RULED_DEFAULTS.map((d) => [d.generic, d.def as string]));
  for (const [generic, def] of defaultOf) {
    if (!demanded.has(normalizeIngredientName(generic))) continue;
    addFold(def, generic, "H2", `H2 — "${generic}" has the ruled default "${def}"`);
  }

  // ── GENERIC and H3 ────────────────────────────────────────────────────────
  const bySpecific = new Map<string, SubsumesEdge[]>();
  for (const e of liveEdges) {
    const k = normalizeIngredientName(e.specific);
    let a = bySpecific.get(k);
    if (!a) { a = []; bySpecific.set(k, a); }
    a.push(e);
  }

  for (const [, edges] of bySpecific) {
    for (const e of edges) {
      const g = normalizeIngredientName(e.generic);
      const s = normalizeIngredientName(e.specific);
      const r = classifyEdge(e.generic, e.specific);
      if (r.hClass === "H1") continue;

      if (r.hClass === "GENERIC") {
        // Unconditional: the hedge is stripped whether or not the generic was
        // demanded, because there is no second product to keep apart.
        if (defaultOf.has(e.generic)) continue; // H2 already moved the generic
        addFold(e.generic, e.specific, "GENERIC", r.why);
        continue;
      }

      // H3 — three gates, in order, each with its own refusal line.
      if (!demanded.has(s)) continue; // the specific is not on this list at all
      if (!demanded.has(g)) {
        h3Refusals.push(`${e.generic} ⊇ ${e.specific} — no recipe demanded "${e.generic}", so H1 stands`);
        continue;
      }
      if (suppressH3.has(g)) {
        h3Refusals.push(`${e.generic} ⊇ ${e.specific} — the shares already account for the whole count, so there is nothing generic left to choose`);
        continue;
      }
      if (!packUnitCarriesShares(packUnitOf.get(e.generic) ?? null)) {
        h5Refusals.push(`${e.generic} ⊇ ${e.specific} — "${e.generic}" is sold by ${packUnitOf.get(e.generic) ?? "no stated pack"} (H5: no shares on a weight or volume)`);
        continue;
      }
      addFold(e.generic, e.specific, "H3", r.why);
      const key = normalizeIngredientName(e.generic);
      let a = ridersByKey.get(key);
      if (!a) { a = []; ridersByKey.set(key, a); }
      if (!a.includes(s)) a.push(s);
    }
  }

  const index = buildRelationIndex([...realRows, ...synthetic]);

  // ── PIN THE REPRESENTATIVE ────────────────────────────────────────────────
  //
  // buildRelationIndex picks the SHORTEST member name. H2 and H3 both name the
  // line explicitly — the default, or the generic — and neither is reliably the
  // shortest ("bone-in chicken thighs" is longer than "chicken thighs", and H2
  // says the DEFAULT wins). So the key is remapped to the pinned name.
  const remap = new Map<string, string>();
  for (const c of index.clusters) {
    const target = c.members.map((m) => pinned.get(m)).find((t) => t !== undefined);
    if (target && target !== c.representative) remap.set(c.representative, target);
  }
  const baseGroupKey = index.groupKey;
  const groupKey = (raw: string): string => {
    const k = baseGroupKey(raw);
    return remap.get(k) ?? k;
  };

  const wrapped: RelationIndex = {
    ...index,
    groupKey,
    synonymFold: (n: string) => {
      const f = index.synonymFold(n);
      return remap.get(f) ?? f;
    },
  };

  // rekey the riders through the wrapped key
  const rekeyed = new Map<string, string[]>();
  for (const [k, v] of ridersByKey) rekeyed.set(groupKey(k), v);

  return {
    index: wrapped,
    decisions,
    ridersByKey: rekeyed,
    vetoed: index.declined
      .filter((d) => d.reason === "never-fold-ruling" && d.detail)
      .map((d) => d.detail as string),
    h5Refusals,
    h3Refusals,
  };
}

// ---------------------------------------------------------------------------
// H3's RIDER — "at least 2 red", in whole units of the line's buy unit.
// ---------------------------------------------------------------------------

/**
 * H3, verbatim: "Shares are whole units of the line's buy unit (each, bunch,
 * can), the variety's own need rounded up. Never a measure."
 *
 * The variety's own need rounded up in its own pack unit is a number the
 * pipeline ALREADY computes — it is `purchaseQuantity` on the row that variety
 * produces when it stands alone. So the BEFORE pass is the share table, and
 * nothing here re-derives a pack count.
 */
/**
 * "THE WHOLE COUNT", as the shopper reads it: the number the composed line
 * opens with.
 *
 * H3 talks about counts the line states — "5 bell peppers, at least 2 red" —
 * not about packs. The first cut used the variety's PACK COUNT and printed
 * "at least 1 green" for a demand of two green peppers, because the catalog
 * sells them two to a pack. The printed leading number is the quantity H3 is
 * about, and taking it from the rendered line needs no unit algebra at all.
 */
export function leadingCount(line: string): number | null {
  const m = line.match(/^\s*~?(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

export function riderText(generic: string, variety: string, shareCount: number): string {
  const n = Math.max(1, Math.ceil(shareCount));
  // Hans's own example names the DISTINGUISHING WORD, not the whole canonical:
  // "5 bell peppers, at least 2 red and at least 2 yellow" — not "at least 2 red
  // bell pepper". The generic is already the subject of the line.
  const words = distinguishingTokens(generic, variety);
  return `at least ${n} ${words.length > 0 ? words.join(" ") : variety}`;
}

/** The go-ahead's Gate 2: an "at least" may never be followed by a measure. */
const MEASURE_WORDS =
  /\b(cup|cups|tbsp|tablespoon|tablespoons|tsp|teaspoon|teaspoons|oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|ml|l|liter|litre|fl\s?oz|pint|quart|gallon)\b/i;

export function atLeastUsesMeasure(line: string): boolean {
  const m = /at least\s+([^;)]*)/gi;
  let hit: RegExpExecArray | null;
  while ((hit = m.exec(line)) !== null) {
    if (MEASURE_WORDS.test(hit[1])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// R7 + BUG-323 — the NAME the row carries.
// ---------------------------------------------------------------------------

const cleaningByCurrent = new Map(NAME_CLEANINGS.map((c) => [c.current, c]));

/**
 * ⚠️ `hasCatalogRow` is not a convenience. BUG-323 is a CATALOG data fix — it
 * rewrites `Ingredient.displayName` — so a row with no ingredientId never picks
 * it up. That is exactly the recurring synthetics, which this block must leave
 * byte-identical for B3.
 */
export function shadowDisplayName(
  canonicalName: string,
  displayName: string,
  hasCatalogRow: boolean,
): string {
  if (!hasCatalogRow) return displayName;
  const cleaned = cleaningByCurrent.get(canonicalName.toLowerCase().trim());
  if (cleaned) return cleaned.line;
  return lowercaseLead(displayName);
}

/**
 * 🔴 R7 DOES NOT MOVE THE CANONICAL NAME. `Ingredient.canonicalName` is
 * `@unique` — eighteen spellings of neutral oil cannot all become "vegetable
 * oil" — and it is the GROUP KEY, so renaming it breaks the folds. R7 is a
 * DISPLAY change. (Part A's own dry run proved the second half by printing two
 * lines that both read "chicken thighs".)
 */
export function shadowCanonicalName(canonicalName: string): string {
  return canonicalName;
}

// ---------------------------------------------------------------------------
// BUG-160 — the containment rule. Two rules, not one.
// ---------------------------------------------------------------------------

function stemWord(w: string): string {
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}
const stemAll = (s: string) => s.toLowerCase().split(/[\s,]+/).filter(Boolean).map(stemWord);

function containsSeq(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

export type ContainmentVerdict =
  | { kind: "none" }
  | { kind: "drop-name" }
  | { kind: "name-absorbs" };

/**
 * The shipped test (residueNamesItem, artifacts/kiwi/lib/format/grocery.ts:149)
 * is EQUALITY plus two plurals; the shipped Instacart test (humanLine,
 * instacartPayload.ts:159) adds `residue.endsWith(" " + name)`. Neither catches
 * the census's three shapes — and a single symmetric "either contains the
 * other" predicate is WRONG, which a dry run proved by turning "3 Bell peppers"
 * into "3 ". The direction decides the repair:
 *
 *   residue ⊇ name      -> DROP THE NAME     "3 medium white onion"
 *   name OPENS with it  -> COUNT + NAME      "1 rotisserie chicken, meat shredded"
 *   anything else       -> LEAVE IT ALONE
 */
export function containmentVerdict(residue: string, name: string): ContainmentVerdict {
  const r = stemAll(residue);
  const n = stemAll(name);
  if (r.length === 0 || n.length === 0) return { kind: "none" };
  if (containsSeq(r, n)) return { kind: "drop-name" };
  if (n.length > r.length && containsSeq(n.slice(0, r.length), r)) return { kind: "name-absorbs" };
  return { kind: "none" };
}

/** The pack minus its leading count — the client's own packResidue. */
export function packResidue(purchaseDisplay: string): string {
  return purchaseDisplay.replace(/^\s*~?\d+(?:[./]\d+)?\s+/, "").trim();
}
