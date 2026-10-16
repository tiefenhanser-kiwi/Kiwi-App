// CAT-Q0 — the FULL run over every public non-archived catalog meal: Pass 1
// (free) and Pass 2 (the AI review), in ONE command, leaving everything the
// report needs on disk so nothing after it needs database access.
// READ-ONLY on data: the only database calls are the catalog reads (findMany).
//
// EVERY mode (dry included) writes, under out/:
//   <dev|prod>-catalog.json    one row per meal: id, title, updatedAt, sourceType,
//                              payloadSha (the fingerprint.ts per-meal hash),
//                              reviewKey (the reviews.jsonl cache key), plan-item and
//                              template-item counts, live Featured plans, step-less
//                              dishes; plus the aggregate payload fingerprint.
//                              No hostnames, no URLs, no credentials.
//   pass1-<mode>.csv / .txt    every Pass 1 finding / per-check counts (no_steps listed)
// --batch / --live also write:
//   reviews.jsonl (appended)   one record per reviewed meal, keyed by reviewKey
//   batch-<mode>.json          the batch id and its custom_id → meal map
//   full-<mode>.csv            one row per issue
//
//   dry (default, no spend):  node --env-file=.env --import tsx scripts/_scratch/cat-q0/fullRun.ts
//   batch, ONE command:       … fullRun.ts --batch --submit --wait --ceiling <usd>
//   batch, two steps:         … --batch --submit --ceiling <usd>, later … --batch --collect
//   live (standard price):    … --live --ceiling <usd>   (also re-runs anything a batch errored)
//
// --ceiling bounds THIS run's spend. A batch is refused unless its WORST case
// (no cache hits at all) fits under it: a batch cannot be stopped half-way on cost.
//
// Production: a fresh PowerShell window with $env:DATABASE_URL and
// $env:KIWI_PRODUCTION_HOST set in the shell (see fingerprint.ts); unset after.
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { CATALOG_WHERE, loadCatalog, loadFeaturedMealIds } from "./catalogDb";
import { buildVocab, checkMeal, CLASS_OF, DESCRIBE, type CheckCode } from "./checks";
import { costOf, mealPayload, requestFor, RUBRIC_SHA, TOOL_NAME, userMessage, type ReviewOutput } from "./rubric";
import { OUT, requestKey, runReviews, spentSoFar, type ReviewRecord } from "./reviewRunner";

const has = (k: string) => process.argv.includes(k);
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const CEILING = Number(arg("--ceiling", "0"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const t0 = Date.now();

const { host, mode } = assertScriptDatabase("cat-q0/fullRun");
const tag = mode === "production" ? "prod" : "dev";
console.log(`database: ${host} (${mode}) · rubric ${RUBRIC_SHA}`);

// ── the reads ───────────────────────────────────────────────────────────────
const prisma = new PrismaClient();
const meals = await loadCatalog(prisma);
const featured = (await loadFeaturedMealIds(prisma)).filter((t) => !t.anchored);
const counts = await prisma.meal.findMany({ where: CATALOG_WHERE, select: { id: true, _count: { select: { planItems: true, templateItems: true } } } });
await prisma.$disconnect();
const countById = new Map(counts.map((c) => [c.id, c._count]));

// ── 1. the catalog file ─────────────────────────────────────────────────────
function sectionShas(p: ReturnType<typeof mealPayload>) {
  const h = (x: unknown) => sha(JSON.stringify(x)).slice(0, 12);
  return {
    head: h([p.title, p.servings]), times: h([p.derivedTotalMinutes, p.derivedHandsOnMinutes]), allergens: h(p.allergens),
    dishes: h(p.dishes.map((d) => [d.title, d.role, d.servings])), ingredients: h(p.dishes.map((d) => d.ingredients)),
    stepText: h(p.dishes.map((d) => d.steps.map((s) => s.text))), stepMeta: h(p.dishes.map((d) => d.steps.map((s) => [s.index, s.phase, s.minutes]))), swaps: h(p.dishes.map((d) => d.swaps)),
  };
}
const msgs = new Map(meals.map((m) => [m.id, userMessage(m)]));
const catalog = meals.map((m) => {
  const msg = msgs.get(m.id)!;
  return {
    id: m.id, title: m.title, updatedAt: m.updatedAt.toISOString(), sourceType: m.sourceType,
    payloadSha: sha(msg), reviewKey: requestKey(msg),
    // Which part of the payload moved, when two databases disagree (12 hex each).
    sectionSha: sectionShas(mealPayload(m)),
    planItems: countById.get(m.id)?.planItems ?? 0, templateItems: countById.get(m.id)?.templateItems ?? 0,
    featured: featured.filter((t) => t.mealIds.includes(m.id)).map((t) => t.templateId),
    steplessDishes: m.dishes.filter((d) => d.allSteps.length === 0).map((d) => ({ dishId: d.dishId, title: d.title })),
  };
});
const payloadFingerprint = sha(catalog.map((c) => `${c.id}:${c.payloadSha}`).sort().join("\n"));
writeFileSync(join(OUT, `${tag}-catalog.json`), JSON.stringify({ mode, rubricSha: RUBRIC_SHA, writtenAt: new Date().toISOString(), meals: catalog.length, payloadFingerprint, featuredPlans: featured.map((t) => ({ templateId: t.templateId, title: t.title, mealIds: t.mealIds })), catalog }, null, 1));
console.log(`catalog ${catalog.length} meals · payload fingerprint ${payloadFingerprint.slice(0, 8)}…${payloadFingerprint.slice(-4)} → out/${tag}-catalog.json`);

// ── 2. Pass 1, same command ─────────────────────────────────────────────────
const vocab = buildVocab(meals);
const findings = meals.flatMap((m) => checkMeal(m, vocab));
const cell = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
writeFileSync(join(OUT, `pass1-${mode}.csv`), ["class,code,mealId,mealTitle,dish,where,detail", ...findings.map((f) => [CLASS_OF[f.code], f.code, f.mealId, f.mealTitle, f.dish, f.where, f.detail].map(cell).join(","))].join("\n"));
const p1: string[] = [`Pass 1 (${mode}) — ${meals.length} meals, ${findings.length} findings, ${new Set(findings.map((f) => f.mealId)).size} meals with any`];
for (const c of Object.keys(CLASS_OF) as CheckCode[]) {
  const fs = findings.filter((f) => f.code === c);
  p1.push(`[${CLASS_OF[c]}] ${c}: ${fs.length} findings in ${new Set(fs.map((f) => f.mealId)).size} meals — ${DESCRIBE[c]}`);
  if (c === "no_steps") for (const f of fs) p1.push(`    no_steps: ${f.mealId} "${f.mealTitle}" — ${f.dish}`);
}
writeFileSync(join(OUT, `pass1-${mode}.txt`), p1.join("\n"));
const stepless = findings.filter((f) => f.code === "no_steps");
console.log(`pass1 ${findings.length} findings · no_steps ${stepless.length} dishes → out/pass1-${mode}.csv, out/pass1-${mode}.txt`);

// ── 3. the reviews ──────────────────────────────────────────────────────────
const CACHE = join(OUT, "reviews.jsonl");
const readCache = () => {
  const m = new Map<string, ReviewRecord>();
  if (existsSync(CACHE)) for (const l of readFileSync(CACHE, "utf8").split("\n")) if (l.trim()) { const r = JSON.parse(l) as ReviewRecord; if (r.ok) m.set(r.key, r); }
  return m;
};
const cached = readCache();
const jobs = catalog.map((c) => ({ c, msg: msgs.get(c.id)! }));
const todo = jobs.filter((j) => !cached.has(j.c.reviewKey));

// Projection from MEASURED usage under THIS rubric: records stamped with it,
// else the latest 20 (the CAT-Q0 B recall rerun, made under it).
const all = [...cached.values()].sort((a, b) => a.at.localeCompare(b.at));
const stamped = all.filter((r) => r.rubricSha === RUBRIC_SHA);
const basis = stamped.length >= 10 ? stamped : all.slice(-20);
const avg = (f: (r: ReviewRecord) => number) => basis.reduce((a, r) => a + f(r), 0) / Math.max(1, basis.length);
// a batch record was billed at 50%: count it at the standard price here
const perStd = avg((r) => (r.label === "batch" ? r.costUsd * 2 : r.costUsd));
const prefixTok = avg((r) => r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens);
const perBatchHit = costOf({ input_tokens: avg((r) => r.usage.input_tokens), output_tokens: avg((r) => r.usage.output_tokens), cache_read_input_tokens: prefixTok }, true);
const perBatchMiss = costOf({ input_tokens: avg((r) => r.usage.input_tokens) + prefixTok, output_tokens: avg((r) => r.usage.output_tokens) }, true);
const worst = perBatchMiss * todo.length;
console.log(`reviews: ${todo.length} to make (${jobs.length - todo.length} already on disk) · basis ${basis.length} reviews under rubric ${RUBRIC_SHA}: $${perStd.toFixed(4)}/meal standard`);
console.log(`projected: standard $${(perStd * todo.length).toFixed(2)} · batch $${(perBatchHit * todo.length).toFixed(2)} (cache hits) to $${worst.toFixed(2)} (worst: no cache hits)`);

function writeFullCsv() {
  const recs = readCache();
  const rows = ["mealId,title,verdict,severity,class,dish,ingredient,stepIndex,quote,why,fix"];
  for (const c of catalog) {
    const r = recs.get(c.reviewKey);
    if (!r) { rows.push([c.id, c.title, "NOT REVIEWED", "", "", "", "", "", "", "", ""].map(cell).join(",")); continue; }
    if (!r.review!.issues.length) rows.push([c.id, c.title, r.review!.verdict, "", "", "", "", "", "", "", ""].map(cell).join(","));
    for (const i of r.review!.issues) rows.push([c.id, c.title, r.review!.verdict, i.severity, i.class, i.dish, i.ingredient, i.stepIndex, i.quote, i.why, i.fix].map(cell).join(","));
  }
  writeFileSync(join(OUT, `full-${mode}.csv`), rows.join("\n"));
  const have = catalog.filter((c) => recs.has(c.reviewKey)).length;
  return { have, missing: catalog.length - have };
}

const BATCH_FILE = join(OUT, `batch-${mode}.json`);
if (has("--live")) {
  if (!(CEILING > 0)) throw new Error("--live needs --ceiling <usd>");
  const before = spentSoFar();
  await runReviews(todo.map((j) => ({ label: "full", mealId: j.c.id, title: j.c.title, userMsg: j.msg })), { ceilingUsd: CEILING, concurrency: 6, perRun: true });
  const w = writeFullCsv();
  console.log(`\nCAT-Q0 ${mode} live run — done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`reviews on disk ${w.have}/${catalog.length} (missing ${w.missing}) · this run $${(spentSoFar() - before).toFixed(2)}`);
  console.log(`files: out/${tag}-catalog.json · out/pass1-${mode}.csv/.txt · out/reviews.jsonl · out/full-${mode}.csv`);
} else if (has("--batch") && (has("--submit") || has("--collect"))) {
  const client = new Anthropic();
  if (has("--submit")) {
    if (!(CEILING > 0)) throw new Error("--batch --submit needs --ceiling <usd>");
    if (worst > CEILING) throw new Error(`refusing: the batch's worst case $${worst.toFixed(2)} (no cache hits) exceeds the $${CEILING} ceiling; expected with cache hits $${(perBatchHit * todo.length).toFixed(2)}`);
    if (todo.length === 0) throw new Error("nothing to review — every meal is already on disk");
    const batch = await client.messages.batches.create({
      requests: todo.map((j) => ({ custom_id: j.c.reviewKey, params: requestFor(j.msg, 4096, true) })),
    });
    writeFileSync(BATCH_FILE, JSON.stringify({ id: batch.id, submittedAt: new Date().toISOString(), rubricSha: RUBRIC_SHA, keys: Object.fromEntries(todo.map((j) => [j.c.reviewKey, { mealId: j.c.id, title: j.c.title }])) }));
    console.log(`submitted batch ${batch.id} (${todo.length} requests) → out/batch-${mode}.json`);
    // --wait: the ONE-command form — submit, then fall through to collect (it polls).
    if (!has("--wait")) {
      console.log("collect later with --batch --collect (same environment)");
      process.exit(0);
    }
  }
  const saved = JSON.parse(readFileSync(BATCH_FILE, "utf8")) as { id: string; keys: Record<string, { mealId: string; title: string }> };
  let b = await client.messages.batches.retrieve(saved.id);
  for (;;) {
    console.log(`${new Date().toISOString().slice(11, 19)} batch ${b.id}: ${b.processing_status} · ${JSON.stringify(b.request_counts)}`);
    if (b.processing_status === "ended") break;
    await new Promise((r) => setTimeout(r, 60_000));
    b = await client.messages.batches.retrieve(saved.id);
  }
  let spend = 0, cacheReads = 0, cacheWrites = 0, ok = 0;
  const bad: Record<string, number> = {};
  for await (const res of await client.messages.batches.results(saved.id)) {
    const meta = saved.keys[res.custom_id] ?? { mealId: "?", title: "?" };
    if (res.result.type !== "succeeded") {
      bad[res.result.type] = (bad[res.result.type] ?? 0) + 1;
      appendFileSync(CACHE, `${JSON.stringify({ key: res.custom_id, label: "batch", mealId: meta.mealId, title: meta.title, ok: false, error: res.result.type, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0, latencyMs: 0, at: new Date().toISOString(), rubricSha: RUBRIC_SHA } satisfies ReviewRecord)}\n`);
      continue;
    }
    const msg = res.result.message;
    const u = { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens, cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0, cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0 };
    const cost = costOf(u, true, true);
    spend += cost;
    if (u.cache_read_input_tokens > 0) cacheReads++;
    if (u.cache_creation_input_tokens > 0) cacheWrites++;
    const tool = msg.content.find((x): x is Anthropic.ToolUseBlock => x.type === "tool_use" && x.name === TOOL_NAME);
    if (tool) ok++;
    else bad[`no_tool_${msg.stop_reason}`] = (bad[`no_tool_${msg.stop_reason}`] ?? 0) + 1;
    const rec: ReviewRecord = { key: res.custom_id, label: "batch", mealId: meta.mealId, title: meta.title, ok: !!tool, ...(tool ? { review: tool.input as ReviewOutput } : { error: `no ${TOOL_NAME} call (stop_reason ${msg.stop_reason})` }), stopReason: msg.stop_reason, usage: u, costUsd: cost, latencyMs: 0, at: new Date().toISOString(), rubricSha: RUBRIC_SHA };
    appendFileSync(CACHE, `${JSON.stringify(rec)}\n`);
  }
  writeFileSync(join(OUT, "spend.json"), JSON.stringify({ usd: spentSoFar() + spend, updatedAt: new Date().toISOString() }));
  const w = writeFullCsv();
  const n = Object.values(saved.keys).length;
  console.log(`\nCAT-Q0 ${mode} batch run — done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`batch ${saved.id} · requests ${n} · reviewed ok ${ok} · not ok ${JSON.stringify(bad)}`);
  console.log(`spend this batch $${spend.toFixed(2)} (50% batch price, 1h cache) · cache reads ${cacheReads}/${n} · cache writes ${cacheWrites}`);
  console.log(`catalog ${catalog.length} · payload fingerprint ${payloadFingerprint.slice(0, 8)}…${payloadFingerprint.slice(-4)} · reviews on disk ${w.have}/${catalog.length}${w.missing ? ` — re-run the ${w.missing} missing with --live --ceiling 2` : ""}`);
  console.log(`pass1 ${findings.length} findings · no_steps ${stepless.length}`);
  console.log(`files: out/${tag}-catalog.json · out/pass1-${mode}.csv/.txt · out/reviews.jsonl · out/batch-${mode}.json · out/full-${mode}.csv`);
} else {
  console.log("dry run — nothing sent. --batch --submit [--wait] --ceiling <usd> | --batch --collect | --live --ceiling <usd>");
}
