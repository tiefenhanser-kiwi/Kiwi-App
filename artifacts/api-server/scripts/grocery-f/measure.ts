// [grocery] F Part A — the measurement, read-only.
//
// Reads the census corpus (a `--tag`'s per-plan .json files, which carry the
// consolidated rows, the final rows AND the rendered lines) and answers the
// questions Part A asks, per finding. Nothing here writes anything.
//
// Usage (from artifacts/api-server):
//   node --env-file=.env --import tsx scripts/grocery-f/measure.ts --tag b4 [--finding F1]

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "scripts", "grocery-census", "out");

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

interface Rendered {
  packName: string;
  needText: string;
  line: string;
  packCount: number | null;
  packSizeText: string | null;
}
interface FinalRow {
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
  packCount: number | null;
}
interface Run {
  planId: string;
  planTitle: string;
  final: FinalRow[];
  rendered: Rendered[];
  consolidated: { canonicalName: string; ingredientId: string | null }[];
}

export interface CorpusRow extends FinalRow {
  planId: string;
  rendered: Rendered;
  idx: number;
}

/** canonicalName → grams per cup, off the corpus's own `conversionRef` payloads.
 *  The densities are the server's persisted ones, not a second table. */
export const DENSITY = new Map<string, number>();

export function loadCorpus(tag: string): CorpusRow[] {
  const index = JSON.parse(
    fs.readFileSync(path.join(OUT, `_index__${tag}.json`), "utf8"),
  ) as { entries: { file: string; planId: string }[] };
  const rows: CorpusRow[] = [];
  for (const e of index.entries) {
    const run = JSON.parse(fs.readFileSync(path.join(OUT, e.file), "utf8")) as Run;
    run.final.forEach((f, i) => {
      rows.push({ ...f, planId: run.planId, rendered: run.rendered[i], idx: i });
    });
    for (const c of run.consolidated as unknown as {
      canonicalName: string;
      conversionRef: { gramsPerCup?: number } | null;
    }[]) {
      const g = c.conversionRef?.gramsPerCup;
      if (typeof g === "number" && g > 0) DENSITY.set(c.canonicalName.toLowerCase(), g);
    }
  }
  return rows;
}

// ── the unit vocabularies, read from the client's own tables ────────────────
const WEIGHT = new Set(["g", "kg", "oz", "lb"]);
const WEIGHT_ALIASES: Record<string, string> = {
  lbs: "lb", pound: "lb", pounds: "lb",
  ounce: "oz", ounces: "oz",
  gram: "g", grams: "g", kilogram: "kg", kilograms: "kg",
};
function wu(unit: string): string | null {
  const s = unit.trim().toLowerCase();
  const c = WEIGHT_ALIASES[s] ?? s;
  return WEIGHT.has(c) ? c : null;
}
const COUNTISH = new Set(["each", "", "count", "ct", "ea"]);

function n(x: number): string {
  return String(parseFloat(x.toFixed(4)));
}

// ─────────────────────────────────────────────────────────────── F1 ─────────
// Fresh meat / poultry / seafood bought BY WEIGHT, with the three exceptions.

/** Exception 1 — packaged meats sold only in fixed packages. */
export const FIXED_PACKAGE_MEATS = [
  "bacon", "sausage", "hot dog", "hotdog", "frankfurter", "bratwurst",
  "chorizo", "kielbasa", "andouille", "deli", "lunch meat", "luncheon meat",
  "pepperoni", "salami", "prosciutto", "pancetta", "capicola", "mortadella",
  "ham steak", "canadian bacon", "turkey bacon",
  "canned tuna", "canned salmon", "tuna in water", "tuna in oil",
  "anchovy", "anchovies", "sardine", "sardines",
];
/** Exception 2 — whole items bought by COUNT. */
export const WHOLE_ITEM_MEATS = [
  "whole chicken", "rotisserie chicken", "whole turkey", "cornish hen",
  "cornish game hen", "whole ham", "spiral ham", "rack of ribs",
  "rack of lamb", "whole duck", "whole fish",
];

function hit(list: string[], name: string): string | null {
  const s = name.toLowerCase();
  for (const k of list) if (s.includes(k)) return k;
  return null;
}

function f1(rows: CorpusRow[]) {
  const meat = rows.filter((r) => r.sectionKey === "meat_seafood");
  const byWeight: CorpusRow[] = [];
  const exFixed: [CorpusRow, string][] = [];
  const exWhole: [CorpusRow, string][] = [];
  const exCount: CorpusRow[] = [];
  const unclassified: CorpusRow[] = [];
  for (const r of meat) {
    const fixed = hit(FIXED_PACKAGE_MEATS, r.canonicalName + " " + r.displayName);
    const whole = hit(WHOLE_ITEM_MEATS, r.canonicalName + " " + r.displayName);
    if (whole) { exWhole.push([r, whole]); continue; }
    if (fixed) { exFixed.push([r, fixed]); continue; }
    if (wu(r.unit)) { byWeight.push(r); continue; }
    if (COUNTISH.has(r.unit.trim().toLowerCase())) { exCount.push(r); continue; }
    unclassified.push(r);
  }
  console.log(`\n══ F1 — meat/poultry/seafood classes (section meat_seafood) ══`);
  console.log(`rows in section .............. ${meat.length}`);
  console.log(`  BY WEIGHT (rule applies) ... ${byWeight.length}`);
  console.log(`  exception 1 fixed package .. ${exFixed.length}`);
  console.log(`  exception 2 whole item ..... ${exWhole.length}`);
  console.log(`  exception 3 count need ..... ${exCount.length}`);
  console.log(`  UNCLASSIFIED ............... ${unclassified.length}`);

  const q = (x: number) => Math.ceil(x * 4 - 1e-9) / 4;
  console.log(`\n  — the by-weight rows, and what the line becomes —`);
  const seen = new Map<string, { cur: string; next: string; n: number }>();
  for (const r of byWeight) {
    const u = wu(r.unit)!;
    const buy = u === "lb" ? q(r.quantity) : r.quantity;
    const next = `${n(buy)} ${u} ${r.displayName}`;
    const k = `${r.rendered.packName}→${next}`;
    const e = seen.get(k);
    if (e) e.n++;
    else seen.set(k, { cur: r.rendered.packName, next, n: 1 });
  }
  let i = 0;
  for (const v of [...seen.values()].sort((a, b) => b.n - a.n)) {
    console.log(`  ${String(++i).padStart(3)}. ×${v.n}  ${v.cur}\n         ->  ${v.next}`);
  }
  if (exFixed.length) {
    console.log(`\n  — exception 1 rows (pack logic KEPT) —`);
    for (const [r, k] of exFixed) console.log(`      [${k}] ${r.rendered.line}`);
  }
  if (exWhole.length) {
    console.log(`\n  — exception 2 rows (count KEPT) —`);
    for (const [r, k] of exWhole) console.log(`      [${k}] ${r.rendered.line}`);
  }
  if (exCount.length) {
    console.log(`\n  — exception 3 rows (count need KEPT) —`);
    for (const r of exCount) console.log(`      ${r.unit}: ${r.rendered.line}`);
  }
  if (unclassified.length) {
    console.log(`\n  🔴 UNCLASSIFIED —`);
    for (const r of unclassified) console.log(`      unit=${r.unit}  ${r.rendered.line}`);
  }
  // non-meat-section rows whose NAME says meat — the misfile risk F4 also covers
  const strays = rows.filter(
    (r) =>
      r.sectionKey !== "meat_seafood" &&
      /\b(chicken|beef|pork|turkey|lamb|shrimp|salmon|cod|tilapia|steak|sausage|bacon)\b/i.test(
        r.displayName,
      ),
  );
  console.log(`\n  — name says protein, section does NOT (${strays.length}) —`);
  for (const r of strays) console.log(`      [${r.sectionKey}] ${r.rendered.line}`);
}

// ─────────────────────────────────────────────────────────────── F2 ─────────
// A buy line with no food name in it.

function f2(rows: CorpusRow[]) {
  console.log(`\n══ F2 — buy lines that print a pack display INSTEAD of the name ══`);
  const bad: CorpusRow[] = [];
  for (const r of rows) {
    const pn = r.rendered.packName;
    // the name is absent when the pack's head noun (minus count/parenthetical)
    // does not contain any word of the displayName
    const nameWords = r.displayName
      .toLowerCase()
      .replace(/[(),]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
    const low = pn.toLowerCase();
    const anyWord = nameWords.some((w) => low.includes(w.replace(/e?s$/, "")));
    if (!anyWord && nameWords.length > 0) bad.push(r);
  }
  console.log(`rows whose buy line contains no word of the name: ${bad.length}`);
  for (const r of bad) {
    console.log(
      `   [${r.sectionKey}] name="${r.displayName}"  pack="${r.purchaseDisplay}"  ->  ${r.rendered.line}`,
    );
  }
  // the specific shape: a parenthetical that NAMES the item, elided against it
  console.log(`\n  — rows whose purchaseDisplay names the food only inside parens —`);
  const paren = rows.filter((r) => {
    const d = r.purchaseDisplay ?? "";
    const m = /\(([^)]*)\)/.exec(d);
    if (!m) return false;
    const inside = m[1].toLowerCase();
    const head = r.displayName.toLowerCase().split(/[\s,]+/).pop() ?? "";
    return head.length > 3 && inside.includes(head.replace(/e?s$/, ""));
  });
  for (const r of paren)
    console.log(`      [${r.sectionKey}] "${r.purchaseDisplay}" + "${r.displayName}"  ->  ${r.rendered.packName}`);
}

// ─────────────────────────────────────────────────────────────── F3 ─────────
// A count need against a count pack that scales past it.

function f3(rows: CorpusRow[]) {
  console.log(`\n══ F3 — a count need, a bigger count ordered ══`);
  const bad = rows.filter((r) => {
    const packs = r.rendered.packCount;
    if (packs === null || packs <= 1) return false;
    const u = r.unit.trim().toLowerCase();
    // a need stated in the SAME container noun the pack is
    const pu = (r.purchaseUnit ?? "").trim().toLowerCase();
    return u === pu || (u === "can" && pu === "can") || /^(can|jar|bottle|box|package|container|bag)$/.test(u);
  });
  console.log(`rows: need in a container noun, packCount > 1 — ${bad.length}`);
  for (const r of bad)
    console.log(
      `   [${r.sectionKey}] need ${n(r.quantity)} ${r.unit} · pack "${r.purchaseDisplay}" (unit ${r.purchaseUnit}, qty ${r.purchaseQuantity}) · packCount ${r.rendered.packCount}\n      ${r.rendered.line}`,
    );
}

// ─────────────────────────────────────────────────────────────── F4 ─────────
// Aisles.

const SECTION_EXPECT: { re: RegExp; want: string; label: string }[] = [
  { re: /\bvinegar\b|\bsoy sauce\b|\bfish sauce\b|\bworcestershire\b|\bhot sauce\b/i, want: "pantry", label: "condiment/vinegar" },
  { re: /\bpoblano\b|\btomatillo|\bjalape|\bserrano\b|\banaheim\b|\bhabanero\b|\bbell pepper/i, want: "produce", label: "fresh chile/produce" },
  { re: /\bcream of (chicken|mushroom|celery)\b|\bcanned\b|\b(diced|crushed|whole) tomatoes\b|\btomato paste\b|\btomato sauce\b|\bbroth\b|\bstock\b|\bbeans\b/i, want: "canned|pantry", label: "canned good" },
];

function f4(rows: CorpusRow[]) {
  console.log(`\n══ F4 — aisles ══`);
  const bySection = new Map<string, number>();
  for (const r of rows) bySection.set(r.sectionKey, (bySection.get(r.sectionKey) ?? 0) + 1);
  console.log(`section histogram: ${[...bySection.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  let total = 0;
  for (const rule of SECTION_EXPECT) {
    const hits = rows.filter((r) => rule.re.test(r.displayName) && !rule.want.split("|").includes(r.sectionKey));
    const uniq = new Map<string, { s: string; n: number }>();
    for (const h of hits) {
      const k = `${h.displayName}|${h.sectionKey}`;
      const e = uniq.get(k);
      if (e) e.n++; else uniq.set(k, { s: h.sectionKey, n: 1 });
    }
    console.log(`\n  ${rule.label} — want ${rule.want} — misfiled rows ${hits.length} (${uniq.size} distinct)`);
    for (const [k, v] of uniq) console.log(`      ×${v.n} [${v.s}] ${k.split("|")[0]}`);
    total += hits.length;
  }
  console.log(`\n  misfiled total: ${total}`);
}

// ─────────────────────────────────────────────────────────────── F5 ─────────
// Words on the line.

function f5(rows: CorpusRow[]) {
  console.log(`\n══ F5 — words on the line ══`);
  const classes: { label: string; test: (r: CorpusRow) => boolean }[] = [
    { label: "5.3  a dozen/count pack against a singular name (`1 dozen egg`)", test: (r) => /\b(dozen|\d+ ?ct|count)\b/i.test(r.rendered.packName) && /\b(egg|bun|tortilla|roll)\b/i.test(r.rendered.packName) },
    { label: "5.4  a DECIMAL in the buy line where a glyph belongs", test: (r) => /(^|\s)\d*\.\d+(\s|$)/.test(r.rendered.packName) },
    { label: "5.5  the recurring annotation, `N each for meals`", test: (r) => /recurring;[^)]*\beach\b/i.test(r.rendered.line) },
    { label: "5.2  a singular COUNT unit above one in the need text", test: (r) => /^\s*(?!1\s)[\d¼½¾⅓⅔⅛⅜⅝⅞.\/ -]+\s+(stalk|sprig|clove|slice|head|piece|ear|fillet|leaf|can|jar|bunch)\s*$/.test(r.rendered.needText) },
  ];
  for (const c of classes) {
    const hits = rows.filter(c.test);
    console.log(`\n  ${c.label} — ${hits.length} rows`);
    const uniq = new Set<string>();
    for (const h of hits) uniq.add(h.rendered.line);
    for (const u of [...uniq].slice(0, 14)) console.log(`      ${u}`);
    if (uniq.size > 14) console.log(`      … ${uniq.size - 14} more distinct`);
  }
}

// ─────────────────────────────────────────────────────────────── F8 ─────────
// Over-size packs outside meat.

function f8(rows: CorpusRow[]) {
  console.log(`\n══ F8 — packs at least 4× the need AND at least 1 lb / 16 oz ══`);
  const G: Record<string, number> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };
  const ML: Record<string, number> = { ml: 1, l: 1000, tsp: 4.92892159375, tbsp: 14.78676478125, cup: 236.5882365, pint: 473.176473, quart: 946.352946, gallon: 3785.411784 };
  const ALIAS: Record<string, string> = {
    lbs: "lb", pound: "lb", pounds: "lb", ounce: "oz", ounces: "oz", "fl oz": "oz",
    cups: "cup", tablespoon: "tbsp", tablespoons: "tbsp", teaspoon: "tsp", teaspoons: "tsp",
    gram: "g", grams: "g", kilogram: "kg", kilograms: "kg", milliliter: "ml", milliliters: "ml", liter: "l", liters: "l",
    pints: "pint", quarts: "quart", gallons: "gallon",
  };
  const norm = (u: string) => { const s = u.trim().toLowerCase(); return ALIAS[s] ?? s; };
  // the pack's own measured size, off the display: a leading measured unit, or a parenthetical
  function packSize(display: string): { amt: number; unit: string } | null {
    const lead = /^\s*([\d.]+)\s+([a-zA-Z]+)(?:\s+([a-zA-Z]+))?/.exec(display);
    if (lead) {
      for (const raw of [lead[3] ? `${lead[2]} ${lead[3]}` : "", lead[2]].filter(Boolean)) {
        const u = norm(raw);
        if (G[u] !== undefined || ML[u] !== undefined) return { amt: parseFloat(lead[1]), unit: u };
      }
    }
    const p = /\(\s*~?\s*([\d.]+)(?:\s*(?:-|–|—|to)\s*[\d.]+)?\s*([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s*(?:each)?\s*\)/.exec(display);
    if (p) {
      const u = norm(p[2]);
      const lq = /^\s*([\d.]+)\s+/.exec(display);
      const mult = lq ? parseFloat(lq[1]) : 1;
      if (G[u] !== undefined || ML[u] !== undefined) return { amt: parseFloat(p[1]) * mult, unit: u };
    }
    return null;
  }
  // ⚠️ THE CROSS-SYSTEM BRIDGE, AND WHY IT IS NOT A GUESS ON THE ROWS THAT
  // MATTER. Hans's own examples are weight PACKS against volume NEEDS ("5 lb bag
  // masa harina (2 tablespoon)"), the exact 315-row class BUG-332 refused to
  // relate at RENDER. Relating them needs a density, which the server holds and
  // which the corpus carries per row (`conversionRef.gramsPerCup`). Where the row
  // has one, the bridge is the server's own number. Where it has none, water
  // (236.6 g/cup) stands in and the row is marked `~` — a report, never a render,
  // and a density error of 2× cannot flip a 150× verdict.
  const WATER_G_PER_CUP = 236.5882365;
  const out: { row: CorpusRow; packG: number; needG: number; ratio: number; sys: string; est: boolean }[] = [];
  for (const r of rows) {
    if (r.isUniversalStaple || r.isUserPantryStaple) continue;
    if (r.sectionKey === "meat_seafood") continue;
    if (!r.purchaseDisplay) continue;
    const ps = packSize(r.purchaseDisplay);
    if (!ps) continue;
    const nu = norm(r.unit);
    const dens = DENSITY.get(r.canonicalName.toLowerCase());
    const est = dens === undefined;
    const gPerCup = dens ?? WATER_G_PER_CUP;
    /** any measured amount → grams, through the row's own density when crossing. */
    const grams = (amt: number, u: string): number | null => {
      if (G[u] !== undefined) return amt * G[u];
      if (ML[u] !== undefined) return (amt * ML[u] / ML.cup) * gPerCup;
      return null;
    };
    const packBase = grams(ps.amt, ps.unit);
    const needBase = grams(r.quantity, nu);
    const sys = G[ps.unit] !== undefined ? "weight" : "volume";
    const crosses = (G[ps.unit] !== undefined) !== (G[nu] !== undefined);
    if (packBase === null || needBase === null || !(needBase > 0)) continue;
    // "at least 1 lb or 16 oz" — one pound of it, however it is measured.
    if (packBase < G.lb) continue;
    const ratio = packBase / needBase;
    if (ratio >= 4) out.push({ row: r, packG: packBase, needG: needBase, ratio, sys, est: est && crosses });
  }
  const uniq = new Map<string, { row: CorpusRow; ratio: number; n: number; sys: string; est: boolean }>();
  for (const o of out) {
    const k = `${o.row.displayName}|${o.row.purchaseDisplay}|${n(o.row.quantity)} ${o.row.unit}`;
    const e = uniq.get(k);
    if (e) e.n++; else uniq.set(k, { row: o.row, ratio: o.ratio, n: 1, sys: o.sys, est: o.est });
  }
  console.log(`rows ${out.length}  ·  distinct ${uniq.size}   (~ = density estimated)`);
  let i = 0;
  for (const v of [...uniq.values()].sort((a, b) => b.ratio - a.ratio)) {
    console.log(
      `  ${String(++i).padStart(3)}. ×${v.n} ${v.est ? "~" : " "}${v.ratio.toFixed(0)}×  [${v.row.sectionKey}] ${v.row.rendered.line}`,
    );
  }
}

// ── the LISTS source — the same rows, read off two persisted dev lists ──────
//
// The corpus is 20 generated plans; the device pass read two PERSISTED lists,
// and three of Hans's F8 examples (masa harina, the 5 lb bag; shredded cheddar;
// the asparagus bunch) are only on those. Same CorpusRow shape, so every finding
// above runs unchanged over either source.
async function loadLists(prefixes: string[]): Promise<CorpusRow[]> {
  const { PrismaClient } = await import("@prisma/client");
  const groceryFormatNs = await import("../../../kiwi/lib/format/grocery.js");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const nsAny = groceryFormatNs as any;
  const G = nsAny.composePackName ? nsAny : nsAny.default;
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
  console.log("host check: PASS (dev branch)");
  const prisma = new PrismaClient();
  const rows: CorpusRow[] = [];
  for (const p of prefixes) {
    const list = await prisma.groceryList.findFirst({
      where: { id: { startsWith: p } },
      include: {
        items: { where: { deletedAt: null }, include: { ingredient: { select: { canonicalName: true, conversionRef: true } } } },
      },
    });
    if (!list) { console.log(`### ${p} NOT FOUND`); continue; }
    list.items.forEach((it, i) => {
      const anyIt = it as unknown as Record<string, any>;
      const canonical = anyIt.ingredient?.canonicalName ?? it.displayName;
      const g = anyIt.ingredient?.conversionRef?.gramsPerCup;
      if (typeof g === "number" && g > 0) DENSITY.set(String(canonical).toLowerCase(), g);
      const staple = it.isUniversalStaple || it.isUserPantryStaple;
      const override = {
        quantity: anyIt.purchaseQuantityOverride ?? null,
        display: anyIt.purchaseDisplayOverride ?? null,
      };
      const packName: string = G.composePackName(
        anyIt.userResolvedTo ?? it.displayName, it.purchaseUnit, it.purchaseDisplay,
        String(it.quantity), it.unit, staple, override,
      );
      const needText: string = G.formatNeedText(String(it.quantity), it.unit || undefined, `${it.quantity} ${it.unit}`.trim());
      const rp = G.renderedPack(
        it.purchaseDisplay, String(it.quantity), it.unit, it.purchaseUnit, staple, override, anyIt.packCount ?? null,
      );
      rows.push({
        canonicalName: String(canonical), displayName: it.displayName,
        quantity: it.quantity, unit: it.unit, sectionKey: it.storeSection,
        isUniversalStaple: it.isUniversalStaple, isUserPantryStaple: it.isUserPantryStaple,
        isRecurringItem: it.isRecurringItem,
        purchaseUnit: it.purchaseUnit, purchaseQuantity: it.purchaseQuantity,
        purchaseDisplay: it.purchaseDisplay, packCount: anyIt.packCount ?? null,
        planId: list.id, idx: i,
        rendered: {
          packName, needText, line: needText ? `${packName} (${needText})` : packName,
          packCount: rp?.packCount ?? null, packSizeText: rp?.packSizeText ?? null,
        },
      });
    });
  }
  await prisma.$disconnect();
  return rows;
}

// ── main ───────────────────────────────────────────────────────────────────
const tag = arg("tag", "b4");
const only = process.argv.includes("--finding") ? arg("finding") : null;
const listArg = process.argv.includes("--lists") ? arg("lists") : null;
const rows = listArg ? await loadLists(listArg.split(",")) : loadCorpus(tag);
console.log(
  listArg
    ? `LISTS ${listArg}  rows=${rows.length}`
    : `corpus tag=${tag}  rows=${rows.length}  plans=${new Set(rows.map((r) => r.planId)).size}`,
);
const table: Record<string, (r: CorpusRow[]) => void> = { F1: f1, F2: f2, F3: f3, F4: f4, F5: f5, F8: f8 };
for (const [k, fn] of Object.entries(table)) if (!only || only === k) fn(rows);
