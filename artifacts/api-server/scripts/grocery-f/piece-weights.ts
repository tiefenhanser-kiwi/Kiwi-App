// [grocery] F Part B / D-WS9-292 exception 3 — WHERE A PIECE WEIGHT COMES FROM.
//
// Hans amended exception 3: a COUNT need of a fresh cut converts to weight —
// "a chicken breast is probably 1/2 lb on average, so 4 breasts = 2 lbs". This
// script finds every defensible piece weight the project ALREADY HOLDS, so the
// curated table added in Part B is as small as the data allows.
//
// Three sources, in precedence order:
//   1. `conversionRef.gramsPerEach` — the catalog's own per-each weight.
//   2. A catalog PACK DISPLAY that states a weight AND a piece count:
//      "2 lb pack (4 chops)" is 0.5 lb a chop. The catalog authored both halves
//      of that string, so dividing them is reading the data, not guessing.
//   3. Nothing — the cut stays a count and is listed.
//
// Read-only.  node --env-file=.env --import tsx scripts/grocery-f/piece-weights.ts

import { PrismaClient } from "@prisma/client";

const G_PER_LB = 453.59237;

/** Piece nouns a pack parenthetical uses to state how many are in it. */
const PIECE_NOUN =
  "chops?|steaks?|fillets?|filets?|breasts?|thighs?|drumsticks?|wings?|" +
  "cutlets?|tenderloins?|racks?|pieces?|legs?|links?|patties|patty|" +
  "slices?|strips?|shanks?|ribs?|roasts?|portions?";

/** "2 lb pack (4 chops)" → { lb: 2, pieces: 4 }. Null when it states only one. */
export function packWeightAndPieces(
  display: string,
): { lb: number; pieces: number; how: string } | null {
  const w = /(\d+(?:\.\d+)?)\s*(lb|lbs|pound|pounds|oz|ounce|ounces)\b/i.exec(display);
  const p = new RegExp(`\\(\\s*~?\\s*(\\d+)\\s*(?:${PIECE_NOUN})\\b`, "i").exec(display);
  if (!w || !p) return null;
  const amt = parseFloat(w[1]);
  const lb = /^o/i.test(w[2]) ? amt / 16 : amt;
  const pieces = parseInt(p[1], 10);
  if (!(lb > 0) || !(pieces > 0)) return null;
  return { lb, pieces, how: `"${display}" → ${lb} lb ÷ ${pieces}` };
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
  console.log("host check: PASS (dev branch)");
  const prisma = new PrismaClient();
  const rows = await prisma.ingredient.findMany({
    where: { category: "Protein" },
    select: {
      canonicalName: true, displayName: true, defaultUnit: true,
      purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
      conversionRef: true,
    },
    orderBy: { canonicalName: "asc" },
  });
  console.log(`\nProtein catalog rows: ${rows.length}`);

  const fromGpe: string[] = [];
  const fromPack: { name: string; lbPerPiece: number; how: string }[] = [];
  for (const r of rows) {
    const c = r.conversionRef as { gramsPerEach?: number } | null;
    if (typeof c?.gramsPerEach === "number" && c.gramsPerEach > 0) {
      fromGpe.push(`  ${r.canonicalName} — ${c.gramsPerEach} g = ${(c.gramsPerEach / G_PER_LB).toFixed(3)} lb`);
      continue;
    }
    const d = r.purchaseDisplay ?? "";
    const hit = packWeightAndPieces(d);
    if (hit) fromPack.push({ name: r.canonicalName, lbPerPiece: hit.lb / hit.pieces, how: hit.how });
  }
  console.log(`\n── source 1: conversionRef.gramsPerEach (${fromGpe.length}) ──`);
  for (const l of fromGpe) console.log(l);
  if (fromGpe.length === 0) console.log("  (none — no Protein row carries one)");

  console.log(`\n── source 2: a pack display stating BOTH a weight and a piece count (${fromPack.length}) ──`);
  for (const f of fromPack.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${f.lbPerPiece.toFixed(3)} lb/piece   ${f.name.padEnd(46)} ${f.how}`);
  }

  // What the derived weights say per CUT FAMILY — the evidence a curated row
  // would rest on.
  const FAMILY: [RegExp, string][] = [
    [/\bchicken breast|breasts?\b/i, "chicken breast"],
    [/\bchicken thigh|thighs?\b/i, "chicken thigh"],
    [/\bpork chop|chops?\b/i, "pork chop"],
    [/\bdrumstick/i, "chicken drumstick"],
    [/\bcutlet/i, "cutlet"],
    [/\b(salmon|cod|tilapia|halibut).*fill?et|fill?ets?\b/i, "fish fillet"],
    [/\bsteak/i, "steak"],
    [/\bwing/i, "chicken wing"],
  ];
  const byFam = new Map<string, number[]>();
  for (const f of fromPack) {
    for (const [re, fam] of FAMILY) {
      if (re.test(f.name)) {
        const l = byFam.get(fam); if (l) l.push(f.lbPerPiece); else byFam.set(fam, [f.lbPerPiece]);
        break;
      }
    }
  }
  console.log(`\n── per cut family, from source 2 ──`);
  for (const [fam, vals] of byFam) {
    const sorted = [...vals].sort((a, b) => a - b);
    console.log(
      `  ${fam.padEnd(20)} n=${String(vals.length).padStart(2)}  min ${sorted[0].toFixed(3)}  median ${sorted[Math.floor(sorted.length / 2)].toFixed(3)}  max ${sorted[sorted.length - 1].toFixed(3)} lb`,
    );
  }

  // Which Protein rows are reached by a COUNT need — the rows the rule must serve.
  const countish = rows.filter((r) => ["each", "", "count", "ct", "piece", "whole"].includes((r.defaultUnit ?? "").trim().toLowerCase()));
  console.log(`\n── Protein rows whose defaultUnit is a COUNT (${countish.length}) ──`);
  for (const r of countish) {
    const hit = packWeightAndPieces(r.purchaseDisplay ?? "");
    console.log(`  ${hit ? (hit.lb / hit.pieces).toFixed(3) + " lb" : "   —   "}  ${r.canonicalName.padEnd(50)} pack="${r.purchaseDisplay ?? ""}"`);
  }
  await prisma.$disconnect();
}
if (process.argv[1]?.includes("piece-weights")) main().catch((e) => { console.error(e); process.exit(1); });
