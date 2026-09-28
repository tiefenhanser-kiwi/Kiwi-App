// [grocery] B2 · Part A — THE SHADOW. READ-ONLY, WRITES NOTHING.
//
// A throwaway copy of what Part C would make the real functions do. It exists
// so Part A can show before -> after without changing anything; Part C changes
// the real code and this file stops mattering. B1's preview.ts has the same
// shape and the same disclaimer.
//
// WHAT IS REUSED RATHER THAN REBUILT, and it is most of it:
//   • the CLUSTER VETO — the subsumes edges are handed to the SHIPPED
//     buildRelationIndex as synonym-shaped rows, so NEVER_FOLD_PAIRS and the
//     whole-cluster refusal apply to them with no second implementation. That
//     is the whole reason the salt family refuses here.
//   • the fold, the merge, the ladder, the rounding — mergeConvertibleGroups
//     and roundNeedQuantity are called unchanged.
//   • the Instacart search term — instacartSearchName already strips the
//     parenthetical R5 and R7 put on the line. Nothing new.
//
// THE ONE THING THAT IS GENUINELY NEW: the representative. buildRelationIndex
// picks the SHORTEST member name; R5 says the line takes the GENERIC and never
// the specific, and those two are not the same rule. The remap below is the
// shape Part C has to add to the real index.

import {
  buildRelationIndex,
  pairKey,
  type RelationIndex,
  type RelationRow,
} from "../../src/lib/ingredientRelations";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { classifySubsumes, qualifierText, lowercaseLead, NAME_CLEANINGS } from "./proposals";

export interface SubsumesEdge {
  generic: string;
  specific: string;
}

export interface AugmentedIndex {
  index: RelationIndex;
  /** normalized group key -> the qualifier requirements folded into it */
  qualifiersByKey: Map<string, { specific: string; text: string }[]>;
  /** clusters the veto refused, for the report */
  vetoed: string[];
  /** generic names that won the representative contest away from shortest-wins */
  remapped: { from: string; to: string }[];
}

/**
 * Build the index the R5 reader needs: the real rows, PLUS every QUALIFIER or
 * GENERIC subsumes edge as a synonym-shaped row, PLUS a representative remap
 * that pins the generic.
 *
 * KEEP edges are never handed in at all — a refused fold is a fold that never
 * enters the union-find, not one that is undone afterwards.
 */
export function buildSubsumesAugmentedIndex(
  realRows: RelationRow[],
  subsumesEdges: SubsumesEdge[],
  /**
   * Fold every edge handed in, whatever its class. ONLY for the veto probe:
   * with `salt` ruled KEEP the salt family never reaches the union-find, so the
   * veto correctly reports zero refusals and proves nothing. Forcing the family
   * in is how the SHIPPED cluster veto gets shown doing its job.
   */
  forceFoldAll = false,
): AugmentedIndex {
  const folded: SubsumesEdge[] = [];
  const qualifierOf = new Map<string, string>(); // normalized specific -> qualifier text
  for (const e of subsumesEdges) {
    const r = classifySubsumes(e.generic, e.specific);
    if (!forceFoldAll && r.klass === "KEEP") continue;
    folded.push(e);
    if (r.klass === "QUALIFIER") {
      const q = qualifierText(e.generic, e.specific);
      if (q) qualifierOf.set(normalizeIngredientName(e.specific), q);
    }
  }

  const synthetic: RelationRow[] = folded.map((e) => ({
    label: "synonym",
    fromCanonicalName: e.generic,
    toCanonicalName: e.specific,
    yieldQuantity: null,
    yieldUnit: null,
    coHarvestable: null,
    // The admission gate was already applied when the live edge set was
    // selected (reviewedByHuman OR high). Marking these `high` here would hide
    // that; marking them reviewed says what is true — a human ruled the CLASS.
    confidence: "high",
    reviewedByHuman: true,
    fromDefaultUnit: "each",
  }));

  const index = buildRelationIndex([...realRows, ...synthetic]);
  // The index PRODUCTION builds today. The qualifier basis is read off THIS one
  // — see the comment on qualifiersByKey.
  const realIndex = buildRelationIndex(realRows);
  const realClusterOf = new Map<string, string[]>();
  for (const c of realIndex.clusters) for (const m of c.members) realClusterOf.set(m, c.members);

  // Which names are GENERICS (a subsumes source) and which are SPECIFICS?
  const generics = new Set(folded.map((e) => normalizeIngredientName(e.generic)));
  const specifics = new Set(folded.map((e) => normalizeIngredientName(e.specific)));

  // THE REMAP. For every cluster holding a folded subsumes pair, the
  // representative must be a generic that is nobody's specific — the TOP of the
  // subsumption chain. `shrimp -> large shrimp -> large shrimp, peeled and
  // deveined` is three deep and only `shrimp` qualifies.
  const remap = new Map<string, string>();
  const remapped: { from: string; to: string }[] = [];
  for (const c of index.clusters) {
    // ⚠️ ONLY when shortest-wins landed on a SPECIFIC. The first cut of this
    // remapped any cluster that merely CONTAINED a generic, and it renamed four
    // clusters that were already right: `parsley` became `fresh parsley`,
    // `asparagus` became `fresh asparagus`. R5's rule is "never rename the line
    // to the specific" — it is not "always rename the line to a generic".
    if (!specifics.has(c.representative)) continue;
    const tops = c.members.filter((m) => generics.has(m) && !specifics.has(m));
    if (tops.length === 0) continue;
    // deterministic: shortest, then alphabetical — the same tie-break the index
    // already uses, applied to a smaller candidate set.
    const pick = tops.reduce((best, m) =>
      m.length < best.length || (m.length === best.length && m < best) ? m : best,
    );
    if (pick !== c.representative) {
      remap.set(c.representative, pick);
      remapped.push({ from: c.representative, to: pick });
    }
  }

  const baseGroupKey = index.groupKey;
  const wrappedGroupKey = (raw: string): string => {
    const k = baseGroupKey(raw);
    return remap.get(k) ?? k;
  };

  // Qualifiers, keyed by the group the specific lands in.
  //
  // ⚠️ THE QUALIFIER'S BASIS IS THE GENERIC'S **PRE-AUGMENTATION** CLUSTER, and
  // getting this wrong is how the prompt's own example comes out wrong twice.
  //
  //   against the bare generic  -> "at least one fresh flat-leaf"
  //     `parsley` over `fresh flat-leaf parsley` adds {fresh, flat-leaf}, but
  //     `fresh parsley` is ALREADY a synonym of `parsley` at HEAD, so "fresh"
  //     distinguishes nothing.
  //   against the MERGED cluster -> no qualifier at all
  //     the merged cluster also holds `flat-leaf parsley` (a synonym of the
  //     SPECIFIC), which eats the only word that does distinguish.
  //
  // The right basis is what the line ALREADY meant before this fold: the
  // generic's own synonym cluster in the index production builds today. Digest
  // #101's "at least one flat-leaf" falls out of that.
  const qualifierBasis = new Map<string, string>(); // specific -> basis text
  for (const e of folded) {
    const spec = normalizeIngredientName(e.specific);
    const gen = normalizeIngredientName(e.generic);
    const members = realClusterOf.get(gen) ?? [gen];
    const prev = qualifierBasis.get(spec);
    qualifierBasis.set(spec, prev ? `${prev} ${members.join(" ")}` : members.join(" "));
  }

  const qualifiersByKey = new Map<string, { specific: string; text: string }[]>();
  for (const [specific] of qualifierOf) {
    const key = wrappedGroupKey(specific);
    if (key === specific) continue; // the fold was vetoed; no qualifier to render
    const text = qualifierText(qualifierBasis.get(specific) ?? key, specific);
    if (!text) continue;
    let a = qualifiersByKey.get(key);
    if (!a) { a = []; qualifiersByKey.set(key, a); }
    a.push({ specific, text });
  }

  const vetoed = index.declined
    .filter((d) => d.reason === "never-fold-ruling" && d.detail)
    .map((d) => d.detail as string);

  const wrapped: RelationIndex = {
    ...index,
    groupKey: wrappedGroupKey,
    synonymFold: (n: string) => {
      const f = index.synonymFold(n);
      return remap.get(f) ?? f;
    },
  };
  return { index: wrapped, qualifiersByKey, vetoed, remapped };
}

// ---------------------------------------------------------------------------
// R7 + BUG-323 — the NAME the row carries.
// ---------------------------------------------------------------------------

const cleaningByCurrent = new Map(NAME_CLEANINGS.map((c) => [c.current, c]));

/**
 * The proposed display name for one row. R7's rename first (it is keyed on the
 * canonical name), then the casing rule on whatever survives.
 *
 * ⚠️ `hasCatalogRow` is not a convenience. BUG-323 is a CATALOG data fix —
 * it rewrites `Ingredient.displayName` — so a row with no ingredientId never
 * picks it up. That is exactly the recurring synthetics (isRecurringItem,
 * ingredientId null), which this block must leave byte-identical for B3. The
 * first cut of this applied the casing to every row and moved 64 of them.
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
 * 🔴 R7 DOES NOT MOVE THE CANONICAL NAME, and this is a ruling the dry run
 * forced rather than a preference.
 *
 *  1. `Ingredient.canonicalName` is `@unique`. Eighteen spellings of neutral oil
 *     cannot all become "vegetable oil"; the write would be a P2002.
 *  2. The canonical name is the GROUP KEY. Renaming `boneless skinless chicken
 *     thighs` to `chicken thighs (boneless, skinless)` moved it out of the
 *     `chicken thighs` group and BROKE the R5 fold the same prompt requires —
 *     the dry run printed two lines both reading "chicken thighs".
 *
 * So R7 is a DISPLAY change. Identity stays where it is, the fold keeps working,
 * and the buy name is what the shopper reads. Kept as a function rather than
 * deleted so the rule has somewhere to be stated.
 */
export function shadowCanonicalName(canonicalName: string, _hasCatalogRow: boolean): string {
  return canonicalName;
}

// ---------------------------------------------------------------------------
// BUG-160 — the containment rule.
// ---------------------------------------------------------------------------

function stemWord(w: string): string {
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

const stemAll = (s: string) =>
  s.toLowerCase().split(/[\s,]+/).filter(Boolean).map(stemWord);

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
  /** the pack line already says everything the name says — drop the name */
  | { kind: "drop-name" }
  /** the name OPENS with the residue — print the count and the name, once */
  | { kind: "name-absorbs" };

/**
 * BUG-160's missing shapes, and they are TWO rules, not one.
 *
 * The shipped test (residueNamesItem, artifacts/kiwi/lib/format/grocery.ts:149)
 * is EQUALITY plus two plurals. The shipped Instacart test (humanLine,
 * instacartPayload.ts:159) adds `residue.endsWith(" " + name)`. The census found
 * three shapes neither catches — and a single symmetric "either contains the
 * other" predicate is WRONG, which a dry run proved by turning "3 Bell peppers"
 * into "3 ": the pack "3 peppers" has a residue the NAME contains, and dropping
 * the name there throws away the word "bell".
 *
 * So the direction decides the repair:
 *
 *   residue ⊇ name       "3 medium white onion" + "White onion"
 *                        the pack line is already the fuller statement
 *                        -> DROP THE NAME                "3 medium white onion"
 *
 *   name OPENS with residue
 *                        "1 rotisserie chicken" + "rotisserie chicken, meat
 *                        shredded" — the name is the fuller statement and its
 *                        head is the duplicate
 *                        -> COUNT + NAME    "1 rotisserie chicken, meat shredded"
 *
 *   anything else        "3 peppers" + "bell peppers"; "1 head" + "Garlic"
 *                        -> LEAVE IT ALONE
 *
 * Plural-aware via the same crude stem the token comparison uses. Nothing here
 * pluralises: BUG-321/329 are the client's lane (the prompt's §2 last bullet).
 */
export function containmentVerdict(residue: string, name: string): ContainmentVerdict {
  const r = stemAll(residue);
  const n = stemAll(name);
  if (r.length === 0 || n.length === 0) return { kind: "none" };
  if (containsSeq(r, n)) return { kind: "drop-name" };
  if (n.length > r.length && containsSeq(n.slice(0, r.length), r)) {
    return { kind: "name-absorbs" };
  }
  return { kind: "none" };
}

/** The pack minus its leading count — the client's own packResidue. */
export function packResidue(purchaseDisplay: string): string {
  return purchaseDisplay.replace(/^\s*~?\d+(?:[./]\d+)?\s+/, "").trim();
}

export { pairKey };
