// [grocery] B2 · Part A — THE DRY RUN. READ-ONLY, WRITES NOTHING.
//
//   node --env-file=.env --import tsx scripts/grocery-b2/preview.ts  -> out/preview.txt
//
// Computes what Parts B + C WOULD do to the 20-list golden corpus, from the
// `consolidated` arrays the census captured. Two passes over the same input:
//
//   BEFORE — the real production functions at HEAD (mergeConvertibleGroups,
//            roundNeedQuantity), rendered through the CLIENT's composePackName
//   AFTER  — the same functions, given the SHADOW's index and names, plus the
//            containment rule at render
//
// ⚠️ BOTH PASSES ARE DETERMINISTIC. The corpus's own `rendered` lines carry the
// Sonnet pass on top; this compares like with like and therefore does NOT
// reproduce the corpus lines exactly. The census at Part E is what measures the
// real thing. Said here rather than discovered later.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { mergeConvertibleGroups } from "../../src/lib/groceryMerge";
import { roundNeedQuantity } from "../../src/lib/needQuantity";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { EMPTY_RELATION_INDEX, type RelationRow } from "../../src/lib/ingredientRelations";
import { instacartSearchName } from "../../src/lib/retailers/instacartName";
import type { ConsolidatedItem } from "../../src/lib/groceryList";

import {
  buildSubsumesAugmentedIndex,
  shadowDisplayName,
  shadowCanonicalName,
  containmentVerdict,
  packResidue,
} from "./shadow";
import { classifySubsumes, RULED_SUBSUMES_PROMOTIONS } from "./proposals";

// ── the client's render, loaded the way census.ts and B1's preview load it ──
import * as groceryFormatNs from "../../../kiwi/lib/format/grocery.js";
interface GroceryFormat {
  composePackName: (
    name: string,
    purchaseUnit: string | null | undefined,
    purchaseDisplay: string | null | undefined,
    needAmount?: string | number | null,
    needUnit?: string | null,
    isPantryStaple?: boolean,
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
mkdirSync(OUT, { recursive: true });

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

// ── the real relation rows, exactly as relationIndexLoader reads them ───────
const relRows = await prisma.ingredientRelation.findMany({
  select: {
    label: true, yieldQuantity: true, yieldUnit: true, coHarvestable: true,
    confidence: true, reviewedByHuman: true,
    from: { select: { canonicalName: true, defaultUnit: true, purchaseUnit: true } },
    to: { select: { canonicalName: true } },
  },
});
const realRows: RelationRow[] = relRows.map((r) => ({
  label: r.label as RelationRow["label"],
  fromCanonicalName: r.from.canonicalName,
  toCanonicalName: r.to.canonicalName,
  yieldQuantity: r.yieldQuantity,
  yieldUnit: r.yieldUnit,
  coHarvestable: r.coHarvestable,
  confidence: r.confidence as RelationRow["confidence"],
  reviewedByHuman: r.reviewedByHuman,
  fromDefaultUnit: r.from.defaultUnit,
  fromPurchaseUnit: r.from.purchaseUnit,
}));

// ── the LIVE subsumes edge set, the same selection the digest uses ─────────
const usedIds = new Set(
  (await prisma.dishIngredient.groupBy({ by: ["ingredientId"] })).map((u) => u.ingredientId),
);
const subsumesLive = (
  await prisma.ingredientRelation.findMany({
    where: { label: "subsumes" },
    select: {
      fromIngredientId: true, toIngredientId: true, confidence: true, reviewedByHuman: true,
      from: { select: { canonicalName: true } },
      to: { select: { canonicalName: true } },
    },
  })
)
  .filter((r) => usedIds.has(r.fromIngredientId) && usedIds.has(r.toIngredientId))
  .filter((r) => r.reviewedByHuman || r.confidence === "high")
  .map((r) => ({ generic: r.from.canonicalName, specific: r.to.canonicalName }));

// The promotions, added the way RULED_PROMOTIONS is added to the synonym gate:
// a medium, unreviewed row that a RULING has already decided.
for (const p of RULED_SUBSUMES_PROMOTIONS) {
  if (!subsumesLive.some((e) => e.generic === p.generic && e.specific === p.specific)) {
    subsumesLive.push({ generic: p.generic, specific: p.specific });
  }
}

const aug = buildSubsumesAugmentedIndex(realRows, subsumesLive);

// THE VETO, PROVED POSITIVELY. With `salt` classed KEEP the salt family never
// enters the fold, so the never-fold veto has nothing to refuse and reports 0.
// That is the right outcome and a useless test, so this second index forces the
// salt family in and shows the SHIPPED cluster veto refusing it whole.
const vetoProbe = buildSubsumesAugmentedIndex(
  realRows,
  [
    { generic: "salt", specific: "kosher salt" },
    { generic: "salt", specific: "coarse kosher salt" },
    { generic: "salt", specific: "fine sea salt" },
  ],
  true,
);

// The BEFORE index is what production builds today: the real rows only.
const { buildRelationIndex } = await import("../../src/lib/ingredientRelations");
const beforeIndex = buildRelationIndex(realRows);

// ── the corpus ─────────────────────────────────────────────────────────────
const files = readdirSync(CORPUS).filter((f) => f.startsWith("b1__") && f.endsWith(".json")).sort();

type Row = ConsolidatedItem & Record<string, unknown>;

/** The distinct canonical names of one plan's rows that land in a row's group. */
function membersOfGroup(rows: Row[], r: Row): Set<string> {
  const key = aug.index.groupKey(r.canonicalName);
  return new Set(
    rows
      .filter((c) => aug.index.groupKey(c.canonicalName) === key)
      .map((c) => normalizeIngredientName(c.canonicalName)),
  );
}

// canonicalName -> the proposed displayName, for the generic-name lookup above.
const catalogNames = new Map<string, string>();
for (const i of await prisma.ingredient.findMany({
  select: { canonicalName: true, displayName: true },
})) {
  catalogNames.set(i.canonicalName, shadowDisplayName(i.canonicalName, i.displayName, true));
}

/**
 * The generic's own catalog name for a row the SUBSUMES reader moved.
 *
 * TWO conditions, both learned from the dry run:
 *
 *  1. the subsumes reader is what moved it — `aug` and `before` disagree on its
 *     key. Without this the rule also renames rows the SYNONYM reader already
 *     handled correctly at HEAD, and the corpus diff grows by ~175 rows that
 *     nothing in this block is about.
 *  2. the group actually merged. A plan whose only onion is a yellow one has
 *     one row; renaming it "onion" would DELETE the requirement, which is the
 *     mirror of the substitution R5 forbids.
 */
function genericDisplayName(r: Row, groupMembers: Set<string>): string | null {
  const key = aug.index.groupKey(r.canonicalName);
  if (groupMembers.size < 2) return null;
  // ⚠️ "the subsumes reader moved it" is asked of the GROUP, not of the row that
  // survived the merge. On plan 14879176 the survivor is `fresh parsley`, whose
  // key was already "parsley" at HEAD — asking the survivor gives a no, and the
  // line keeps pickRepresentative's "fresh parsley" instead of digest #101's
  // "parsley". The row the reader moved is the OTHER member.
  const moved = [...groupMembers].some((m) => aug.index.groupKey(m) !== beforeIndex.groupKey(m));
  if (!moved) return null;
  return catalogNames.get(key) ?? null;
}

function renderLine(
  name: string,
  r: Row,
  qualifier: string | null,
  applyContainment: boolean,
): string {
  const needText = formatNeedText(String(r.quantity), r.unit, "");
  let packName = composePackName(
    name,
    r.purchaseUnit,
    r.purchaseDisplay,
    r.quantity,
    r.unit,
    r.isUniversalStaple || r.isUserPantryStaple,
  );
  // BUG-160's containment rule.
  //
  // ⚠️ IT RUNS ONLY ON THE SHAPE WHERE THE CLIENT APPENDED THE NAME — that is,
  // where composePackName returned "<pack line> <name>" with a pack line that is
  // more than a bare count. When the client ALREADY elided ("1 Yellow onion"
  // from the pack "1 yellow onion") the prefix is just the count and there is
  // nothing to repair; the first cut of this ignored that and turned "1 Yellow
  // onion" into "1".
  if (applyContainment && r.purchaseDisplay) {
    const nm = name.trim();
    const lower = packName.toLowerCase();
    const tail = ` ${nm.toLowerCase()}`;
    if (lower.endsWith(tail)) {
      const packLine = packName.slice(0, packName.length - nm.length).trim();
      const alreadyElided = /^~?\d+(?:[./]\d+)?$/.test(packLine);
      if (!alreadyElided) {
        const v = containmentVerdict(packResidue(packLine), nm);
        if (v.kind === "drop-name") {
          packName = packLine;
        } else if (v.kind === "name-absorbs") {
          const count = packLine.match(/^~?\d+(?:[./]\d+)?/)?.[0] ?? "";
          packName = count ? `${count} ${nm}` : nm;
        }
      }
    }
  }
  const withQual = qualifier ? `${packName} (${qualifier})` : packName;
  return needText ? `${withQual} (${needText})` : withQual;
}

const L: string[] = [];
L.push("[grocery] B2 — THE DRY RUN · September 28, 2026");
L.push("BEFORE = the real functions at HEAD with the real relation index.");
L.push("AFTER  = the same functions with the subsumes-augmented index, the");
L.push("         proposed names, and the containment rule at render.");
L.push("Both passes are DETERMINISTIC (no Sonnet), so a line here is comparable to");
L.push("the OTHER pass and not to the corpus's own AI-polished line.");
L.push("");

let totalBefore = 0;
let changed = 0;
let identical = 0;
let recurringRows = 0;
let recurringChanged = 0;
const changedLines: string[] = [];
const classOf = new Map<string, number>();

for (const f of files) {
  const j = JSON.parse(readFileSync(join(CORPUS, f), "utf8"));
  const consolidated: Row[] = j.consolidated;

  // ---- BEFORE -----------------------------------------------------------
  const before = mergeConvertibleGroups(
    consolidated.map((r) => ({ ...r })),
    beforeIndex,
  ).map((r) => ({ ...r, quantity: roundNeedQuantity(r.quantity, r.unit) }));

  // ---- AFTER ------------------------------------------------------------
  const renamed: Row[] = consolidated.map((r) => ({
    ...r,
    canonicalName: shadowCanonicalName(r.canonicalName, r.ingredientId != null),
    displayName: shadowDisplayName(r.canonicalName, r.displayName, r.ingredientId != null),
  }));
  const after = mergeConvertibleGroups(renamed, aug.index).map((r) => ({
    ...r,
    quantity: roundNeedQuantity(r.quantity, r.unit),
    // ── R5's "NEVER RENAME THE LINE TO THE SPECIFIC", made operational ──────
    //
    // A REQUIRED Part C change this dry run found rather than assumed.
    // groceryMerge.pickRepresentative takes the SHORTEST canonical name AMONG
    // THE MEMBERS PRESENT. That is right for synonyms — every member is the
    // same thing — and wrong for subsumes: a plan asking for red, green and
    // yellow bell peppers and no plain one gets "4 red bell peppers (at least
    // one green; at least one red; at least one yellow)". The line has been
    // renamed to a specific, which is the one thing R5 forbids.
    //
    // The generic is not a member of the group; it is the GROUP KEY. So the
    // folded line's name comes from the key's own catalog row.
    displayName: genericDisplayName(r, membersOfGroup(renamed, r)) ?? r.displayName,
  }));

  // which qualifiers does each AFTER row carry?
  const qualifierFor = (r: Row): string | null => {
    const key = aug.index.groupKey(r.canonicalName);
    const qs = aug.qualifiersByKey.get(key);
    if (!qs || qs.length === 0) return null;
    // Only the specifics this plan actually asked for.
    const asked = qs.filter((q) =>
      renamed.some((c) => normalizeIngredientName(c.canonicalName) === q.specific),
    );
    if (asked.length === 0) return null;
    // ⚠️ A QUALIFIER ONLY EXISTS WHERE A FOLD HAPPENED. A plan that asks for
    // `yellow onion` and nothing else has one row and nothing to reconcile;
    // the first cut printed "1 yellow onion (at least one yellow)", a tautology
    // on a line that never merged. D-WS9-217 is the same rule from the other
    // side — collapse only when the generic demand has no independent purchase.
    const members = new Set(
      renamed
        .filter((c) => aug.index.groupKey(c.canonicalName) === key)
        .map((c) => normalizeIngredientName(c.canonicalName)),
    );
    if (members.size < 2) return null;
    return [...new Set(asked.map((q) => q.text))].join("; ");
  };

  // ---- the diff, keyed on the BEFORE line ------------------------------
  const beforeLines = before.map((r) => renderLine(r.displayName, r, null, false));
  const afterLines = after.map((r) => renderLine(r.displayName, r, qualifierFor(r), true));

  totalBefore += before.length;
  for (const r of consolidated) if (r.isRecurringItem) recurringRows++;

  // recurring synthetics must be byte-identical
  const recBefore = before.filter((r) => r.isRecurringItem).map((r, i) => renderLine(r.displayName, r, null, false));
  const recAfter = after.filter((r) => r.isRecurringItem).map((r) => renderLine(r.displayName, r, qualifierFor(r), true));
  for (let i = 0; i < Math.max(recBefore.length, recAfter.length); i++) {
    if (recBefore[i] !== recAfter[i]) recurringChanged++;
  }

  // Align by group key so a fold shows as "two lines -> one".
  const bByKey = new Map<string, string>();
  before.forEach((r, i) => bByKey.set(`${normalizeIngredientName(r.canonicalName)}|${r.unit}`, beforeLines[i]));
  const aSeen = new Set<string>();
  const planChanges: string[] = [];

  // rows that survive with the same identity
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  for (let i = 0; i < beforeLines.length; i++) {
    if (afterSet.has(beforeLines[i])) { identical++; continue; }
    changed++;
    // WHICH CLASS moved this row? Checked in the order the classes apply, so a
    // row that both folds and re-cases is counted once, under the fold.
    const r = before[i];
    const key = normalizeIngredientName(r.canonicalName);
    let klass: string;
    if (aug.index.groupKey(r.canonicalName) !== beforeIndex.groupKey(r.canonicalName)) {
      klass = "S · subsumes fold";
    } else {
      const proposed = shadowDisplayName(r.canonicalName, r.displayName, r.ingredientId != null);
      if (proposed.toLowerCase() !== r.displayName.toLowerCase()) klass = "N · buy-name";
      else if (proposed !== r.displayName) klass = "C · casing";
      else klass = "R · residue / other";
    }
    classOf.set(klass, (classOf.get(klass) ?? 0) + 1);
    planChanges.push(`     - [${klass}] ${beforeLines[i]}`);
  }
  for (let i = 0; i < afterLines.length; i++) {
    if (!beforeSet.has(afterLines[i])) planChanges.push(`     + ${afterLines[i]}`);
  }

  if (planChanges.length > 0) {
    L.push(`## ${f.replace(/^b1__|__r1\.json$/g, "")}  (${before.length} -> ${after.length} rows)`);
    L.push(...planChanges);
    L.push("");
    changedLines.push(...planChanges);
  }
}

L.push("=".repeat(78));
L.push(`rows at BEFORE, across the 20 lists   ${totalBefore}`);
L.push(`byte-identical BEFORE -> AFTER        ${identical}`);
L.push(`changed                               ${changed}`);
for (const [k, v] of [...classOf].sort((a, b) => b[1] - a[1])) {
  L.push(`     ${k.padEnd(28)} ${v}`);
}
L.push(`recurring synthetics in the corpus    ${recurringRows}`);
L.push(`recurring synthetics that changed     ${recurringChanged}   (must be 0)`);
L.push("");
L.push(`clusters the NEVER-FOLD veto refused, on the LIVE edge set: ${aug.vetoed.length}`);
L.push(`   (0 is correct: the salt family is class KEEP, so it never enters the fold.)`);
L.push(`veto PROBE, salt forced in: ${vetoProbe.vetoed.length} cluster(s) refused`);
for (const v of vetoProbe.vetoed) L.push(`   ${v}`);
for (const v of aug.vetoed) L.push(`   ${v}`);
L.push("");
L.push(`representatives remapped away from shortest-wins to the generic: ${aug.remapped.length}`);
for (const r of aug.remapped) L.push(`   "${r.from}" -> "${r.to}"`);

// ── the six cases Part A must show ────────────────────────────────────────
L.push("");
L.push("=".repeat(78));
L.push("THE NAMED CASES");
L.push("=".repeat(78));
const NAMED_CASES: [string, string][] = [
  ["bell peppers", "red bell pepper"],
  ["parsley", "fresh flat-leaf parsley"],
  ["chicken thighs", "boneless skinless chicken thighs"],
  ["shredded cheddar cheese", "shredded sharp cheddar cheese"],
  ["salt", "kosher salt"],
  ["crusty bread", "crusty sourdough bread"],
];
for (const [g, s] of NAMED_CASES) {
  const r = classifySubsumes(g, s);
  const kg = aug.index.groupKey(g);
  const ks = aug.index.groupKey(s);
  L.push(`  ${g}  ⊇  ${s}`);
  L.push(`     class ${r.klass} · groupKey(generic)="${kg}" groupKey(specific)="${ks}" · ${kg === ks ? "ONE LINE" : "TWO LINES"}`);
  const q = aug.qualifiersByKey.get(kg)?.find((x) => x.specific === normalizeIngredientName(s));
  if (q) L.push(`     qualifier: "${q.text}"`);
}
L.push("");
L.push("  neutral oil:");
L.push(`     canonical "neutral oil" -> "${shadowCanonicalName("neutral oil", true)}"`);
L.push(`     display   "neutral oil" -> "${shadowDisplayName("neutral oil", "neutral oil", true)}"`);
L.push("");
L.push("  the R7 line / Instacart split (instacartSearchName is ALREADY shipped):");
for (const line of [
  "chicken thighs (bone-in, skin-on)",
  "flour tortillas (large, 10-inch)",
  "bell peppers (at least one red)",
  "long-grain white rice (day-old, cooked)",
]) {
  L.push(`     display_text "${line}"   ->   name "${instacartSearchName(line)}"`);
}
L.push("");
L.push("  the three residue shapes, through the containment rule:");
for (const [pack, name] of [
  ['1 head garlic head', 'garlic head'],
  ['1 rotisserie chicken', 'rotisserie chicken, meat shredded'],
  ['3 medium white onion', 'White onion'],
  ['3 peppers', 'Bell peppers'],
  ['2 limes', 'Lime'],
  ['1 bottle (51 oz)', 'vegetable oil'],
  ['1 head', 'Garlic'],
] as [string, string][]) {
  const res = packResidue(pack);
  L.push(`     pack "${pack}" + name "${name}"  residue "${res}"  ->  ${containmentVerdict(res, name).kind}`);
}

writeFileSync(join(OUT, "preview.txt"), L.join("\n"), "utf8");
console.log(L.join("\n"));
console.log(`\n-> ${join(OUT, "preview.txt")}`);
await prisma.$disconnect();
