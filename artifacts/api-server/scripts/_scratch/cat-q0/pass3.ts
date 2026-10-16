// CAT-Q0 Pass 3 — the instrument check, before any of Pass 2 is trusted.
// READ-ONLY on data (the plants are in-memory clones). AI spend capped by
// --ceiling (default $3, across every run: out/spend.json is cumulative).
//
//   node --env-file=.env --import tsx scripts/_scratch/cat-q0/pass3.ts [--limit N] [--ceiling 3] [--seed 1015] [--recall-only] [--tag T]
//
//   recall    10 random catalog meals (seed), one plant each (plants.ts), run
//             planted AND clean; a plant is caught when an issue on the planted
//             dish names it. The free Pass 1 checks run on the same pairs.
//   precision every meal of the five everyday featured-* plans + 30 random
//             catalog meals (seed; featured and recall meals excluded) — every
//             block and fix issue printed verbatim for a human read.
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { loadCatalog, loadFeaturedMealIds, type CatMeal } from "./catalogDb";
import { buildVocab, checkMeal } from "./checks";
import { clone, PLANTS, type Planted } from "./plants";
import { mulberry32, shuffled } from "./rng";
import { userMessage, type ReviewIssue } from "./rubric";
import { OUT, runReviews, spentSoFar, type ReviewJob, type ReviewRecord } from "./reviewRunner";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SEED = Number(arg("--seed", "1015"));
const CEILING = Number(arg("--ceiling", "3"));
const LIMIT = Number(arg("--limit", "0"));
const RECALL_ONLY = process.argv.includes("--recall-only");
const TAG = arg("--tag", "");
const PILOT_RANDOM = 30;

const lines: string[] = [];
const say = (s = "") => { console.log(s); lines.push(s); };

const { host, mode } = assertScriptDatabase("cat-q0/pass3");
say(`database: ${host} (${mode}) · seed ${SEED} · ceiling $${CEILING}`);
const prisma = new PrismaClient();
const meals = await loadCatalog(prisma);
const featured = (await loadFeaturedMealIds(prisma)).filter((t) => !t.anchored);
await prisma.$disconnect();
const byId = new Map(meals.map((m) => [m.id, m]));
const featuredIds = [...new Set(featured.flatMap((t) => t.mealIds))].filter((id) => byId.has(id));
say(`catalog ${meals.length} meals · everyday featured-* plans ${featured.map((t) => t.templateId).join(", ")} → ${featuredIds.length} meals`);

// ── recall: plants ──────────────────────────────────────────────────────────
const rand = mulberry32(SEED);
const pool = shuffled(meals.filter((m) => !featuredIds.includes(m.id) && m.dishes.every((d) => d.steps.length > 0)), rand);
const used = new Set<string>();
const recall: Array<{ plantId: string; cls: number; clean: CatMeal; planted: CatMeal; info: Planted }> = [];
for (const p of PLANTS) {
  const m = pool.find((x) => !used.has(x.id) && p.fits(x));
  if (!m) { say(`  plant ${p.id}: no meal fits`); continue; }
  used.add(m.id);
  const planted = clone(m);
  const info = p.apply(planted);
  recall.push({ plantId: p.id, cls: p.cls, clean: m, planted, info });
}
say(`\nrecall set (${recall.length} meals, drawn in seeded order, first fit per plant):`);
for (const r of recall) say(`  [class ${r.cls}] ${r.plantId.padEnd(16)} ${r.clean.title} — ${r.info.dish}: ${r.info.described}`);

// The free checks on the same pairs: which plants does Pass 1 see?
const vocab = buildVocab(meals);
say(`\nPass 1 (free code checks) on the planted vs clean pairs — findings new in the planted copy:`);
for (const r of recall) {
  const key = (f: { code: string; dish: string; where: string; detail: string }) => `${f.code}|${f.dish}|${f.where}|${f.detail}`;
  const before = new Set(checkMeal(r.clean, vocab).map(key));
  const fresh = checkMeal(r.planted, vocab).filter((f) => !before.has(key(f)));
  say(`  ${r.plantId.padEnd(16)} ${fresh.length ? fresh.map((f) => `${f.code}: ${f.detail.slice(0, 90)}`).join(" | ") : "— nothing"}`);
}

// ── precision: the pilot ────────────────────────────────────────────────────
const pilotRand = mulberry32(SEED + 1);
const randomPilot = shuffled(meals.filter((m) => !featuredIds.includes(m.id) && !used.has(m.id)), pilotRand).slice(0, PILOT_RANDOM);
const pilot = [...featuredIds.map((id) => ({ tag: "featured", m: byId.get(id)! })), ...randomPilot.map((m) => ({ tag: "random", m }))];
say(`\npilot: ${featuredIds.length} featured + ${randomPilot.length} random (seed ${SEED + 1}, featured and recall meals excluded)`);

// ── the calls ───────────────────────────────────────────────────────────────
let jobs: ReviewJob[] = [
  ...recall.map((r) => ({ label: `plant:${r.plantId}`, mealId: r.clean.id, title: r.clean.title, userMsg: userMessage(r.planted) })),
  ...recall.map((r) => ({ label: `clean:${r.plantId}`, mealId: r.clean.id, title: r.clean.title, userMsg: userMessage(r.clean) })),
  ...(RECALL_ONLY ? [] : pilot.map((p) => ({ label: p.tag, mealId: p.m.id, title: p.m.title, userMsg: userMessage(p.m) }))),
];
if (LIMIT > 0) jobs = jobs.slice(0, LIMIT);
const t0 = Date.now();
const recs = await runReviews(jobs, { ceilingUsd: CEILING, concurrency: 4 });
say(`\nwall clock ${((Date.now() - t0) / 1000).toFixed(0)} s · cumulative spend $${spentSoFar().toFixed(4)}`);
const rec = (label: string, mealId: string) => recs.find((x) => x && x.label === label && x.mealId === mealId);

const fmt = (i: ReviewIssue) => `[${i.severity} · class ${i.class}] ${i.dish}${i.ingredient ? ` · ingredient "${i.ingredient}"` : ""}${i.stepIndex != null ? ` · step ${i.stepIndex}` : ""}\n        quote: "${i.quote}"\n        why:   ${i.why}\n        fix:   ${i.fix}`;

// ── recall report ───────────────────────────────────────────────────────────
say(`\n═══ RECALL — seeded defects ═══`);
let caught = 0, done = 0;
for (const r of recall) {
  const pr = rec(`plant:${r.plantId}`, r.clean.id);
  if (!pr?.ok) { say(`  ${r.plantId}: not reviewed (${pr?.error ?? "skipped"})`); continue; }
  done++;
  const plant = PLANTS.find((p) => p.id === r.plantId)!;
  const hits = pr.review!.issues.filter((i) => plant.caught(i, r.info));
  if (hits.length) caught++;
  say(`  ${hits.length ? "CAUGHT" : "MISSED"} ${r.plantId} (class ${r.cls}) — verdict ${pr.review!.verdict}, ${pr.review!.issues.length} issues`);
  for (const h of hits) say(`      ${fmt(h)}`);
  if (!hits.length) for (const i of pr.review!.issues) say(`      (other) ${fmt(i)}`);
}
say(`\nrecall: ${caught}/${done}`);

say(`\n═══ CLEAN TWINS — what it flagged on the unplanted originals ═══`);
for (const r of recall) {
  const cr = rec(`clean:${r.plantId}`, r.clean.id);
  if (!cr?.ok) { say(`  ${r.clean.title}: not reviewed`); continue; }
  say(`  ${r.clean.title} — verdict ${cr.review!.verdict}, ${cr.review!.issues.length} issues`);
  for (const i of cr.review!.issues) say(`      ${fmt(i)}`);
}

// ── pilot report ────────────────────────────────────────────────────────────
say(`\n═══ PILOT — verdicts ═══`);
const pilotRecs = pilot.map((p) => ({ p, r: rec(p.tag, p.m.id) })).filter((x) => x.r?.ok) as Array<{ p: (typeof pilot)[number]; r: ReviewRecord }>;
for (const tag of ["featured", "random", "all"]) {
  const xs = pilotRecs.filter((x) => tag === "all" || x.p.tag === tag);
  const v = (k: string) => xs.filter((x) => x.r.review!.verdict === k).length;
  const sev = (k: string) => xs.reduce((a, x) => a + x.r.review!.issues.filter((i) => i.severity === k).length, 0);
  say(`  ${tag.padEnd(8)} ${xs.length} meals: ok ${v("ok")} · fix ${v("fix")} · block ${v("block")} — issues: block ${sev("block")} · fix ${sev("fix")} · polish ${sev("polish")}`);
}
const byClass = new Map<number, number>();
for (const x of pilotRecs) for (const i of x.r.review!.issues) if (i.severity !== "polish") byClass.set(i.class, (byClass.get(i.class) ?? 0) + 1);
say(`  block+fix issues by class: ${[...byClass.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c}:${n}`).join(" · ")}`);

say(`\n═══ PILOT — every block and fix issue, verbatim ═══`);
let n = 0;
for (const x of pilotRecs) {
  const bf = x.r.review!.issues.filter((i) => i.severity !== "polish");
  if (!bf.length) continue;
  say(`\n  (${x.p.tag}) ${x.p.m.title} — ${x.p.m.id} — verdict ${x.r.review!.verdict}`);
  for (const i of bf) say(`    #${++n} ${fmt(i)}`);
}

// ── cost + cache evidence ───────────────────────────────────────────────────
const live = recs.filter((r) => r && r.ok);
const tot = live.reduce((a, r) => ({ cost: a.cost + r.costUsd, inp: a.inp + r.usage.input_tokens, out: a.out + r.usage.output_tokens, cw: a.cw + r.usage.cache_creation_input_tokens, cr: a.cr + r.usage.cache_read_input_tokens }), { cost: 0, inp: 0, out: 0, cw: 0, cr: 0 });
say(`\n═══ COST ═══`);
say(`  ${live.length} reviews: $${tot.cost.toFixed(4)} · per meal $${(tot.cost / Math.max(1, live.length)).toFixed(4)} · tokens: uncached in ${tot.inp} · cache write ${tot.cw} · cache read ${tot.cr} · out ${tot.out} (mean out ${(tot.out / Math.max(1, live.length)).toFixed(0)})`);
say(`  calls with a cache read: ${live.filter((r) => r.usage.cache_read_input_tokens > 0).length}/${live.length} · with a cache write: ${live.filter((r) => r.usage.cache_creation_input_tokens > 0).length}`);
writeFileSync(join(OUT, `pass3-${mode}${TAG ? `-${TAG}` : ""}.txt`), lines.join("\n"));
console.log(`→ ${join(OUT, `pass3-${mode}${TAG ? `-${TAG}` : ""}.txt`)}`);
