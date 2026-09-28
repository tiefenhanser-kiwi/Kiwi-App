// [grocery] B1 · Part A item 6 — THE DRY RUN. READ-ONLY, WRITES NOTHING.
//
// Computes what Parts B + C WOULD do to the 20-list golden corpus, from the
// `consolidated` arrays the census captured at HEAD. Two passes over the same
// input:
//
//   BEFORE — the real production functions at HEAD (poolComponentNeeds,
//            mergeConvertibleGroups, roundNeedQuantity, scalePurchaseForSubUnit)
//   AFTER  — a SHADOW of the same pipeline with the three proposed changes:
//            (1) a per-ingredient pack yield read as the sub-unit ladder's
//                generalisation, with the child UNIT named;
//            (2) the component basis read from the PACK when defaultUnit does
//                not name one purchasable whole (no new column — D-WS9-218's
//                gap closed with the column that already exists);
//            (3) ceil-to-whole-packs with PACK_FORGIVENESS_FRACTION for
//                perishables.
//
// Both passes render through the CLIENT's composePackName, exactly as the census
// does, so a "before" line is comparable to the corpus's own.
//
//   node --env-file=.env --import tsx scripts/grocery-b1/preview.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
import {
  poolComponentNeedsUngated,
  type RelationIndex,
  type ComponentParent,
} from "../../src/lib/ingredientRelations";
import { mergeConvertibleGroups } from "../../src/lib/groceryMerge";
import { roundNeedQuantity } from "../../src/lib/needQuantity";
import {
  resolveConversion,
  scalePurchaseForSubUnit,
  normalizeUnit,
  canonicalUnitToken,
  convertWithinDimension,
  convertToGrams,
  gramsToUnit,
  unitDimension,
  isCountUnit,
  type IngredientConversion,
} from "../../src/lib/ingredientConversions";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";

import {
  PACK_YIELDS,
  PACK_YIELDS_PORTION_NAMES,
  PART_EDGES,
  WIDENED_ADMIT,
  WIDENED_REFUSE_NOTES,
  SYNONYM_EDGES,
  PACK_FORGIVENESS_FRACTION,
} from "./proposals";
import { buildRelationIndex, type RelationRow } from "../../src/lib/ingredientRelations";

// ── the client's render, loaded the way census.ts loads it ───────────────────
import * as groceryFormatNs from "../../../kiwi/lib/format/grocery.js";
interface GroceryFormat {
  composePackName: (
    name: string, purchaseUnit: string | null | undefined,
    purchaseDisplay: string | null | undefined, needAmount?: string | number | null,
    needUnit?: string | null, isPantryStaple?: boolean,
  ) => string;
  formatNeedText: (a: string | undefined, u: string | undefined, f: string) => string;
}
const ns = groceryFormatNs as unknown as { default?: GroceryFormat } & GroceryFormat;
const G: GroceryFormat = ns.composePackName ? ns : (ns.default as GroceryFormat);
if (typeof G?.composePackName !== "function") throw new Error("client render not loadable");
const { composePackName, formatNeedText } = G;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CORPUS = join(HERE, "..", "grocery-census", "out");
const PLANS = [
  "f5556c19", "56b03a57", "c404a3cf", "247cd7bb", "14879176", "b8e7f134",
  "31c7a885", "96a94410", "425da049", "ed238692", "2b6e51a1", "6e952e32",
  "a8b0bbd5", "316d0846", "11653a33", "353ce059", "14397131", "163875ec",
  "d47d18aa", "8a462408",
];

const EPS = 1e-9;

interface Row {
  ingredientId?: string | null;
  canonicalName: string;
  displayName: string;
  quantity: number;
  unit: string;
  sectionKey: string;
  isUniversalStaple: boolean;
  isUserPantryStaple: boolean;
  isRecurringItem: boolean;
  purchaseUnit: string | null;
  purchaseQuantity: number | null;
  purchaseDisplay: string | null;
  conversionRef?: unknown;
  [k: string]: unknown;
}

// ── the proposed pack yield, as the generalised ladder ───────────────────────
interface PackYieldRow { unit: string; perPack: number; packUnit: string; packDisplay: string | null }
type YieldMap = Map<string, PackYieldRow>;

/** Layer the proposed yield onto a conversion as subUnit {parent, perParent} + childUnit. */
interface Ladder { parent: string; perParent: number; childUnit: string | null }
function ladderFor(name: string, conv: IngredientConversion | null, yields: YieldMap): Ladder | null {
  const y = yields.get(normalizeIngredientName(name)) ?? yields.get(name.toLowerCase().trim());
  if (y) return { parent: normalizeUnit(y.packUnit), perParent: y.perPack, childUnit: normalizeUnit(y.unit) };
  if (conv?.subUnit) return { parent: normalizeUnit(conv.subUnit.parent), perParent: conv.subUnit.perParent, childUnit: null };
  return null;
}

/**
 * A member name whose OWN component edge says how many of the group's child unit
 * ONE of it yields. `garlic head --component--> garlic : 10 clove` is in the
 * table today, human-reviewed, and the index DROPS it as a self-edge because
 * `garlic head` and `garlic` fold to one key. That drop is what makes "garlic
 * head 1 each" unreadable: BUG-211's rule says a bare count is the CHILD, so it
 * counts as ONE CLOVE when it is one HEAD — ten.
 *
 * Keyed by normalized member name -> { perOne, unit }. Read from the table; no
 * new data, no new special case for garlic.
 */
const selfYield = new Map<string, { perOne: number; unit: string }>();

/** Convert a quantity into the ladder's child unit, or null. */
function toChild(qty: number, fromUnit: string, l: Ladder, conv: IngredientConversion | null, memberName?: string): number | null {
  const from = canonicalUnitToken(fromUnit);
  if (from === canonicalUnitToken(l.parent)) return qty * l.perParent;
  if (memberName && isCountUnit(fromUnit)) {
    const sy = selfYield.get(normalizeIngredientName(memberName));
    if (sy && l.childUnit && canonicalUnitToken(sy.unit) === canonicalUnitToken(l.childUnit)) {
      return qty * sy.perOne;
    }
  }
  if (l.childUnit === null) {
    // today's shape: the child is a bare count (clove). A count unit IS the child.
    return isCountUnit(fromUnit) ? qty : null;
  }
  if (from === canonicalUnitToken(l.childUnit)) return qty;
  // BUG-211, PRESERVED: a BARE COUNT against a ladder whose child is a count IS
  // that child. `garlic cloves` is authored defaultUnit "each" and `garlic`
  // "cloves", so a plan drawing on both arrives as {each, clove}. Without this
  // the density path below turns 6 "each" into grams and back and gets a
  // different number for the same six cloves.
  //
  // ⚠️ isCountUnit("clove") is FALSE — COUNT_UNITS does not carry it — so the
  // test is "the FROM unit is a bare count and the child is not a measure".
  if (isCountUnit(fromUnit) && unitDimension(l.childUnit) === null) return qty;
  const same = convertWithinDimension(qty, fromUnit, l.childUnit);
  if (same !== null) return same;
  if (!conv) return null;
  const g = convertToGrams(qty, fromUnit, conv);
  if (g === null) return null;
  return gramsToUnit(g, l.childUnit, conv);
}

/** PROPOSED: ceil to whole packs, with the perishable forgiveness. */
export const forgiven: string[] = [];
export function packsForNeed(raw: number, perishable: boolean, label = ""): number {
  if (!(raw > 0)) return 0;
  const whole = Math.floor(raw + EPS);
  const over = raw - whole;
  if (over <= EPS) return Math.max(1, whole);
  if (perishable && over <= PACK_FORGIVENESS_FRACTION + EPS) {
    // Logged only when it CHANGES the answer. Below one pack the max(1, …) floor
    // already gives 1, so a "forgiveness" there is not a decision.
    if (label && whole >= 1) forgiven.push(`${label}: ${raw.toFixed(4)} packs -> ${whole} instead of ${whole + 1} (over by ${over.toFixed(4)} ≤ ${PACK_FORGIVENESS_FRACTION})`);
    return Math.max(1, whole);
  }
  return Math.max(1, whole + 1);
}

const PERISHABLE_SECTIONS = new Set(["produce"]);
const isPerishable = (r: Row) => PERISHABLE_SECTIONS.has(r.sectionKey);

// ── AFTER: the merge's sub-unit branch, generalised to a measured child ──────
function shadowMergeGroup(group: Row[], yields: YieldMap): Row | null {
  const conv = (() => {
    // PROPOSED FIX (BUG-200, still live): prefer the member whose conversion
    // CARRIES the ladder. groupConversion at HEAD takes the first non-null, and
    // `garlic cloves` (usda_derived, no subUnit) sorts before `garlic`.
    for (const it of group) {
      const c = resolveConversion(it.canonicalName, it.conversionRef);
      if (c && (c.subUnit || yields.has(normalizeIngredientName(it.canonicalName)))) return c;
    }
    for (const it of group) {
      const c = resolveConversion(it.canonicalName, it.conversionRef);
      if (c) return c;
    }
    return null;
  })();
  const ladder = (() => {
    for (const it of group) {
      const l = ladderFor(it.canonicalName, resolveConversion(it.canonicalName, it.conversionRef), yields);
      if (l) return l;
    }
    return null;
  })();
  const rep = group.reduce((best, it) => {
    const a = normalizeIngredientName(it.canonicalName);
    const b = normalizeIngredientName(best.canonicalName);
    if (a.length !== b.length) return a.length < b.length ? it : best;
    return a < b ? it : best;
  });
  const units = group.map((g) => g.unit);
  const tokens = new Set(units.map(canonicalUnitToken));
  if (tokens.size === 1) {
    const total = group.reduce((a, b) => a + b.quantity, 0);
    return total > 0 ? { ...rep, quantity: total } : null;
  }
  const dim = unitDimension(units[0]);
  if (dim !== null && units.every((u) => unitDimension(u) === dim)) {
    const target = units.find((u) => unitDimension(u) === dim)!;
    let total = 0;
    for (const it of group) {
      const q = convertWithinDimension(it.quantity, it.unit, target);
      if (q === null) { total = -1; break; }
      total += q;
    }
    if (total > 0) return { ...rep, unit: target, quantity: total };
  }
  // the ladder branch, generalised: every member converts into the CHILD unit
  // (a count OR a measure), or the group is refused as it is today.
  if (ladder) {
    let total = 0;
    let ok = true;
    for (const it of group) {
      const q = toChild(it.quantity, it.unit, ladder, conv, it.canonicalName);
      if (q === null) { ok = false; break; }
      total += q;
    }
    if (ok && total > 0) {
      const childUnit = ladder.childUnit
        ?? group.find((g) => !isCountUnit(g.unit) || canonicalUnitToken(g.unit) !== canonicalUnitToken(ladder.parent))?.unit
        ?? ladder.parent;
      const spelt = group.find((g) => canonicalUnitToken(g.unit) === canonicalUnitToken(childUnit))?.unit ?? childUnit;
      return { ...rep, unit: spelt, quantity: total };
    }
  }
  return null;
}

function shadowMerge(rows: Row[], index: RelationIndex, yields: YieldMap): Row[] {
  const groups = new Map<string, Row[]>();
  const order: string[] = [];
  for (const r of rows) {
    const k = index.groupKey(r.canonicalName);
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k)!.push(r);
  }
  const out: Row[] = [];
  for (const k of order) {
    const g = groups.get(k)!;
    if (g.length === 1) { out.push(g[0]); continue; }
    const m = shadowMergeGroup(g, yields);
    if (m) out.push(m);
    else out.push(...g);
  }
  return out;
}

// ── AFTER: the pack line ────────────────────────────────────────────────────
/**
 * The pack RESIDUE — "1 bunch (~12 oz)" -> "bunch (~12 oz)". Same regex the
 * client's packResidue uses, so the two halves cannot disagree.
 */
const packResidue = (d: string) => d.replace(/^\s*\d+(?:\.\d+)?\s+/, "").trim();

// FINDING, and a Part C decision: canonicalUnitToken's COUNT_UNIT_ALIASES holds
// only {cloves, cans, stalks, inches}, so `heads` does NOT fold to `head` and a
// stored display of "4 heads" could not be recognised as the bare pack noun —
// the rewrite produced "1 heads iceberg lettuce". Folded locally here rather
// than by editing the shared map, because that map is also bucketKeyOf's key
// source (BUG-174: keys only, never written back onto item.unit).
const PACK_NOUN_PLURALS: Record<string, string> = {
  heads: "head", bunches: "bunch", bulbs: "bulb", ears: "ear", jars: "jar",
  wedges: "wedge", loaves: "loaf", sprigs: "sprig", bottles: "bottle",
  packages: "package", blocks: "block", containers: "container", boxes: "box",
  bags: "bag",
};
const packNoun = (u: string) => {
  const t = canonicalUnitToken(u);
  return PACK_NOUN_PLURALS[t] ?? t;
};

function shadowPack(r: Row, yields: YieldMap): { purchaseUnit: string | null; purchaseQuantity: number | null; purchaseDisplay: string | null } {
  const conv = resolveConversion(r.canonicalName, r.conversionRef);
  const l = ladderFor(r.canonicalName, conv, yields);
  const storedDisplay = r.purchaseDisplay ?? conv?.purchaseDisplay ?? null;
  const packUnit = r.purchaseUnit ?? conv?.purchaseUnit ?? null;
  if (!l || !packUnit || normalizeUnit(packUnit) !== l.parent) {
    return { purchaseUnit: r.purchaseUnit, purchaseQuantity: r.purchaseQuantity, purchaseDisplay: r.purchaseDisplay };
  }
  const child = toChild(r.quantity, r.unit, l, conv);
  if (child === null || !(child > 0)) {
    return { purchaseUnit: r.purchaseUnit, purchaseQuantity: r.purchaseQuantity, purchaseDisplay: r.purchaseDisplay };
  }
  const floor = packFloor.get(normalizeIngredientName(r.canonicalName)) ?? 0;
  const n = Math.max(
    floor,
    packsForNeed(child / l.perParent, isPerishable(r), `${r.canonicalName} ${r.quantity} ${r.unit}`),
  );
  // ── THE DISPLAY RULE, forced by the first dry run ────────────────────────
  // Synthesising `${n} ${parent}s` is right for garlic ("1 head" -> "3 heads",
  // BUG-025-1) and WRONG for every pack whose display says more than its noun:
  // it turned "1 small knob (~2 oz) fresh ginger" into "1 each fresh ginger"
  // and "1 head red cabbage" into "1 each red cabbage". So synthesise only when
  // the stored residue IS the bare pack noun; otherwise rewrite the LEADING
  // COUNT and leave the words alone.
  if (storedDisplay === null) {
    return { purchaseUnit: l.parent, purchaseQuantity: n, purchaseDisplay: `${n} ${l.parent}${n === 1 ? "" : l.parent.endsWith("h") ? "es" : "s"}` };
  }
  const residue = packResidue(storedDisplay);
  if (packNoun(residue) === packNoun(l.parent)) {
    return {
      purchaseUnit: l.parent,
      purchaseQuantity: n,
      purchaseDisplay: `${n} ${l.parent}${n === 1 ? "" : l.parent.endsWith("h") ? "es" : "s"}`,
    };
  }
  if (n === (r.purchaseQuantity ?? 1)) {
    return { purchaseUnit: r.purchaseUnit, purchaseQuantity: r.purchaseQuantity, purchaseDisplay: r.purchaseDisplay };
  }
  return {
    purchaseUnit: r.purchaseUnit,
    purchaseQuantity: n,
    purchaseDisplay: storedDisplay.replace(/^\s*\d+(?:\.\d+)?/, String(n)),
  };
}

// ── AFTER: the pool, with ONE change ─────────────────────────────────────────
//
// BUG-208's guard declines when the list already carries the parent in a unit
// the pool cannot reach — "fresh cilantro in cup against a basis of bunch". That
// guard exists because nothing could relate the two. THE PACK YIELD IS EXACTLY
// THAT RELATION, so the guard's premise no longer holds for a parent that has
// one: the pooled parent count is converted back into the row's OWN unit and
// added there, which keeps the need meaningful ("1 bunch fresh cilantro (2 cup)")
// instead of replacing it with "1 bunch".
//
// Measured: this is what f5556c19's three cilantro bunches turn on.
/**
 * Rows whose PACK count must not fall below n, because a part rides with it.
 * Keyed by NAME, not identity: shadowMerge spreads `{...rep}` and makes a new
 * object, so an identity key would be lost between the pool and the pack line.
 * Cleared per list.
 */
const packFloor = new Map<string, number>();

function shadowPool(
  items: Row[], index: RelationIndex, yields: YieldMap,
): { items: Row[]; folds: string[]; declines: string[] } {
  const folds: string[] = [];
  const declines: string[] = [];
  if (index.componentParents.length === 0) return { items: items.slice(), folds, declines };

  const byKey = new Map<string, Row[]>();
  for (const it of items) {
    const k = index.groupKey(it.canonicalName);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(it);
  }
  const absorbed = new Set<Row>();
  const appended: Row[] = [];
  const onList = (cp: ComponentParent) =>
    (byKey.get(cp.parent) ?? []).some((r) => canonicalUnitToken(r.unit) === canonicalUnitToken(cp.basisUnit));
  const walk = index.componentParents.slice().sort((a, b) => Number(onList(b)) - Number(onList(a)));

  for (const cp of walk) {
    const slotRows = new Map<string, Row[]>();
    for (const slot of cp.slots) {
      const rows = (byKey.get(slot.child) ?? []).filter((r) => !absorbed.has(r));
      if (rows.length > 0) slotRows.set(slot.child, rows);
    }
    if (slotRows.size === 0) continue;

    const parentRows = (byKey.get(cp.parent) ?? []).filter((r) => !absorbed.has(r));
    const existing = parentRows.filter((r) => canonicalUnitToken(r.unit) === canonicalUnitToken(cp.basisUnit));
    // the off-basis parent row, and whether its own pack yield can reach the basis
    let offBasis: Row | null = null;
    let offBasisLadder: Ladder | null = null;
    if (parentRows.length > 0 && existing.length === 0) {
      const p = parentRows[0];
      const l = ladderFor(p.canonicalName, resolveConversion(p.canonicalName, p.conversionRef), yields);
      const reach = l && canonicalUnitToken(l.parent) === canonicalUnitToken(cp.basisUnit)
        ? toChild(1, cp.basisUnit, l, resolveConversion(p.canonicalName, p.conversionRef))
        : null;
      if (l && reach !== null) { offBasis = p; offBasisLadder = l; }
      else {
        declines.push(`${cp.parent} <- ${[...slotRows.keys()].join(", ")}: carries "${cp.parent}" in "${p.unit}", basis "${cp.basisUnit}", and no pack yield relates them`);
        continue;
      }
    }

    let coMax = 0, exclusiveSum = 0, anySlot = false;
    const took: Row[] = [];
    const exclusiveTook: Row[] = [];
    for (const slot of cp.slots) {
      const rows = slotRows.get(slot.child);
      if (!rows) continue;
      let demand = 0, ok = true;
      for (const r of rows) {
        const conv = resolveConversion(r.canonicalName, r.conversionRef);
        let q: number | null =
          canonicalUnitToken(r.unit) === canonicalUnitToken(slot.yieldUnit)
            ? r.quantity
            : convertWithinDimension(r.quantity, r.unit, slot.yieldUnit);
        if (q === null && conv) {
          const g = convertToGrams(r.quantity, r.unit, conv);
          q = g === null ? null : gramsToUnit(g, slot.yieldUnit, conv);
        }
        if (q === null) {
          declines.push(`${cp.parent} <- ${slot.child}: "${r.canonicalName}" ${r.quantity} ${r.unit} does not convert to "${slot.yieldUnit}" without a density`);
          ok = false; break;
        }
        demand += q;
      }
      if (!ok || !(demand > 0)) continue;
      const implied = demand / slot.yieldQuantity;
      if (slot.coHarvestable) coMax = Math.max(coMax, implied);
      else { exclusiveSum += implied; for (const r of rows) exclusiveTook.push(r); }
      for (const r of rows) took.push(r);
      anySlot = true;
    }
    if (!anySlot) continue;
    const pooled = coMax + exclusiveSum;
    if (!(pooled > 0)) continue;
    for (const r of took) absorbed.add(r);

    if (existing.length > 0) {
      existing[0].quantity += Math.ceil(pooled - EPS);
      folds.push(`${cp.parent}: +${Math.ceil(pooled - EPS)} ${cp.basisUnit} onto the existing row`);
    } else if (offBasis && offBasisLadder) {
      // ── THE OFF-BASIS ROW, AND WHY THE NEED IS NOT TOUCHED ─────────────────
      //
      // The first dry run converted the pooled PARENT COUNT back into the row's
      // own unit and added it. That is wrong twice over: it turned 0.333 jars of
      // BRINE into 8 tablespoons of SLICES (two different yields, one round
      // trip), and for a coHarvestable part it inflates a need the shopper never
      // had — the brine RIDES FREE, which is the whole point of the flag.
      //
      // So a coHarvestable slot against an off-basis parent absorbs the child
      // row and contributes a PACK FLOOR, never a need. "1 jar (12 oz) pickled
      // jalapeño slices (2 tablespoon)", brine row gone. D-WS9-182's zest and
      // juice share one lime on exactly this argument.
      //
      // An EXCLUSIVE slot genuinely adds, and adding it needs the row's unit to
      // reconcile with the slot's yield unit — so that case declines and prints,
      // rather than guessing.
      if (exclusiveTook.length > 0) {
        declines.push(`${cp.parent}: an EXCLUSIVE slot (${exclusiveTook.map((r) => r.canonicalName).join(", ")}) cannot be added to an off-basis row in "${offBasis.unit}"`);
        for (const r of took) absorbed.delete(r);
        continue;
      }
      const floor = Math.ceil(pooled - EPS);
      const fk = normalizeIngredientName(offBasis.canonicalName);
      packFloor.set(fk, Math.max(packFloor.get(fk) ?? 0, floor));
      folds.push(`${cp.parent}: ${took.length} coHarvestable row(s) ride free; pack floor ${floor} ${cp.basisUnit}, need unchanged`);
    } else {
      const whole = Math.ceil(pooled - EPS);
      const template = (byKey.get(cp.parent) ?? [])[0];
      const seed = template ?? took[0];
      appended.push({
        ...seed,
        canonicalName: cp.parent,
        displayName: template ? template.displayName : cp.parent,
        quantity: whole,
        unit: cp.basisUnit,
        ...(template ? {} : { ingredientId: null, conversionRef: null }),
      });
      folds.push(`${cp.parent}: appended ${whole} ${cp.basisUnit}`);
    }
  }
  return { items: items.filter((i) => !absorbed.has(i)).concat(appended), folds, declines };
}

// ── BEFORE: HEAD's pack line (resolvePurchaseFields, minus withGroupLadder) ──
function headPack(r: Row): { purchaseUnit: string | null; purchaseQuantity: number | null; purchaseDisplay: string | null } {
  const conv = resolveConversion(r.canonicalName, r.conversionRef);
  const scaled = scalePurchaseForSubUnit(conv, r.quantity, r.unit);
  if (scaled && conv?.subUnit) {
    return { purchaseUnit: conv.subUnit.parent, purchaseQuantity: scaled.purchaseQuantity, purchaseDisplay: scaled.purchaseDisplay };
  }
  return { purchaseUnit: r.purchaseUnit, purchaseQuantity: r.purchaseQuantity, purchaseDisplay: r.purchaseDisplay };
}

function render(r: Row, pack: { purchaseUnit: string | null; purchaseDisplay: string | null }): string {
  const amt = String(r.quantity);
  const unit = r.unit || undefined;
  const staple = r.isUniversalStaple || r.isUserPantryStaple;
  const need = formatNeedText(amt, unit, unit ? `${r.quantity} ${r.unit}` : amt).trim();
  const name = composePackName(r.displayName, pack.purchaseUnit ?? undefined, pack.purchaseDisplay ?? undefined, amt, unit, staple);
  return need ? `${name} (${need})` : name;
}

// ── the widened component index (basis read from the pack when needed) ───────
const COUNTABLE_WHOLE = new Set([
  "each", "head", "bunch", "bulb", "ear", "loaf", "wedge", "jar",
]);

async function buildShadowIndex(
  prisma: PrismaClient,
): Promise<{ index: RelationIndex; widened: string[]; added: string[]; refusedWidened: string[] }> {
  const raw = await prisma.ingredientRelation.findMany({
    include: {
      from: { select: { canonicalName: true, defaultUnit: true, purchaseUnit: true } },
      to: { select: { canonicalName: true } },
    },
  });
  const ings = await prisma.ingredient.findMany({
    select: { canonicalName: true, defaultUnit: true, purchaseUnit: true },
  });
  const ingByName = new Map(ings.map((i) => [normalizeIngredientName(i.canonicalName), i]));

  const proposed = new Map(PART_EDGES.map((e) => [`${normalizeIngredientName(e.parent)}>${normalizeIngredientName(e.child)}`, e]));
  const admitEdge = new Set(WIDENED_ADMIT.map((r) => r.edge));
  const refuseNote = new Map(WIDENED_REFUSE_NOTES.map((r) => [r.edge, r.why]));
  const widened: string[] = [];
  const refusedWidened: string[] = [];
  const added: string[] = [];

  // The basis derivation, PROPOSED. Today's rule is unchanged: `defaultUnit`
  // when it names ONE purchasable whole. What is new is the FALLBACK — the PACK
  // noun, which already exists as a column — and it is DEFAULT-REFUSE: an edge
  // the fallback newly reaches is admitted only when WIDENED_ADMIT names it.
  const HEAD_BASIS = ["each", "head", "bunch"];
  const basisOf = (defaultUnit: string, purchaseUnit: string | null, edge: string): string | null => {
    const d = normalizeUnit(defaultUnit);
    if (HEAD_BASIS.includes(d)) return d;
    const p = normalizeUnit(purchaseUnit ?? "");
    if (!COUNTABLE_WHOLE.has(p)) {
      refusedWidened.push(`${edge}: basis ${d} (defaultUnit) and pack "${p || "none"}" — neither names one purchasable whole${refuseNote.has(edge) ? ` · ${refuseNote.get(edge)}` : ""}`);
      return null;
    }
    if (!admitEdge.has(edge)) {
      refusedWidened.push(`${edge}: the pack "${p}" would reach it — REFUSED${refuseNote.has(edge) ? ` · ${refuseNote.get(edge)}` : " · not on the admit list"}`);
      return null;
    }
    widened.push(`${edge}: basis ${d} (defaultUnit, refused today) -> ${p} (the pack)`);
    return p;
  };

  const rows: RelationRow[] = [];
  for (const r of raw) {
    const label = r.label as RelationRow["label"];
    const edge = `${r.from.canonicalName} -> ${r.to.canonicalName}`;
    const p = proposed.get(`${normalizeIngredientName(r.from.canonicalName)}>${normalizeIngredientName(r.to.canonicalName)}`);
    let basis = normalizeUnit(r.from.defaultUnit);
    if (label === "component" && !HEAD_BASIS.includes(basis)) {
      const b = basisOf(r.from.defaultUnit, r.from.purchaseUnit, edge);
      // a refused edge keeps its un-admittable defaultUnit basis, exactly as at
      // HEAD, so admitComponent declines it there too
      if (b !== null) basis = b;
    }
    // the salt row — X: synonym -> distinct
    const isSaltRow =
      normalizeIngredientName(r.from.canonicalName) === "coarse kosher salt" &&
      normalizeIngredientName(r.to.canonicalName) === "kosher salt";
    rows.push({
      label: isSaltRow ? "distinct" : label,
      fromCanonicalName: r.from.canonicalName,
      toCanonicalName: r.to.canonicalName,
      yieldQuantity: p?.yieldQuantity ?? r.yieldQuantity,
      yieldUnit: p?.yieldUnit ?? r.yieldUnit,
      coHarvestable: p?.coHarvestable ?? r.coHarvestable,
      confidence: (p ? "high" : r.confidence) as RelationRow["confidence"],
      reviewedByHuman: p ? true : r.reviewedByHuman,
      fromDefaultUnit: basis,
    });
  }
  // brand-new component edges
  const seen = new Set(raw.map((r) => `${normalizeIngredientName(r.from.canonicalName)}>${normalizeIngredientName(r.to.canonicalName)}`));
  for (const [key, e] of proposed) {
    if (seen.has(key)) continue;
    const row = ingByName.get(normalizeIngredientName(e.parent));
    if (!row) { added.push(`${e.parent} -> ${e.child}: NO PARENT CATALOG ROW — cannot author a row->row edge`); continue; }
    if (e.yieldQuantity == null || !e.yieldUnit) continue;
    const d = normalizeUnit(row.defaultUnit);
    const pu = normalizeUnit(row.purchaseUnit ?? "");
    const basis = HEAD_BASIS.includes(d) ? d : COUNTABLE_WHOLE.has(pu) ? pu : null;
    if (basis === null) { added.push(`${e.parent} -> ${e.child}: NO DERIVABLE BASIS (default ${d}, pack ${pu || "none"})`); continue; }
    added.push(`${e.parent} -> ${e.child}: ${e.yieldQuantity} ${e.yieldUnit} co=${e.coHarvestable} basis=${basis}`);
    rows.push({
      label: "component", fromCanonicalName: e.parent, toCanonicalName: e.child,
      yieldQuantity: e.yieldQuantity, yieldUnit: e.yieldUnit, coHarvestable: e.coHarvestable,
      confidence: "high", reviewedByHuman: true, fromDefaultUnit: basis,
    });
  }
  // brand-new synonym edges
  for (const s of SYNONYM_EDGES) {
    added.push(`SYNONYM ${s.a} <-> ${s.b}`);
    rows.push({
      label: "synonym", fromCanonicalName: s.a, toCanonicalName: s.b,
      yieldQuantity: null, yieldUnit: null, coHarvestable: null,
      confidence: "high", reviewedByHuman: true,
      fromDefaultUnit: normalizeUnit(ingByName.get(normalizeIngredientName(s.a))?.defaultUnit ?? "each"),
    });
  }
  // buildRelationIndex gives the SYNONYM half (groupKey, clusters, the never-fold
  // veto) unchanged. Its component half still gates on COMPONENT_BASIS_UNITS
  // {each, head, bunch}, and widening that SET is part of what Part C proposes —
  // so the component parents are assembled here, from the same rows, with the
  // widened set. Part C changes the real function; this proves the arithmetic
  // first.
  const base = buildRelationIndex(rows);
  const byParent = new Map<string, ComponentParent>();
  for (const r of rows) {
    if (r.label !== "component") continue;
    if (r.yieldQuantity == null || !(r.yieldQuantity > 0) || !r.yieldUnit || r.coHarvestable == null) continue;
    const basis = normalizeUnit(r.fromDefaultUnit);
    if (!COUNTABLE_WHOLE.has(basis)) continue;
    const parent = base.groupKey(r.fromCanonicalName);
    const child = base.groupKey(r.toCanonicalName);
    if (parent === child) continue;
    let cp = byParent.get(parent);
    if (!cp) { cp = { parent, basisUnit: basis, slots: [] }; byParent.set(parent, cp); }
    const slot = cp.slots.find((s) => s.child === child);
    if (slot) {
      slot.childNames.push(r.toCanonicalName);
      continue;
    }
    cp.slots.push({ child, childNames: [r.toCanonicalName], yieldQuantity: r.yieldQuantity, yieldUnit: r.yieldUnit, coHarvestable: r.coHarvestable });
  }
  const parents = [...byParent.values()].filter((cp) => cp.slots.length > 0).sort((a, b) => a.parent.localeCompare(b.parent));

  // the SELF-EDGE yields the index drops — "garlic head -> garlic : 10 clove"
  for (const r of rows) {
    if (r.label !== "component") continue;
    if (r.yieldQuantity == null || !(r.yieldQuantity > 0) || !r.yieldUnit) continue;
    if (base.groupKey(r.fromCanonicalName) !== base.groupKey(r.toCanonicalName)) continue;
    selfYield.set(normalizeIngredientName(r.fromCanonicalName), { perOne: r.yieldQuantity, unit: r.yieldUnit });
  }
  return { index: { ...base, componentParents: parents }, widened, added, refusedWidened };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient();
  const real = await loadRelationIndex(prisma);

  // pack yields, keyed on the normalized name, carrying the pack noun from the DB
  const ingRows = await prisma.ingredient.findMany({
    select: { canonicalName: true, purchaseUnit: true, purchaseDisplay: true, defaultUnit: true },
  });
  const packOf = new Map(ingRows.map((i) => [normalizeIngredientName(i.canonicalName), i]));
  const yields: YieldMap = new Map();
  const yieldProblems: string[] = [];
  for (const y of [...PACK_YIELDS, ...PACK_YIELDS_PORTION_NAMES]) {
    const key = normalizeIngredientName(y.ingredient);
    const row = packOf.get(key);
    if (!row) { yieldProblems.push(`${y.ingredient}: NO CATALOG ROW`); continue; }
    // the pack noun: the column first, then the row's own conversionRef /
    // curated pack (`flat-leaf parsley` has a null column and a curated "bunch")
    const conv = resolveConversion(y.ingredient, null);
    const packUnit = row.purchaseUnit ?? conv?.purchaseUnit ?? null;
    if (!packUnit) { yieldProblems.push(`${y.ingredient}: no pack noun anywhere — the ladder cannot fire`); continue; }
    yields.set(key, { unit: y.unit, perPack: y.perPack, packUnit, packDisplay: row.purchaseDisplay });
  }

  const { index: shadowIndex, widened, added, refusedWidened } = await buildShadowIndex(prisma);

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);

  say("B1 PREVIEW — what Parts B + C would do to the 20-list golden corpus");
  say("computed from the census `consolidated` arrays at f3f274a. NOTHING WRITTEN.");
  say();
  say(`pack yields loaded: ${yields.size} of ${PACK_YIELDS.length}`);
  for (const p of yieldProblems) say(`  ⚠️ ${p}`);
  say();
  say(`component parents: ${real.componentParents.length} at HEAD -> ${shadowIndex.componentParents.length} with the pack basis`);
  say(`edges UNBLOCKED by reading the basis off the pack, and ADMITTED (${widened.length}):`);
  for (const w of widened) say(`   ${w}`);
  say(`edges the widening reaches but the P rulings REFUSE (${refusedWidened.length}):`);
  for (const w of refusedWidened) say(`   ${w}`);
  say(`edges ADDED or RE-FIGURED by the P proposals (${added.length}):`);
  for (const a of added) say(`   ${a}`);
  say();

  let changed = 0, unchanged = 0;
  const classOf = (name: string): string => {
    const n = name.toLowerCase();
    if (n.includes("garlic")) return "garlic";
    if (/salt/.test(n)) return "salt";
    return "R2/pool";
  };
  const byClass = new Map<string, number>();
  const numbered: string[] = [];

  for (const id of PLANS) {
    const j = JSON.parse(readFileSync(join(CORPUS, `live__${id}__r1.json`), "utf8"));
    const src = j.consolidated as Row[];

    // BEFORE — the real pipeline at HEAD
    const bPool = poolComponentNeedsUngated(src as never, real);
    const bMerged = mergeConvertibleGroups(bPool.items as never, real) as unknown as Row[];
    const before = bMerged.map((r) => ({ ...r, quantity: roundNeedQuantity(r.quantity, r.unit) }));
    const beforeLines = before.map((r) => ({ r, line: render(r, headPack(r)) }));

    // AFTER — the shadow. Deep-copied first: shadowPool mutates a parent row's
    // quantity in place, exactly as the real pool tops up an existing row.
    packFloor.clear();
    const aSrc = JSON.parse(JSON.stringify(src)) as Row[];
    const aPool = shadowPool(aSrc, shadowIndex, yields);
    const aMerged = shadowMerge(aPool.items, shadowIndex, yields);
    const after = aMerged.map((r) => ({ ...r, quantity: roundNeedQuantity(r.quantity, r.unit) }));
    const afterLines = after.map((r) => ({ r, line: render(r, shadowPack(r, yields)) }));

    // pair by (name, unit token) — the row's own identity, so a fold shows as a
    // removal on one side and a changed line on the other rather than as noise.
    const key = (r: Row) => `${normalizeIngredientName(r.canonicalName)}|${canonicalUnitToken(r.unit)}`;
    const bMap = new Map(beforeLines.map((x) => [key(x.r), x.line]));
    const aMap = new Map(afterLines.map((x) => [key(x.r), x.line]));
    const allKeys = new Set([...bMap.keys(), ...aMap.keys()]);
    const diffs: string[] = [];
    for (const k of allKeys) {
      const b = bMap.get(k);
      const a = aMap.get(k);
      if (b === a) { unchanged++; continue; }
      changed++;
      const name = k.split("|")[0];
      const cls = classOf(name);
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
      if (b === undefined) diffs.push(`      + ${a}`);
      else if (a === undefined) diffs.push(`      - ${b}   (absorbed / merged away)`);
      else diffs.push(`        ${b}\n     -> ${a}`);
    }
    if (diffs.length > 0) {
      numbered.push(`## ${id} — ${j.planTitle}   (${before.length} rows -> ${after.length})`);
      for (const d of diffs) numbered.push(d);
      for (const dcl of aPool.declines) numbered.push(`      DECLINE ${dcl}`);
      for (const f of aPool.folds) numbered.push(`      POOL ${f}`);
    }
  }

  say("=== CHANGED ROWS, BY LIST ===");
  let n = 0;
  for (const l of numbered) {
    if (l.startsWith("## ")) { say(); say(l); }
    else { n++; say(`${String(n).padStart(3)}.${l}`); }
  }
  say();
  say("=== WHERE THE FORGIVENESS FIRES ON THE CORPUS ===");
  if (forgiven.length === 0) say("  nowhere — every corpus row lands on or under a whole pack without it.");
  for (const f of forgiven) say(`  ${f}`);

  // ── §2 rule 3's five named cases, AS FIXTURES ────────────────────────────
  // Three of the five do not occur in the corpus (no list carries a cabbage
  // HEAD beside a cabbage CUP need), so they are computed here from literals
  // rather than claimed from a list that does not hold them.
  say();
  say("=== §2 RULE 3 — THE FIVE NAMED CASES, COMPUTED ===");
  const fixture = (name: string, parts: [number, string][], expect: string) => {
    const y = yields.get(normalizeIngredientName(name));
    if (!y) { say(`  ${name}: NO YIELD — cannot compute`); return; }
    const conv = resolveConversion(name, null);
    const l: Ladder = { parent: normalizeUnit(y.packUnit), perParent: y.perPack, childUnit: normalizeUnit(y.unit) };
    let total = 0;
    let ok = true;
    for (const [q, u] of parts) {
      const c = toChild(q, u, l, conv, name);
      if (c === null) { ok = false; break; }
      total += c;
    }
    if (!ok) { say(`  ${name}: a part does not convert`); return; }
    const rawPacks = total / l.perParent;
    const n = packsForNeed(rawPacks, true);
    const label = parts.map(([q, u]) => `${q} ${u}`).join(" + ");
    const got = `${n} ${l.parent}${n === 1 ? "" : "es"}`.replace("heades", "heads").replace("bunches", "bunches");
    say(`  ${name}: ${label}  =  ${total} ${l.unit} = ${rawPacks.toFixed(4)} packs  ->  ${n} ${l.parent}  [expected ${expect}]  ${String(n) === expect.split(" ")[0] ? "✅" : "❌"}`);
    void got;
  };
  fixture("fresh cilantro", [[1, "bunch"], [2, "tablespoon"]], "1 bunch");
  fixture("green cabbage", [[1, "head"], [2, "cup"]], "2 heads");
  fixture("iceberg lettuce", [[2, "cup"]], "1 head");
  fixture("fresh cilantro", [[0.25, "cup"], [0.25, "bunch"]], "1 bunch");
  fixture("fresh cilantro", [[1, "bunch"], [0.5, "cup"]], "2 bunches");
  fixture("garlic", [[1, "head"], [3, "clove"]], "2 heads");

  say();
  say("=== TOTALS ===");
  say(`changed row-slots: ${changed} · unchanged: ${unchanged}`);
  for (const [c, k] of byClass) say(`  class ${c}: ${k}`);

  writeFileSync(join(OUT, "preview.txt"), lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  console.log(`\nwrote ${join(OUT, "preview.txt")}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); process.exit(1); });
