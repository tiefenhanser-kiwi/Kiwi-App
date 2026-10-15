// CAT-Q0 Pass 1 — the free code checks over every public, non-archived catalog
// meal. READ-ONLY. Prints per-check counts (findings and meals) with two
// examples each, and writes out/pass1.csv (one row per finding).
//
//   node --env-file=.env --import tsx scripts/_scratch/cat-q0/pass1.ts [--examples N] [--seed S]
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { loadCatalog } from "./catalogDb";
import { buildVocab, checkMeal, CLASS_OF, DESCRIBE, type CheckCode, type Finding } from "./checks";
import { mulberry32 } from "./rng";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const EXAMPLES = Number(arg("--examples", "2"));
const SEED = Number(arg("--seed", "20261015"));

const { host, mode } = assertScriptDatabase("cat-q0/pass1");
console.log(`database: ${host} (${mode})`);
const prisma = new PrismaClient();
const meals = await loadCatalog(prisma);
await prisma.$disconnect();
const vocab = buildVocab(meals);
console.log(`${meals.length} catalog meals · ${meals.reduce((a, m) => a + m.dishes.length, 0)} dishes · unlisted-ingredient vocabulary ${vocab.entries.length} rows (used in ≥5 dishes)`);

const findings: Finding[] = meals.flatMap((m) => checkMeal(m, vocab));
const byCode = new Map<CheckCode, Finding[]>();
for (const f of findings) byCode.set(f.code, [...(byCode.get(f.code) ?? []), f]);

const rand = mulberry32(SEED);
const pick = <T>(xs: T[], n: number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };

console.log(`\nexamples drawn at random, seed ${SEED}\n`);
const codes = (Object.keys(CLASS_OF) as CheckCode[]);
for (const c of codes) {
  const fs = byCode.get(c) ?? [];
  const mealsHit = new Set(fs.map((f) => f.mealId)).size;
  console.log(`[${CLASS_OF[c]}] ${c} — ${DESCRIBE[c]}
     ${fs.length} findings in ${mealsHit} meals (${((100 * mealsHit) / meals.length).toFixed(1)}%)`);
  for (const f of pick(fs, EXAMPLES)) console.log(`     · ${f.mealTitle} — ${f.dish} — ${f.where}: ${f.detail}`);
}
const anyHit = new Set(findings.map((f) => f.mealId)).size;
console.log(`\nmeals with any finding: ${anyHit} / ${meals.length}`);

const csvCell = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
const out = join(HERE, "out");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `pass1-${mode}.csv`), ["class,code,mealId,mealTitle,dish,where,detail", ...findings.map((f) => [CLASS_OF[f.code], f.code, f.mealId, f.mealTitle, f.dish, f.where, f.detail].map((x) => csvCell(String(x))).join(","))].join("\n"));
console.log(`→ ${join(out, `pass1-${mode}.csv`)} (${findings.length} rows)`);
