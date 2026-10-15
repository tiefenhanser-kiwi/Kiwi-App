// CAT-Q0 — the FULL Pass 2 run over every public non-archived catalog meal.
// READ-ONLY on data. NOT RUN by CAT-Q0: Hans approves the cost first.
//
//   dry (default, no spend):  node --env-file=.env --import tsx scripts/_scratch/cat-q0/fullRun.ts
//       → meals, how many the on-disk cache already holds, projected cost both ways
//   batch (≈ half price; SDK 0.90.0 ships client.messages.batches):
//       … fullRun.ts --batch --submit --wait --ceiling 12   → ONE command: submit, poll, collect
//       … fullRun.ts --batch --submit --ceiling 12   → submits, writes out/batch-<mode>.json
//       … fullRun.ts --batch --collect               → polls until ended, appends results to
//                                                      out/reviews.jsonl, writes out/full-<mode>.csv
//   live (standard price, the pilot's runner):
//       … fullRun.ts --live --ceiling 20
//
// On production (only if fingerprint.ts differs): the same commands from a fresh
// PowerShell window with $env:DATABASE_URL and $env:KIWI_PRODUCTION_HOST set in
// the shell (see fingerprint.ts) — the only database call is the catalog read.
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { loadCatalog } from "./catalogDb";
import { costOf, requestFor, TOOL_NAME, userMessage, type ReviewOutput } from "./rubric";
import { OUT, requestKey, runReviews, spentSoFar, type ReviewRecord } from "./reviewRunner";

const has = (k: string) => process.argv.includes(k);
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const CEILING = Number(arg("--ceiling", "0"));

const { host, mode } = assertScriptDatabase("cat-q0/fullRun");
console.log(`database: ${host} (${mode})`);
const prisma = new PrismaClient();
const meals = await loadCatalog(prisma);
await prisma.$disconnect();
const reviewable = meals;
const CACHE = join(OUT, "reviews.jsonl");
const cached = new Map<string, ReviewRecord>();
if (existsSync(CACHE)) for (const l of readFileSync(CACHE, "utf8").split("\n")) if (l.trim()) { const r = JSON.parse(l) as ReviewRecord; if (r.ok) cached.set(r.key, r); }
const jobs = reviewable.map((m) => ({ m, msg: userMessage(m), key: requestKey(userMessage(m)) }));
const todo = jobs.filter((j) => !cached.has(j.key));

// Projection from the pilot's MEASURED usage (every ok record on disk).
const recs = [...cached.values()];
const avg = (f: (r: ReviewRecord) => number) => recs.reduce((a, r) => a + f(r), 0) / Math.max(1, recs.length);
const perStd = avg((r) => r.costUsd);
const perBatchCached = perStd / 2;
const perBatchUncached = costOf({ input_tokens: avg((r) => r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens), output_tokens: avg((r) => r.usage.output_tokens) }, true);
console.log(`${meals.length} catalog meals · ${todo.length} not yet reviewed (on-disk cache holds ${jobs.length - todo.length}) · measured on ${recs.length} pilot reviews: $${perStd.toFixed(4)}/meal standard`);
console.log(`projected for the ${todo.length}: standard $${(perStd * todo.length).toFixed(2)} · batch $${(perBatchCached * todo.length).toFixed(2)} (cache hits) to $${(perBatchUncached * todo.length).toFixed(2)} (no cache hits; batch caching is best-effort)`);

function writeCsv(all: ReviewRecord[]) {
  const cell = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = ["mealId,title,verdict,severity,class,dish,ingredient,stepIndex,quote,why,fix"];
  for (const r of all) {
    if (!r.ok) continue;
    if (!r.review!.issues.length) rows.push([r.mealId, r.title, r.review!.verdict, "", "", "", "", "", "", "", ""].map(cell).join(","));
    for (const i of r.review!.issues) rows.push([r.mealId, r.title, r.review!.verdict, i.severity, i.class, i.dish, i.ingredient, i.stepIndex, i.quote, i.why, i.fix].map(cell).join(","));
  }
  writeFileSync(join(OUT, `full-${mode}.csv`), rows.join("\n"));
  console.log(`→ ${join(OUT, `full-${mode}.csv`)}`);
}

const BATCH_FILE = join(OUT, `batch-${mode}.json`);
if (has("--live")) {
  if (!(CEILING > 0)) throw new Error("--live needs --ceiling <usd>");
  const out = await runReviews(todo.map((j) => ({ label: "full", mealId: j.m.id, title: j.m.title, userMsg: j.msg })), { ceilingUsd: CEILING, concurrency: 6 });
  writeCsv([...recs, ...out.filter(Boolean)]);
} else if (has("--batch") && (has("--submit") || has("--collect"))) {
  if (has("--submit")) {
    if (!(CEILING > 0)) throw new Error("--batch --submit needs --ceiling <usd>");
    const worst = perBatchUncached * todo.length;
    if (spentSoFar() + worst > CEILING) throw new Error(`refusing: worst case $${worst.toFixed(2)} + spent $${spentSoFar().toFixed(2)} exceeds the $${CEILING} ceiling`);
    const batch = await new Anthropic().messages.batches.create({
      requests: todo.map((j) => ({ custom_id: j.key, params: requestFor(j.msg) })),
    });
    writeFileSync(BATCH_FILE, JSON.stringify({ id: batch.id, submittedAt: new Date().toISOString(), keys: Object.fromEntries(todo.map((j) => [j.key, { mealId: j.m.id, title: j.m.title }])) }));
    console.log(`submitted batch ${batch.id} (${todo.length} requests) → ${BATCH_FILE}`);
    // --wait: the ONE-command form — submit, then fall through to collect (it polls).
    if (!has("--wait")) {
      console.log("collect with --batch --collect (or submit with --wait next time)");
      process.exit(0);
    }
  }
  const saved = JSON.parse(readFileSync(BATCH_FILE, "utf8")) as { id: string; keys: Record<string, { mealId: string; title: string }> };
  const client = new Anthropic();
  for (;;) {
    const b = await client.messages.batches.retrieve(saved.id);
    console.log(`batch ${b.id}: ${b.processing_status} · ${JSON.stringify(b.request_counts)}`);
    if (b.processing_status === "ended") break;
    await new Promise((r) => setTimeout(r, 60_000));
  }
  let spend = 0;
  const fresh: ReviewRecord[] = [];
  for await (const res of await client.messages.batches.results(saved.id)) {
    const meta = saved.keys[res.custom_id];
    if (res.result.type !== "succeeded") {
      fresh.push({ key: res.custom_id, label: "batch", mealId: meta?.mealId ?? "?", title: meta?.title ?? "?", ok: false, error: res.result.type, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0, latencyMs: 0, at: new Date().toISOString() });
      continue;
    }
    const msg = res.result.message;
    const u = { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens, cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0, cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0 };
    const cost = costOf(u, true);
    spend += cost;
    const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME);
    fresh.push({ key: res.custom_id, label: "batch", mealId: meta.mealId, title: meta.title, ok: !!tool, ...(tool ? { review: tool.input as ReviewOutput } : { error: `no ${TOOL_NAME} call (stop_reason ${msg.stop_reason})` }), stopReason: msg.stop_reason, usage: u, costUsd: cost, latencyMs: 0, at: new Date().toISOString() });
  }
  for (const r of fresh) appendFileSync(CACHE, `${JSON.stringify(r)}\n`);
  const SPEND = join(OUT, "spend.json");
  writeFileSync(SPEND, JSON.stringify({ usd: spentSoFar() + spend, updatedAt: new Date().toISOString() }));
  console.log(`collected ${fresh.length} (${fresh.filter((r) => r.ok).length} ok) · batch spend $${spend.toFixed(4)} · cumulative $${spentSoFar().toFixed(4)}`);
  writeCsv([...recs, ...fresh]);
} else {
  console.log("dry run — nothing sent. --batch --submit [--wait] --ceiling <usd> | --batch --collect | --live --ceiling <usd>");
}
