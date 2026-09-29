// [grocery] B4 · Part D — THE CORPUS, RE-RUN AT HEAD AND DIFFED. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-census/census.ts \
//        --plans <the 20> --mode live --tag b4 --budget 6
//   node --env-file=.env --import tsx scripts/grocery-b4/after.ts   -> out/after.txt
//
// BEFORE = census tag `b3` (B3·F's after-state). AFTER = tag `b4` (HEAD).
//
// ⚠️ THE CLIENT COMPOSE IS PINNED TO A COMMIT, AND IT HAS TO BE. Block C is
// editing `artifacts/kiwi/lib/format/*` in the same working tree, uncommitted;
// its `packSizeHint` fix alone turns "1 box (12-13 oz)" from an unparseable
// display into one pack and "1 package (10 ct)" into two. A diff that imported
// the live file would attribute their work to this block, in both directions and
// silently. So both sides of this diff render through the version committed at
// `b083ffc`, materialised into scripts/_scratch by:
//
//   git show HEAD:artifacts/kiwi/lib/format/grocery.ts > <scratch>/lib/format/grocery.ts
//   (and lib/format/quantity.ts, lib/quantity.ts — its two imports)
//
// Nothing under artifacts/kiwi is read at runtime here and nothing is written
// there ever. When block C lands, re-pin to that commit and re-run.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { resolveRecurringItems } from "../../src/lib/recurringItems";
import { classifyEdge, distinguishingTokens, H1_TOKENS } from "../../src/lib/subsumesClasses";
import {
  rowConversion, convertToGrams, convertWithinDimension,
  canonicalUnitToken, isCountUnit, unitDimension,
} from "../../src/lib/ingredientConversions";

// the PINNED client compose — see the note above
import * as groceryFormatNs from "../_scratch/grocery-b4/pinned-client/lib/format/grocery";
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
if (typeof G?.composePackName !== "function") throw new Error("pinned client render not loadable");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CORPUS = join(HERE, "..", "grocery-census", "out");
mkdirSync(OUT, { recursive: true });

interface Final {
  sourceKeys: string[]; canonicalName: string; displayName: string;
  quantity: number; unit: string; sectionKey: string;
  isUniversalStaple: boolean; isUserPantryStaple: boolean; isRecurringItem: boolean;
  purchaseUnit: string | null; purchaseQuantity: number | null; purchaseDisplay: string | null;
  packCount?: number | null;
}
interface Cons {
  canonicalName: string; unit: string; conversionRef: unknown;
  purchaseQuantity: number | null; purchaseUnit: string | null;
  packYieldUnit: string | null; packYieldPerPack: number | null;
  recurringFacets?: {
    recurringQuantity: number | null; recurringUnit: string | null;
    mealQuantity: number | null; mealUnit: string | null;
    comparable: boolean; household: boolean;
  };
}
interface Rec {
  planId: string; planTitle: string; userId: string;
  consolidated: Cons[]; final: Final[];
  interceptedWrites: { where: unknown }[]; costUsd?: number;
}

function load(tag: string): Map<string, Rec> {
  const out = new Map<string, Rec>();
  for (const f of readdirSync(CORPUS).filter((x) => x.startsWith(`${tag}__`) && x.endsWith(".json")).sort()) {
    const j = JSON.parse(readFileSync(join(CORPUS, f), "utf8")) as Rec;
    out.set(j.planId.slice(0, 8), j);
  }
  return out;
}

function render(it: Final) {
  const qa = String(it.quantity);
  const qu = it.unit || undefined;
  const staple = it.isUniversalStaple || it.isUserPantryStaple;
  const needText = G.formatNeedText(qa, qu, qu ? `${it.quantity} ${it.unit}` : qa).trim();
  const packName = G.composePackName(it.displayName, it.purchaseUnit ?? undefined, it.purchaseDisplay ?? undefined, qa, qu, staple);
  const rp = G.renderedPack(it.purchaseDisplay ?? undefined, qa, qu, it.purchaseUnit ?? undefined, staple);
  return { line: needText ? `${packName} (${needText})` : packName, packCount: rp?.packCount ?? null };
}

// ── GATE 1, with N12's same-unit rule (ruling 4) ───────────────────────────
type G1 =
  | { ok: boolean; how: string }
  | { ok: null; why: string; detail: string };

function gate1(it: Final, clientPacks: number | null, conv: Cons | undefined): G1 {
  const need = it.quantity;
  if (!(need > 0)) return { ok: null, why: "no need", detail: `quantity ${need}` };
  // ⚠️ THE SERVER'S COUNT FIRST, AND THESE TWO ARE DIFFERENT QUANTITIES.
  // The client's number is a multiplier over what the DISPLAY already says: for
  // a scaled row reading "4 can (14.5 oz)" it returns 1, meaning "one of that".
  // packCount is absolute. Reading the client's as absolute made this gate fail
  // 52 well-ordered rows.
  const packs = it.packCount ?? clientPacks ?? it.purchaseQuantity ?? null;
  if (packs === null || !(packs > 0)) {
    return {
      ok: null, why: "staple / no pack",
      detail: `${it.isUniversalStaple || it.isUserPantryStaple ? "staple" : "no pack"}; purchaseUnit ${it.purchaseUnit ?? "null"}`,
    };
  }
  // ⚠️ THE PER-PACK SIZE COMES FROM THE CONSOLIDATED ROW, NOT THE FINAL ONE.
  // When the server scales a pack it writes the COUNT into the final row's
  // purchaseQuantity, so reading the size off there is wrong exactly when the
  // scaling happened. The pre-scaling row always holds the size, and the corpus
  // carries it. (Guessing instead — "purchaseQuantity === packCount means
  // scaled" — is true of 579 corpus rows of which 71 really are, and made this
  // gate fail three 2 lb packs that order 4 lb and are perfectly correct.)
  const per = conv?.purchaseQuantity ?? it.purchaseQuantity ?? 1;

  // ── N12 (ruling 4) — THE SAME UNIT ON BOTH SIDES IS ARITHMETIC ────────────
  //
  // `bunch` against `bunch` is not a count unit and not a dimension unit, so
  // every other case below declined it and the row counted as unverifiable.
  // 91 rows of the b3 residue are that shape. Free, and a gate fix rather than
  // data: nothing about the list changes, only whether we can check it.
  if (it.purchaseUnit) {
    const nu = canonicalUnitToken(it.unit);
    if (nu.length > 0 && nu === canonicalUnitToken(it.purchaseUnit)) {
      // A SCALED row carries the count in purchaseQuantity, so the per-pack size
      // is one of the pack noun; otherwise purchaseQuantity is the size.
      const bought = packs * per;
      return { ok: bought + 1e-9 >= need, how: `${bought} ${it.unit} vs ${need} (same unit)` };
    }
  }
  if (it.purchaseUnit) {
    const same = convertWithinDimension(packs * per, it.purchaseUnit, it.unit);
    if (same !== null) return { ok: same + 1e-9 >= need, how: `${same.toFixed(3)} ${it.unit} vs ${need}` };
  }
  if (conv?.packYieldPerPack && conv.packYieldUnit) {
    // The yield is per PACK, so it multiplies the absolute pack count — and on
    // an unscaled row also the per-pack size the display states.
    const bought = packs * conv.packYieldPerPack;
    const same = canonicalUnitToken(conv.packYieldUnit) === canonicalUnitToken(it.unit)
      ? bought : convertWithinDimension(bought, conv.packYieldUnit, it.unit);
    if (same !== null) return { ok: same + 1e-9 >= need, how: `${same.toFixed(3)} ${it.unit} via pack yield vs ${need}` };
  }
  if (it.purchaseUnit && isCountUnit(it.purchaseUnit) && isCountUnit(it.unit)) {
    return { ok: packs * per + 1e-9 >= need, how: `${packs * per} vs ${need} (counts)` };
  }
  const c = rowConversion({
    canonicalName: it.canonicalName, conversionRef: conv?.conversionRef ?? null,
    packYieldUnit: conv?.packYieldUnit ?? null, packYieldPerPack: conv?.packYieldPerPack ?? null,
  } as never);
  if (c && it.purchaseUnit) {
    const bg = convertToGrams(packs * per, it.purchaseUnit, c);
    const ng = convertToGrams(need, it.unit, c);
    if (bg !== null && ng !== null) return { ok: bg + 1e-6 >= ng, how: `${bg.toFixed(1)} g vs ${ng.toFixed(1)} g` };
  }
  const pd = unitDimension(it.purchaseUnit ?? "");
  const nd = unitDimension(it.unit);
  const why = /\d\s*[-–]\s*\d/.test(it.purchaseDisplay ?? "")
    ? "range"
    : pd !== nd || pd === null || nd === null
      ? "unit family with no conversion"
      : "other";
  return {
    ok: null, why,
    detail: `pack ${packs} × ${per} ${it.purchaseUnit ?? "?"} vs need ${need} ${it.unit}`,
  };
}

const MEASURE = /\b(\d+(?:\.\d+)?\s*)?(cup|cups|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|lb|lbs|pounds?|g|grams?|kg|ml|l|liters?|quarts?|pints?|gallons?)\b/i;
const gate2 = (line: string) => {
  const m = line.match(/at least[^,()]*/i);
  return m && MEASURE.test(m[0]) ? `"${line}" — "at least" carries a measure` : null;
};
function gate3(line: string, members: string[]): string | null {
  if (members.length < 2) return null;
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      if (classifyEdge(a, b).hClass === "H1" && classifyEdge(b, a).hClass === "H1") {
        const ea = distinguishingTokens(b, a).filter((t) => H1_TOKENS.has(t));
        const eb = distinguishingTokens(a, b).filter((t) => H1_TOKENS.has(t));
        if (ea.length && eb.length) return `"${line}" folds ${a} with ${b} — H1 keeps them apart`;
      }
    }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const B3 = load("b3");
const B4 = load("b4");
const recurringByUser = new Map<string, string[]>(
  (await prisma.userPreferences.findMany({ select: { userId: true, recurringGroceryItems: true } }))
    .map((p) => [p.userId, p.recurringGroceryItems ?? []]),
);

const L: string[] = [];
const say = (s = "") => L.push(s);
say("[grocery] B4 — PART D · THE CORPUS AT HEAD · September 29, 2026");
say("BEFORE = census tag `b3` (B3·F). AFTER = tag `b4` (HEAD).");
say("⚠️ BOTH sides render through the client compose PINNED AT b083ffc, because");
say("   block C is editing that file in this working tree. See the file header.");
say("");

let bRows = 0, aRows = 0, identical = 0, changed = 0, added = 0, removed = 0;
let g1FailNew = 0, g1Fail = 0, g2Fail = 0, g3Fail = 0, g4Fail = 0;
const g1WhyB = new Map<string, number>();
const g1WhyA = new Map<string, number>();
const gateNotes: string[] = [];
const packCountRows: string[] = [];
let withCount = 0, nullCount = 0;
let costB = 0, costA = 0, writesB = 0, writesA = 0;

for (const [plan, b] of B3) {
  const a = B4.get(plan);
  if (!a) { say(`## ${plan} — MISSING from the b4 run`); continue; }
  costB += b.costUsd ?? 0; costA += a.costUsd ?? 0;
  writesB += (b.interceptedWrites ?? []).length;
  writesA += (a.interceptedWrites ?? []).length;

  const key = (it: Final) => `${normalizeIngredientName(it.canonicalName)}|${it.unit}`;
  const bMap = new Map(b.final.map((it) => [key(it), it]));
  const aMap = new Map(a.final.map((it) => [key(it), it]));
  const bCons = new Map(b.consolidated.map((c) => [`${normalizeIngredientName(c.canonicalName)}|${c.unit}`, c]));
  const aCons = new Map(a.consolidated.map((c) => [`${normalizeIngredientName(c.canonicalName)}|${c.unit}`, c]));
  bRows += b.final.length; aRows += a.final.length;

  // gate 1's residue, both sides, so the N12 delta is measured and not claimed
  for (const it of b.final) {
    const v = gate1(it, render(it).packCount, bCons.get(key(it)));
    if (v.ok === null) g1WhyB.set(v.why, (g1WhyB.get(v.why) ?? 0) + 1);
  }

  for (const it of a.final) {
    const r = render(it);
    let conv = aCons.get(key(it));
    if (!conv) for (const k of it.sourceKeys) { const c = aCons.get(k); if (c) { conv = c; break; } }
    const v = gate1(it, r.packCount, conv);
    if (v.ok === null) g1WhyA.set(v.why, (g1WhyA.get(v.why) ?? 0) + 1);
    else if (!v.ok) {
      g1Fail++;
      const before = bMap.get(key(it));
      const wasOk = before ? gate1(before, render(before).packCount, bCons.get(key(it))).ok : null;
      if (wasOk !== false) { g1FailNew++; gateNotes.push(`GATE1-NEW [${plan}] ${r.line} — ${v.how}`); }
      else gateNotes.push(`GATE1 pre-existing [${plan}] ${r.line} — ${v.how}`);
    }
    const g2 = gate2(r.line);
    if (g2) { g2Fail++; gateNotes.push(`GATE2 [${plan}] ${g2}`); }
    const g3 = gate3(r.line, [...new Set(it.sourceKeys.map((k) => k.split("|")[0]))]);
    if (g3) { g3Fail++; gateNotes.push(`GATE3 [${plan}] ${g3}`); }

    // ── the new wire field, every row that carries one ────────────────────
    if (it.packCount != null) {
      withCount++;
      const before = bMap.get(key(it));
      const beforeHad = before?.packCount ?? null;
      packCountRows.push(
        `[${plan}] ${r.line}\n        packCount ${it.packCount}` +
          (beforeHad === null ? "  (BEFORE: none)" : `  (BEFORE: ${beforeHad})`) +
          `  ·  purchaseQuantity ${it.purchaseQuantity ?? "null"} ${it.purchaseUnit ?? ""}` +
          (it.purchaseQuantity === it.packCount ? "  [SCALED: the two are the same number]" : "  [size, not a count]"),
      );
    } else nullCount++;
  }

  // GATE 4 — every recurring text still has a marked row
  for (const res of await resolveRecurringItems(prisma, recurringByUser.get(a.userId) ?? [])) {
    const want = normalizeIngredientName(res.canonicalName ?? res.norm);
    const found = a.final.some((it) => it.isRecurringItem &&
      (normalizeIngredientName(it.canonicalName) === want || normalizeIngredientName(it.displayName) === want));
    if (!found) { g4Fail++; gateNotes.push(`GATE4 [${plan}] "${res.text}" -> ${want}: no AFTER row carries isRecurringItem`); }
  }

  const all = [...new Set([...bMap.keys(), ...aMap.keys()])].sort();
  const lines: string[] = [];
  for (const k of all) {
    const bi = bMap.get(k), ai = aMap.get(k);
    const bl = bi ? render(bi).line : null;
    const al = ai ? render(ai).line : null;
    if (bl !== null && al !== null && bl === al) { identical++; continue; }
    if (bl !== null && al !== null) { changed++; lines.push(`CHANGED\n        before: ${bl}\n        after : ${al}`); }
    else if (bl !== null) { removed++; lines.push(`REMOVED\n        before: ${bl}`); }
    else { added++; lines.push(`ADDED\n        after : ${al}`); }
  }
  say(`## ${plan}  "${a.planTitle}"   ${b.final.length} → ${a.final.length} rows`);
  lines.forEach((s, i) => say(`   ${String(i + 1).padStart(2, "0")}. ${s}`));
  say("");
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((x, y) => x + y, 0);
say("=".repeat(78));
say(`rows   BEFORE ${bRows}   AFTER ${aRows}   (${aRows - bRows})`);
say(`       byte-identical ${identical} · changed ${changed} · added ${added} · removed ${removed}`);
say("");
say("GATES");
say(`  1 — packs × size >= need    FAIL(new) ${g1FailNew} · fail(total) ${g1Fail}`);
say(`      unverifiable  BEFORE ${sum(g1WhyB)}  ->  AFTER ${sum(g1WhyA)}   (${sum(g1WhyA) - sum(g1WhyB)})`);
for (const why of new Set([...g1WhyB.keys(), ...g1WhyA.keys()])) {
  say(`        ${String(g1WhyB.get(why) ?? 0).padStart(4)} -> ${String(g1WhyA.get(why) ?? 0).padStart(4)}   ${why}`);
}
say(`  2 — "at least" + a measure  fail ${g2Fail}`);
say(`  3 — H1 varieties on a line  fail ${g3Fail}`);
say(`  4 — a recurring row keeps its mark  fail ${g4Fail}`);
say(`  VERDICT: ${g1FailNew === 0 && g2Fail === 0 && g3Fail === 0 && g4Fail === 0 ? "PASS" : "FAIL"}`);
say("");
say(`AI spend  BEFORE $${costB.toFixed(4)}  AFTER $${costA.toFixed(4)}`);
say(`intercepted Ingredient writes  BEFORE ${writesB}  AFTER ${writesA}`);
say("");
if (gateNotes.length) { say("## GATE NOTES"); for (const g of gateNotes) say(`   ${g}`); say(""); }
say(`## EVERY ROW CARRYING A packCount (${withCount}; ${nullCount} rows carry null)`);
for (const r of packCountRows) say(`   ${r}`);

writeFileSync(join(OUT, "after.txt"), L.join("\n") + "\n", "utf8");
console.log(L.slice(L.findIndex((x) => x.startsWith("===="))).slice(0, 40).join("\n"));
console.log(`\n-> ${join(OUT, "after.txt")} (${L.length} lines)`);
await prisma.$disconnect();
