// [grocery] B3 · Part E — THE CORPUS, RE-RUN AT HEAD AND DIFFED. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-census/census.ts \
//        --plans <the 20> --mode live --tag b3 --budget 6
//   node --import tsx scripts/grocery-b3/after.ts          -> out/after.txt
//
// Reads the census's own output for tag `b2` (B2's after-state) and tag `b3`
// (HEAD) and diffs them. Nothing is recomputed: the numbers are the pipeline's,
// produced by the harness whose fences are its own README.
//
// GATES on the b3 after-state:
//   1. packs × pack size >= the need, in the need's dimension
//   2. no "at least" followed by a measure
//   3. no line mixes varieties H1 keeps apart
//   4. every recurring row still SAYS it is recurring (BUG-225)
//
// ⚠️ GATE 1 IS RUN WITH THE CONVERSION DATA PUT BACK ON THE ROW. The wire shape
// (`GenerateListOutputItem`) carries no `conversionRef` and no pack yield, so a
// gate that reads them off the final row reads `undefined` on every row and
// Cases B and D can never fire. That is what B2's preview2 did, and it is why
// its "unverifiable 241" is not reproducible: the same predicate replayed over
// the b2 corpus calls 803 of 1,041 rows unverifiable, and 731 with the data
// re-attached. Ruling 11 asks for the residue broken down by reason; that
// breakdown is at the end.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { resolveRecurringItems } from "../../src/lib/recurringItems";
import { classifyEdge, distinguishingTokens, H1_TOKENS } from "../../src/lib/subsumesClasses";
import {
  rowConversion,
  convertToGrams,
  convertWithinDimension,
  canonicalUnitToken,
  isCountUnit,
  unitDimension,
} from "../../src/lib/ingredientConversions";

// the CLIENT's own pure compose — the exact code the phone runs
import * as groceryFormatNs from "../../../kiwi/lib/format/grocery.js";
interface GroceryFormat {
  composePackName: (
    name: string, purchaseUnit?: string | null, purchaseDisplay?: string | null,
    needAmount?: string | number | null, needUnit?: string | null, isPantryStaple?: boolean,
  ) => string;
  formatNeedText: (a: string | undefined, u: string | undefined, f: string) => string;
  renderedPack: (
    purchaseDisplay?: string | null, needAmount?: string | null, needUnit?: string | null,
    purchaseUnit?: string | null, isPantryStaple?: boolean,
  ) => { packCount: number; packSizeText: string | null } | null;
}
const ns = groceryFormatNs as unknown as { default?: Partial<GroceryFormat> } & Partial<GroceryFormat>;
const G = (ns.composePackName ? ns : ns.default) as GroceryFormat;
if (typeof G?.composePackName !== "function") throw new Error("client render not loadable");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CORPUS = join(HERE, "..", "grocery-census", "out");
mkdirSync(OUT, { recursive: true });

interface Final {
  sourceKeys: string[];
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
}
interface Cons {
  canonicalName: string;
  unit: string;
  conversionRef: unknown;
  packYieldUnit: string | null;
  packYieldPerPack: number | null;
  sources: unknown[];
  recurringFacets?: {
    recurringQuantity: number | null;
    recurringUnit: string | null;
    mealQuantity: number | null;
    mealUnit: string | null;
    comparable: boolean;
    household: boolean;
  };
}
interface Rec {
  planId: string;
  planTitle: string;
  userId: string;
  consolidated: Cons[];
  final: Final[];
  interceptedWrites: { where: unknown }[];
  costUsd?: number;
}

function load(tag: string): Map<string, Rec> {
  const out = new Map<string, Rec>();
  for (const f of readdirSync(CORPUS).filter((x) => x.startsWith(`${tag}__`) && x.endsWith(".json")).sort()) {
    const j = JSON.parse(readFileSync(join(CORPUS, f), "utf8")) as Rec;
    out.set(j.planId.slice(0, 8), j);
  }
  return out;
}

// ── the render, byte-for-byte the census's ─────────────────────────────────
function render(it: Final) {
  const qa = String(it.quantity);
  const qu = it.unit || undefined;
  const staple = it.isUniversalStaple || it.isUserPantryStaple;
  const needText = G.formatNeedText(qa, qu, qu ? `${it.quantity} ${it.unit}` : String(it.quantity)).trim();
  const packName = G.composePackName(it.displayName, it.purchaseUnit ?? undefined, it.purchaseDisplay ?? undefined, qa, qu, staple);
  const rp = G.renderedPack(it.purchaseDisplay ?? undefined, qa, qu, it.purchaseUnit ?? undefined, staple);
  return {
    line: needText ? `${packName} (${needText})` : packName,
    packCount: rp?.packCount ?? null,
  };
}

// ── GATE 1, with a REASON on every unverifiable row (ruling 11) ────────────
type G1 =
  | { ok: boolean; how: string }
  | { ok: null; why: "staple / no pack" | "no need" | "unit family with no conversion" | "range" | "other"; detail: string };

function gate1(it: Final, packCount: number | null, conv: Cons | undefined): G1 {
  const need = it.quantity;
  if (!(need > 0)) return { ok: null, why: "no need", detail: `quantity ${need}` };
  const packs = packCount ?? it.purchaseQuantity ?? null;
  if (packs === null || !(packs > 0)) {
    return {
      ok: null,
      why: "staple / no pack",
      detail: `${it.isUniversalStaple || it.isUserPantryStaple ? "staple" : "no pack"}; purchaseUnit ${it.purchaseUnit ?? "null"}`,
    };
  }
  const per = it.purchaseQuantity ?? 1;

  // A — the pack is stated in the need's own unit family.
  if (it.purchaseUnit) {
    const same = convertWithinDimension(packs * per, it.purchaseUnit, it.unit);
    if (same !== null) return { ok: same + 1e-9 >= need, how: `${same.toFixed(3)} ${it.unit} vs ${need}` };
  }
  // B — a pack yield names how much of the need ONE pack gives.
  if (conv?.packYieldPerPack && conv.packYieldUnit) {
    const bought = packs * conv.packYieldPerPack;
    const same = canonicalUnitToken(conv.packYieldUnit) === canonicalUnitToken(it.unit)
      ? bought : convertWithinDimension(bought, conv.packYieldUnit, it.unit);
    if (same !== null) return { ok: same + 1e-9 >= need, how: `${same.toFixed(3)} ${it.unit} via pack yield vs ${need}` };
  }
  // C — both sides are bare counts.
  if (it.purchaseUnit && isCountUnit(it.purchaseUnit) && isCountUnit(it.unit)) {
    return { ok: packs * per + 1e-9 >= need, how: `${packs * per} vs ${need} (counts)` };
  }
  // D — grams, if the conversion can express both.
  const c = rowConversion({
    canonicalName: it.canonicalName,
    conversionRef: conv?.conversionRef ?? null,
    packYieldUnit: conv?.packYieldUnit ?? null,
    packYieldPerPack: conv?.packYieldPerPack ?? null,
  } as never);
  if (c && it.purchaseUnit) {
    const bg = convertToGrams(packs * per, it.purchaseUnit, c);
    const ng = convertToGrams(need, it.unit, c);
    if (bg !== null && ng !== null) return { ok: bg + 1e-6 >= ng, how: `${bg.toFixed(1)} g vs ${ng.toFixed(1)} g` };
  }
  // the residue, classified
  const pd = unitDimension(it.purchaseUnit ?? "");
  const nd = unitDimension(it.unit);
  const ranged = /\d\s*[-–]\s*\d/.test(it.purchaseDisplay ?? "");
  const why = ranged
    ? "range"
    : pd !== nd || pd === null || nd === null
      ? "unit family with no conversion"
      : "other";
  return {
    ok: null,
    why,
    detail: `pack ${packs} × ${per} ${it.purchaseUnit ?? "?"} (${pd ?? "count/pack-noun"}) vs need ${need} ${it.unit} (${nd ?? "count/pack-noun"})`,
  };
}

const MEASURE = /\b(\d+(?:\.\d+)?\s*)?(cup|cups|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|lb|lbs|pounds?|g|grams?|kg|ml|l|liters?|quarts?|pints?|gallons?)\b/i;
function gate2(line: string): string | null {
  // ⚠️ THE RIDER ENDS AT THE NEED, AND THE FIRST VERSION OF THIS DETECTOR DID
  // NOT. `[^,)]*` ran past the opening bracket of the client's need suffix, so
  // "4 can (14.5 oz) chicken broth, at least 1 low-sodium (6 cup)" was read as
  // the rider "at least 1 low-sodium (6 cup" and reported as a measure. The
  // rider is "at least 1 low-sodium" — a count, which is the whole point of
  // stating shares in the line's buy unit. Excluding `(` as well as `,` and `)`
  // is what makes the detector measure the rider rather than the sentence.
  const m = line.match(/at least[^,()]*/i);
  return m && MEASURE.test(m[0]) ? `"${line}" — "at least" carries a measure` : null;
}
function gate3(line: string, members: string[]): string | null {
  if (members.length < 2) return null;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      if (classifyEdge(a, b).hClass === "H1" && classifyEdge(b, a).hClass === "H1") {
        const ea = distinguishingTokens(b, a).filter((t) => H1_TOKENS.has(t));
        const eb = distinguishingTokens(a, b).filter((t) => H1_TOKENS.has(t));
        if (ea.length && eb.length) return `"${line}" folds ${a} with ${b} — H1 keeps them apart`;
      }
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Gate 4 asks the RESOLVER where each recurring text landed, so this one script
// reads the database. Read-only, and the same dev fence as every other file here.
const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const B2 = load("b2");
const B3 = load("b3");

const recurringByUser = new Map<string, string[]>(
  (
    await prisma.userPreferences.findMany({ select: { userId: true, recurringGroceryItems: true } })
  ).map((p) => [p.userId, p.recurringGroceryItems ?? []]),
);

const L: string[] = [];
const say = (s = "") => L.push(s);

say("[grocery] B3 — PART E · THE CORPUS AT HEAD · September 29, 2026");
say("BEFORE = census tag `b2` (B2's after-state). AFTER = census tag `b3` (HEAD).");
say("Both are the REAL pipeline: consolidate → gap-fill (Haiku) → final (Sonnet)");
say("→ the client's composePackName. No number here is recomputed.");
say("");

let bRows = 0, aRows = 0, identical = 0, changed = 0, added = 0, removed = 0;
let bRec = 0, aRec = 0;
let g1Fail = 0, g1FailNew = 0, g2Fail = 0, g3Fail = 0, g4Fail = 0;
const g1Why = new Map<string, number>();
const g1Examples = new Map<string, string[]>();
const gateNotes: string[] = [];
const changeLines: string[] = [];
const recurringLedger: string[] = [];
let costB = 0, costA = 0;
let writesB = 0, writesA = 0;
const writeIdsB = new Set<string>();
const writeIdsA = new Set<string>();

for (const [plan, b] of B2) {
  const a = B3.get(plan);
  if (!a) { say(`## ${plan} — MISSING from the b3 run`); continue; }
  costB += b.costUsd ?? 0;
  costA += a.costUsd ?? 0;
  for (const w of b.interceptedWrites ?? []) { writesB++; writeIdsB.add(JSON.stringify(w.where)); }
  for (const w of a.interceptedWrites ?? []) { writesA++; writeIdsA.add(JSON.stringify(w.where)); }

  const key = (it: Final) => `${normalizeIngredientName(it.canonicalName)}|${it.unit}`;
  const bMap = new Map(b.final.map((it) => [key(it), it]));
  const aMap = new Map(a.final.map((it) => [key(it), it]));
  const aCons = new Map(a.consolidated.map((c) => [`${normalizeIngredientName(c.canonicalName)}|${c.unit}`, c]));
  bRows += b.final.length;
  aRows += a.final.length;
  bRec += b.final.filter((it) => it.isRecurringItem).length;
  aRec += a.final.filter((it) => it.isRecurringItem).length;

  // gates, on the AFTER list
  for (const it of a.final) {
    const r = render(it);
    let conv = aCons.get(key(it));
    if (!conv) for (const k of it.sourceKeys) { const c = aCons.get(k); if (c) { conv = c; break; } }
    const v = gate1(it, r.packCount, conv);
    if (v.ok === null) {
      g1Why.set(v.why, (g1Why.get(v.why) ?? 0) + 1);
      const ex = g1Examples.get(v.why) ?? [];
      if (ex.length < 6) { ex.push(`[${plan}] ${r.line} — ${v.detail}`); g1Examples.set(v.why, ex); }
    } else if (!v.ok) {
      g1Fail++;
      const before = bMap.get(key(it));
      let wasOk: boolean | null = null;
      if (before) {
        const br = render(before);
        const bv = gate1(before, br.packCount, conv);
        wasOk = bv.ok;
      }
      if (wasOk !== false) { g1FailNew++; gateNotes.push(`GATE1-NEW [${plan}] ${r.line} — ${v.how}`); }
      else gateNotes.push(`GATE1 pre-existing [${plan}] ${r.line} — ${v.how}`);
    }
    const g2 = gate2(r.line);
    if (g2) { g2Fail++; gateNotes.push(`GATE2 [${plan}] ${g2}`); }
    const g3 = gate3(r.line, [...new Set(it.sourceKeys.map((k) => k.split("|")[0]))]);
    if (g3) { g3Fail++; gateNotes.push(`GATE3 [${plan}] ${g3}`); }
    if (it.isRecurringItem) {
      const f = conv?.recurringFacets;
      recurringLedger.push(
        `[${plan}] ${r.line}` +
          (f
            ? `   ·  recurring ${f.recurringQuantity ?? "-"} ${f.recurringUnit ?? "-"}` +
              (f.mealQuantity !== null ? ` · meals ${f.mealQuantity} ${f.mealUnit}` : " · plan needs none") +
              (f.comparable ? " · SUMMED" : " · display-both") +
              (f.household ? " · household" : "")
            : "   ·  (no facets)"),
      );
    }
  }

  // ── GATE 4 — no recurring row loses its "recurring" mark (BUG-225) ────────
  //
  // ⚠️ MEASURED PER TEXT, THROUGH THE RESOLVER, AND THE FIRST VERSION OF THIS
  // DETECTOR WAS WRONG. It compared the BEFORE row's name to the AFTER row's by
  // four-character prefix, and reported 33 failures that are the block working:
  // `eggs` → `large eggs`, `milk` → `whole milk`, `bread` → `sandwich bread`
  // share no prefix, which is the entire point of resolving. A prefix comparison
  // lies about a rename every time.
  //
  // The honest question is the user's: "is each thing I said I always buy on
  // this list, and does the list say it is a recurring item?" So the test walks
  // the user's own recurring TEXTS and asks the resolver where each one landed.
  const texts = recurringByUser.get(a.userId) ?? [];
  for (const res of await resolveRecurringItems(prisma, texts)) {
    const want = res.canonicalName ?? res.norm;
    const found = a.final.some(
      (it) =>
        it.isRecurringItem &&
        (normalizeIngredientName(it.canonicalName) === normalizeIngredientName(want) ||
          normalizeIngredientName(it.displayName) === normalizeIngredientName(want)),
    );
    if (!found) {
      g4Fail++;
      gateNotes.push(`GATE4 [${plan}] "${res.text}" → ${want}: no AFTER row carries isRecurringItem`);
    }
  }

  // the diff
  const all = [...new Set([...bMap.keys(), ...aMap.keys()])].sort();
  const planLines: string[] = [];
  for (const k of all) {
    const bi = bMap.get(k), ai = aMap.get(k);
    const bl = bi ? render(bi).line : null;
    const al = ai ? render(ai).line : null;
    if (bl !== null && al !== null && bl === al) { identical++; continue; }
    if (bl !== null && al !== null) { changed++; planLines.push(`CHANGED\n        before: ${bl}\n        after : ${al}`); }
    else if (bl !== null) { removed++; planLines.push(`REMOVED\n        before: ${bl}`); }
    else { added++; planLines.push(`ADDED\n        after : ${al}`); }
  }
  say(`## ${plan}  "${a.planTitle}"   ${b.final.length} → ${a.final.length} rows`);
  planLines.forEach((s, i) => say(`   ${String(i + 1).padStart(2, "0")}. ${s}`));
  say("");
}

say("=".repeat(78));
say(`rows   BEFORE ${bRows}   AFTER ${aRows}   (${aRows - bRows})`);
say(`       byte-identical ${identical} · changed ${changed} · added ${added} · removed ${removed}`);
say(`recurring-marked rows  BEFORE ${bRec}   AFTER ${aRec}`);
say("");
say("GATES");
say(`  1 — packs × size >= need    FAIL(new) ${g1FailNew} · fail(total) ${g1Fail} · unverifiable ${[...g1Why.values()].reduce((a, b) => a + b, 0)}`);
say(`  2 — "at least" + a measure  fail ${g2Fail}`);
say(`  3 — H1 varieties on a line  fail ${g3Fail}`);
say(`  4 — a recurring row keeps its mark  fail ${g4Fail}`);
say(`  VERDICT: ${g1FailNew === 0 && g2Fail === 0 && g3Fail === 0 && g4Fail === 0 ? "PASS" : "FAIL"}`);
say("");
say("## RULING 11 — GATE 1's UNVERIFIABLE RESIDUE, BY REASON");
say("   (no fix in this block; this is what the gate actually covers)");
for (const [why, n] of [...g1Why.entries()].sort((a, b) => b[1] - a[1])) {
  say(`   ${String(n).padStart(4)}  ${why}`);
  for (const e of g1Examples.get(why) ?? []) say(`          ${e}`);
}
say("");
say("## COST AND CATALOG WRITES");
say(`   AI spend for the 20 lists:  BEFORE $${costB.toFixed(4)}   AFTER $${costA.toFixed(4)}`);
say(`   intercepted Ingredient writes: BEFORE ${writesB} (${writeIdsB.size} ids)   AFTER ${writesA} (${writeIdsA.size} ids)`);
const newIds = [...writeIdsA].filter((i) => !writeIdsB.has(i));
say(`   ids written AFTER but not BEFORE: ${newIds.length}${newIds.length ? " -> " + newIds.join(", ") : "  (ruling 6: 0 recurring-caused catalog writes)"}`);
say("");
if (gateNotes.length) { say("## GATE NOTES"); for (const g of gateNotes) say(`   ${g}`); say(""); }
say(`## THE RECURRING ROWS, AFTER, IN FULL (${recurringLedger.length})`);
for (const r of recurringLedger) say(`   ${r}`);

writeFileSync(join(OUT, "after.txt"), L.join("\n") + "\n", "utf8");
console.log(L.slice(L.findIndex((x) => x.startsWith("====")))
  .slice(0, 70).join("\n"));
console.log(`\n-> ${join(OUT, "after.txt")}  (${L.length} lines)`);
