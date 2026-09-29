// [grocery] B2 · Part E — THE CORPUS, RE-RUN AT HEAD AND DIFFED. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-census/census.ts --plans <the 20> --mode live --tag b2 --budget 6
//   node --env-file=.env --import tsx scripts/grocery-census/check.ts  --tag b2
//   node --import tsx            scripts/grocery-b2/after.ts            -> out/after.txt
//
// Reads the census's own output files for tag `b1` (B1's after-state) and tag
// `b2` (HEAD), and diffs them. Nothing is recomputed here — the numbers are the
// pipeline's, produced by the harness whose fences are its own README.
//
// GATES 1-3 run on every CHANGED row:
//   1. packs x pack size >= the need, in the need's dimension
//   2. no "at least" followed by a measure
//   3. no line name or pack display mixes varieties H1 separates

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import {
  classifyEdge,
  distinguishingTokens,
  H1_TOKENS,
  RULED_DEFAULTS,
} from "../../src/lib/subsumesClasses";
import { parseVarietyRider } from "../../src/lib/groceryVarietyRider";
import {
  rowConversion,
  convertToGrams,
  convertWithinDimension,
  canonicalUnitToken,
  isCountUnit,
} from "../../src/lib/ingredientConversions";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CORPUS = join(HERE, "..", "grocery-census", "out");
mkdirSync(OUT, { recursive: true });

interface Row {
  canonicalName: string;
  displayName: string;
  quantity: number;
  unit: string;
  purchaseUnit: string | null;
  purchaseQuantity: number | null;
  purchaseDisplay: string | null;
  isRecurringItem: boolean;
  isUniversalStaple: boolean;
  isUserPantryStaple: boolean;
  conversionRef?: unknown;
  packYieldUnit?: string | null;
  packYieldPerPack?: number | null;
}
interface Rendered { packName: string; needText: string; line: string; packCount: number | null }
interface Run { planId: string; final: Row[]; rendered: Rendered[]; consolidated: Row[] }

function load(tag: string): Map<string, Run> {
  const out = new Map<string, Run>();
  for (const f of readdirSync(CORPUS).filter((x) => x.startsWith(`${tag}__`) && x.endsWith(".json"))) {
    const short = f.replace(new RegExp(`^${tag}__|__r1\\.json$`, "g"), "");
    out.set(short, JSON.parse(readFileSync(join(CORPUS, f), "utf8")) as Run);
  }
  return out;
}

const before = load("b1");
const after = load("b2");

// ── GATE 1 ──────────────────────────────────────────────────────────────────
type Verdict = { ok: boolean | null; detail: string };

function gate1(it: Row, packCount: number | null): Verdict {
  const need = it.quantity;
  if (!(need > 0)) return { ok: true, detail: "no need" };
  const packs = packCount ?? it.purchaseQuantity ?? null;
  if (packs === null || !(packs > 0)) return { ok: null, detail: "no pack count" };
  const conv = rowConversion({
    canonicalName: it.canonicalName,
    conversionRef: it.conversionRef ?? null,
    packYieldUnit: it.packYieldUnit ?? null,
    packYieldPerPack: it.packYieldPerPack ?? null,
    purchaseUnit: it.purchaseUnit,
  } as never);
  if (it.purchaseUnit) {
    const same = convertWithinDimension(packs * (it.purchaseQuantity ?? 1), it.purchaseUnit, it.unit);
    if (same !== null) {
      return { ok: same + 1e-9 >= need, detail: `${same.toFixed(3)} ${it.unit} vs ${need}` };
    }
  }
  if (it.packYieldPerPack && it.packYieldUnit) {
    const bought = packs * it.packYieldPerPack;
    const same =
      canonicalUnitToken(it.packYieldUnit) === canonicalUnitToken(it.unit)
        ? bought
        : convertWithinDimension(bought, it.packYieldUnit, it.unit);
    if (same !== null) {
      return { ok: same + 1e-9 >= need, detail: `${same.toFixed(3)} ${it.unit} via yield vs ${need}` };
    }
  }
  if (it.purchaseUnit && isCountUnit(it.purchaseUnit) && isCountUnit(it.unit)) {
    const bought = packs * (it.purchaseQuantity ?? 1);
    return { ok: bought + 1e-9 >= need, detail: `${bought} vs ${need} (counts)` };
  }
  if (conv && it.purchaseUnit) {
    const bg = convertToGrams(packs * (it.purchaseQuantity ?? 1), it.purchaseUnit, conv);
    const ng = convertToGrams(need, it.unit, conv);
    if (bg !== null && ng !== null) {
      return { ok: bg + 1e-6 >= ng, detail: `${bg.toFixed(1)} g vs ${ng.toFixed(1)} g` };
    }
  }
  return {
    ok: null,
    detail: `unrelatable: ${packs} x ${it.purchaseQuantity ?? "?"} ${it.purchaseUnit ?? "?"} vs ${need} ${it.unit}`,
  };
}

// ── GATE 2 ─────────────────────────────────────────────────────────────────
const MEASURES =
  /\b(cup|cups|tbsp|tablespoon|tablespoons|tsp|teaspoon|teaspoons|oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|ml|l|liter|litre|fl\s?oz|pint|pints|quart|gallon)\b/i;

function gate2(line: string): string | null {
  const re = /at least\s+([^;)]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (MEASURES.test(m[1])) return `"at least${m[1]}" states a measure`;
  }
  return null;
}

// ── GATE 3 ─────────────────────────────────────────────────────────────────
//
// A line may not mix two names H1 keeps apart. The names a line folded are read
// off the BEFORE state: every canonical whose group collapsed into this row.
function gate3(displayName: string, members: string[]): string | null {
  if (members.length < 2) return null;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i];
      const b = members[j];
      const aOverB = distinguishingTokens(a, b).filter((t) => H1_TOKENS.has(t));
      const bOverA = distinguishingTokens(b, a).filter((t) => H1_TOKENS.has(t));
      // Both directions must add an H1 word: that is a SIBLING pair (red vs
      // white onion), not a generic over a specific.
      if (aOverB.length > 0 && bOverA.length > 0) {
        return `"${displayName}" folds ${a} with ${b} — H1 keeps them apart`;
      }
      // …and a generic over an H1 specific is refused too — EXCEPT where that
      // pair is a RULED DEFAULT.
      //
      // ⚠️ THIS EXEMPTION IS THE RULE, NOT A HOLE IN IT, and the gate found the
      // distinction the hard way: it failed `163875ec` on
      // "chicken thighs" + "boneless skinless chicken thighs", which is the fold
      // Hans ruled on September 28. The CLASS says two demanded names stay two
      // lines (H1); the DEFAULT says what the PLAIN name means when nobody said
      // (H2). `admitSubsumes` orders them the same way, and a gate that did not
      // would refuse every default there will ever be.
      const ruledDefault = RULED_DEFAULTS.some(
        (d) =>
          (d.generic === a && d.def === b) || (d.generic === b && d.def === a),
      );
      if (
        !ruledDefault &&
        classifyEdge(a, b).hClass === "H1" &&
        bOverA.length === 0 &&
        aOverB.length > 0
      ) {
        return `"${displayName}" folds the generic ${a} with the H1 specific ${b}`;
      }
    }
  }
  return null;
}

// ── the diff ───────────────────────────────────────────────────────────────

const L: string[] = [];
L.push("[grocery] B2 · Part E — THE CORPUS AT HEAD, DIFFED AGAINST B1 · September 28, 2026");
L.push("");
L.push("BEFORE = census tag `b1` (B1's after-state). AFTER = census tag `b2` (HEAD).");
L.push("Both are the REAL pipeline with the REAL Sonnet pass, through the client's");
L.push("composePackName. Nothing here recomputes a line.");
L.push("");

let rowsBefore = 0;
let identical = 0;
let changedCount = 0;
let recurringBefore = 0;
let recurringChanged = 0;
let recurringPackVariance = 0;
const packNotes: string[] = [];
let g1New = 0;
let g1Pre = 0;
let g1Unver = 0;
let g1UnverNew = 0;
let g2Fail = 0;
let g3Fail = 0;
const gateNotes: string[] = [];
const byClass = new Map<string, number>();
let n = 0;
const changes: string[] = [];

for (const short of [...after.keys()].sort()) {
  const b = before.get(short);
  const a = after.get(short)!;
  if (!b) { L.push(`## ${short} — no BEFORE run`); continue; }

  const bLines = b.rendered.map((r) => r.line);
  const aLines = a.rendered.map((r) => r.line);
  const bSet = new Set(bLines);
  const aSet = new Set(aLines);

  rowsBefore += b.final.length;
  for (const r of b.consolidated) if (r.isRecurringItem) recurringBefore++;

  // ── RECURRING SYNTHETICS — compared on NAME and NEED, not on the whole line ──
  //
  // A synthetic has `ingredientId: null`, which is what makes it synthetic. So
  // `fillPurchaseSizesWithWriteBack` cannot write its gap-fill back, and Haiku
  // re-invents the pack on EVERY generation: the b1 run got "1 bag pet treats" and
  // "1 package (6-pack) paper towels", the b2 run got "1 box" and "(6 rolls)".
  // Comparing whole lines therefore reports B2 moving rows it never touched.
  //
  // What B2 COULD move on a synthetic is the NAME (the casing rule) and the NEED
  // (the fold). Neither can reach one: the casing fix is a CATALOG write and a
  // synthetic has no catalog row, and the fold keys on relations a synthetic has
  // none of. So name+need is the assertion, and the pack variance is counted
  // separately with its cause named. The variance itself is B3's — an ephemeral
  // gap-fill on a row nothing can cache is a defect, just not this block's.
  const recKey = (r: Row) => `${normalizeIngredientName(r.displayName)}|${r.quantity}|${r.unit}`;
  const recB = b.final.filter((r) => r.isRecurringItem).map(recKey).sort();
  const recA = a.final.filter((r) => r.isRecurringItem).map(recKey).sort();
  for (let i = 0; i < Math.max(recB.length, recA.length); i++) {
    if (recB[i] !== recA[i]) {
      recurringChanged++;
      gateNotes.push(`  RECURRING NAME/NEED MOVED [${short}] "${recB[i] ?? "-"}" -> "${recA[i] ?? "-"}"`);
    }
  }
  const recPackB = new Map(b.final.filter((r) => r.isRecurringItem).map((r) => [normalizeIngredientName(r.displayName), r.purchaseDisplay]));
  for (const r of a.final.filter((x) => x.isRecurringItem)) {
    const was = recPackB.get(normalizeIngredientName(r.displayName));
    if (was !== undefined && was !== r.purchaseDisplay) {
      recurringPackVariance++;
      packNotes.push(`  [${short}] "${r.displayName}" pack "${was}" -> "${r.purchaseDisplay}"  (ephemeral Haiku gap-fill; no ingredientId to cache it on)`);
    }
  }

  // which BEFORE canonicals landed on each AFTER row?
  const beforeNames = b.final.map((r) => normalizeIngredientName(r.canonicalName));
  const gone = beforeNames.filter((nm) => !a.final.some((x) => normalizeIngredientName(x.canonicalName) === nm));

  const plan: string[] = [];
  for (let i = 0; i < bLines.length; i++) {
    if (aSet.has(bLines[i])) { identical++; continue; }
    changedCount++;
    plan.push(`     - ${bLines[i]}`);
  }
  for (let i = 0; i < aLines.length; i++) {
    if (bSet.has(aLines[i])) continue;
    const it = a.final[i];
    const nm = normalizeIngredientName(it.canonicalName);
    const { shares } = parseVarietyRider(it.displayName);

    // class
    const bMatch = b.final.find((x) => normalizeIngredientName(x.canonicalName) === nm);
    const klass = shares.length > 0
      ? "S · H3 rider"
      : !bMatch
        ? "S · fold (the name moved)"
        : bMatch.displayName.toLowerCase() !== it.displayName.toLowerCase()
          ? "N · buy-name"
          : bMatch.displayName !== it.displayName
            ? "C · casing"
            : bMatch.purchaseDisplay !== it.purchaseDisplay
              ? "Y · pack (BUG-330)"
              : "R · residue / other";
    byClass.set(klass, (byClass.get(klass) ?? 0) + 1);
    plan.push(`${String(++n).padStart(4)}. + [${klass}] ${aLines[i]}`);

    // ── the gates, on this changed row ──────────────────────────────────
    const v = gate1(it, a.rendered[i].packCount);
    if (v.ok === false) {
      const had = bMatch ? gate1(bMatch, b.rendered[b.final.indexOf(bMatch)]?.packCount ?? null) : null;
      if (had && had.ok === false) {
        g1Pre++;
        gateNotes.push(`  GATE1 fail PRE-EXISTING [${short}] ${aLines[i]} — ${v.detail}`);
      } else {
        g1New++;
        gateNotes.push(`  GATE1 FAIL (NEW) [${short}] ${aLines[i]} — ${v.detail}`);
      }
    } else if (v.ok === null) {
      g1Unver++;
      const had = bMatch ? gate1(bMatch, b.rendered[b.final.indexOf(bMatch)]?.packCount ?? null) : null;
      if (!had || had.ok !== null) {
        g1UnverNew++;
        gateNotes.push(`  GATE1 UNVERIFIABLE (new shape) [${short}] ${aLines[i]} — ${v.detail}`);
      }
    }
    const g2 = gate2(aLines[i]);
    if (g2) { g2Fail++; gateNotes.push(`  GATE2 FAIL [${short}] ${aLines[i]} — ${g2}`); }
    // the members this row absorbed: BEFORE names that vanished and share a stem
    const absorbed = [nm, ...gone.filter((x) => x !== nm && (x.includes(nm) || nm.includes(x)))];
    const g3 = gate3(it.displayName, absorbed);
    if (g3) { g3Fail++; gateNotes.push(`  GATE3 FAIL [${short}] ${g3}`); }
  }

  if (plan.length > 0) {
    L.push(`## ${short}  (${b.final.length} -> ${a.final.length} rows)`);
    L.push(...plan);
    L.push("");
  }
}

L.push("=".repeat(78));
L.push(`rows at BEFORE, across ${after.size} lists   ${rowsBefore}`);
L.push(`byte-identical BEFORE -> AFTER            ${identical}`);
L.push(`changed                                   ${changedCount}`);
for (const [k, v] of [...byClass].sort((x, y) => y[1] - x[1])) {
  L.push(`     ${k.padEnd(28)} ${v}`);
}
L.push(`recurring synthetics in the corpus        ${recurringBefore}`);
L.push(`recurring synthetics, name+need changed   ${recurringChanged}   (must be 0)`);
L.push(`recurring synthetics, PACK re-invented    ${recurringPackVariance}   (Haiku variance, not B2 — see below)`);
L.push("");
L.push("GATES, on every changed row");
L.push(`  Gate 1 — packs x size >= need   FAIL(new) ${g1New} · fail(pre-existing) ${g1Pre} · unverifiable ${g1Unver} (new shape ${g1UnverNew})`);
L.push(`  Gate 2 — "at least" + a measure  FAIL ${g2Fail}`);
L.push(`  Gate 3 — a line mixes H1 kin     FAIL ${g3Fail}`);
const pass = g1New === 0 && g2Fail === 0 && g3Fail === 0 && recurringChanged === 0;
L.push(`  VERDICT: ${pass ? "PASS" : "FAIL"}`);
L.push("");
for (const x of gateNotes) L.push(x);
if (packNotes.length > 0) {
  L.push("");
  L.push("RECURRING PACK VARIANCE — reported, not owned by this block");
  for (const x of packNotes) L.push(x);
}

writeFileSync(join(OUT, "after.txt"), L.join("\n"), "utf8");
console.log(L.join("\n"));
