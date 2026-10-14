// THX-2G (D-WS9-311 / D-WS9-313) — generate the Thanksgiving feasts, alternates
// and Friday meals into the catalog, NON-PUBLIC, through the catalog's own path:
// runStoreFill (store.generate_meal + store.finalize_steps, cached prefixes) →
// mergeSteps → materializeMeal (stampAllergens + stampMealTiming + image enqueue).
// One target per runStoreFill call, one meal at a time; the script-only options
// (storeFill.ts THX-2G block) come from thx2Core.runOptionsFor.
//
//   node --env-file=.env --import tsx scripts/thx2/generate.ts --dry-run                  # what would run; no AI calls, no writes
//   node --env-file=.env --import tsx scripts/thx2/generate.ts --only thx2-feast-classic  # one or more keys, comma-separated
//   node --env-file=.env --import tsx scripts/thx2/generate.ts                            # every target not yet written
//   node --env-file=.env --import tsx scripts/thx2/generate.ts --wait-images 15           # then wait up to 15 min for the image drain
//
// Database: assertScriptDatabase — the dev branch, or production only when
// KIWI_PRODUCTION_HOST names the DATABASE_URL host exactly (R3-0).
// Idempotent by key: a key already in the database (dishFamilyKey) is skipped.
// Spend: a hard breaker at targets.json spendCapUsd ($15), cumulative across
// restarts per database (scripts/_scratch/thx2/spend-<mode>.json), checked
// before EVERY AI call; it refuses the call and the run stops.
// Revert: scripts/thx2/revert.ts. Public: scripts/thx2/approve.ts (not here).

import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { getModelRate, resolvePromptDescriptorFromDb } from "../../src/lib/ai/promptRegistry";
import { resolveCallModel } from "../../src/lib/ai/modelShape";
import { runAICall as productionRunAICall } from "../../src/lib/ai/runAICall";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { computeCacheAwareCostUsd, emptyTokenTotals, generateInput, runStoreFill, type ModelRateUsd, type TokenTotals } from "../../src/lib/storeFill";
import { generatePrefixFor, STABLE_GENERATE_PREFIX } from "../../src/lib/storeFillPrompts";
import { flagsFor, loadTargets, runOptionsFor, validateTargets, type Thx2Target } from "./thx2Core";
import { flagInputs, loadThx2Meals, type MealGraph } from "./thx2Db";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const onlyIdx = argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : null;
const waitIdx = argv.indexOf("--wait-images");
const WAIT_MIN = waitIdx >= 0 ? Number(argv[waitIdx + 1]) : 0;

const { host, mode } = assertScriptDatabase("thx2/generate");
console.log(`database: ${host} (${mode})`);

const file = loadTargets();
const errs = validateTargets(file);
if (errs.length) { console.error(`targets.json is invalid:\n  ${errs.join("\n  ")}`); process.exit(2); }
let targets = file.targets;
if (ONLY) {
  const unknown = ONLY.filter((k) => !targets.some((t) => t.key === k));
  if (unknown.length) { console.error(`--only: unknown keys ${unknown.join(", ")}`); process.exit(2); }
  targets = targets.filter((t) => ONLY.includes(t.key));
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
const variant = generatePrefixFor({ maxDishes: file.maxDishes });
console.log(`targets: ${targets.length} of ${file.targets.length} (${["feast", "alternate", "friday"].map((k) => `${k} ${targets.filter((t) => t.kind === k).length}`).join(" · ")}) · maxDishes ${file.maxDishes} · max output tokens ${file.maxOutputTokens} · rows written NON-PUBLIC · cap $${file.spendCapUsd}`);
console.log(`generate prefix: variant sha ${sha(variant)} (${variant.length} chars) · default sha ${sha(STABLE_GENERATE_PREFIX)} (unchanged)`);

const prisma = new PrismaClient();
const genDesc = await resolvePromptDescriptorFromDb("store.generate_meal", prisma);
const finDesc = await resolvePromptDescriptorFromDb("store.finalize_steps", prisma);
const genModel = resolveCallModel(genDesc.defaultModel);
const finModel = resolveCallModel(finDesc.defaultModel);
const rate: ModelRateUsd = await getModelRate(genModel, prisma);
console.log(`models: generate ${genModel} (prompt v${genDesc.version ?? "-"}) · finalize ${finModel} (prompt v${finDesc.version ?? "-"}) · rate $${rate.inputPerMtokUsd}/$${rate.outputPerMtokUsd} per Mtok`);

const done = new Set((await prisma.meal.findMany({ where: { sourceType: "batch_generated", dishFamilyKey: { in: targets.map((t) => t.key) } }, select: { dishFamilyKey: true } })).map((m) => m.dishFamilyKey));
const pending = targets.filter((t) => !done.has(t.key));
console.log(`already written: ${done.size} (${[...done].join(", ") || "none"}) · to generate: ${pending.length}`);

// ── dry run: every input exactly as it would go on the wire ─────────────────
if (DRY) {
  for (const t of pending) {
    const o = runOptionsFor(t, file);
    const td = o.dishes![0];
    console.log(`\n── ${t.key} · ${t.kind} · ${t.servings} servings · ceiling ${t.difficulty} · completeness ${o.completeness} · ${t.dishes.length} dishes`);
    console.log(`   meal tags [${o.tags!.join(", ")}] · dish tags [${o.dishTags!.join(", ") || "-"}]`);
    console.log(`   generate input:\n${indent(generateInput(td.dish, o.profiles![0], td.dishes, td.shortcut, o.brief))}`);
    if (o.finalizeBrief) console.log(`   finalize brief: ${o.finalizeBrief}`);
  }
  const est = pending.reduce((a, t) => a + (t.kind === "feast" ? 0.3 : 0.06), 0);
  console.log(`\nDRY RUN — no AI calls, no writes. Rough cost for ${pending.length} meals: ~$${est.toFixed(2)} (feasts ~$0.30, others ~$0.06).`);
  await prisma.$disconnect();
  process.exit(0);
}

// ── the spend breaker: cumulative per database, before EVERY call ───────────
const SCRATCH = "scripts/_scratch/thx2";
mkdirSync(SCRATCH, { recursive: true });
const SPEND_FILE = `${SCRATCH}/spend-${mode}.json`;
const prior: { spentUsd: number; calls: number } = existsSync(SPEND_FILE) ? JSON.parse(readFileSync(SPEND_FILE, "utf8")) : { spentUsd: 0, calls: 0 };
console.log(`spend so far on ${mode}: $${prior.spentUsd.toFixed(4)} over ${prior.calls} calls (${SPEND_FILE})`);
const thisRun: TokenTotals = emptyTokenTotals();
let breakerTripped = false;
interface CallRow { target: string; key: string; model: string; ok: boolean; reason?: string; input: number; output: number; cacheRead: number; cacheCreation: number; usd: number }
const calls: CallRow[] = [];
let currentTarget = "";
const guardedRunAICall = (async (key: string, vars: unknown, schema: unknown, opts: unknown) => {
  const cum = prior.spentUsd + computeCacheAwareCostUsd(thisRun, rate);
  if (cum >= file.spendCapUsd || breakerTripped) {
    breakerTripped = true;
    console.log(`SPEND BREAKER: $${cum.toFixed(4)} ≥ $${file.spendCapUsd} before ${key} — refusing the call`);
    return { success: false, reason: "spend_breaker", userFacingMessage: "spend breaker", metadata: { inputTokens: 0, outputTokens: 0 } };
  }
  type Res = { success: boolean; reason?: string; metadata: { model?: string; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } };
  const res = await (productionRunAICall as unknown as (...a: unknown[]) => Promise<Res>)(key, vars, schema, opts);
  const before = computeCacheAwareCostUsd(thisRun, rate);
  const md = res.metadata;
  thisRun.aiCalls++; thisRun.input += md.inputTokens ?? 0; thisRun.output += md.outputTokens ?? 0; thisRun.cacheRead += md.cacheReadInputTokens ?? 0; thisRun.cacheCreation += md.cacheCreationInputTokens ?? 0;
  const after = computeCacheAwareCostUsd(thisRun, rate);
  calls.push({ target: currentTarget, key, model: md.model ?? "?", ok: res.success, reason: res.reason, input: md.inputTokens ?? 0, output: md.outputTokens ?? 0, cacheRead: md.cacheReadInputTokens ?? 0, cacheCreation: md.cacheCreationInputTokens ?? 0, usd: after - before });
  writeFileSync(SPEND_FILE, JSON.stringify({ spentUsd: prior.spentUsd + after, calls: prior.calls + thisRun.aiCalls }));
  return res;
}) as unknown as typeof productionRunAICall;

// ── the run: one target at a time ────────────────────────────────────────────
const t0 = Date.now();
const written: { t: Thx2Target; mealId: string }[] = [];
const failed: { t: Thx2Target; why: string }[] = [];
for (const t of pending) {
  if (breakerTripped) break;
  currentTarget = t.key;
  console.log(`\n▶ ${t.key} (${t.kind}, ${t.dishes.length} dishes, ${t.servings} servings)`);
  const spent = prior.spentUsd + computeCacheAwareCostUsd(thisRun, rate);
  const result = await runStoreFill(
    { prisma, runAICall: guardedRunAICall },
    { ...runOptionsFor(t, file), apply: true, maxCostUsd: Math.max(0.01, file.spendCapUsd - spent), maxCalls: 6, maxConsecutiveFailures: 1, rate, log: (m) => console.log(`  ${m}`) },
  );
  for (const c of result.completenessRejections) console.log(`  completeness retry ${c.attempt}: ${c.reason}${c.title ? ` ("${c.title}")` : ""}`);
  for (const s of result.skips.filter((x) => x.stage !== "dedup")) console.log(`  skip ${s.stage}: ${s.reason}${s.title ? ` ("${s.title}")` : ""}`);
  for (const d of result.substitutionDrops) console.log(`  substitution dropped: "${d.product}" in "${d.dishTitle}" (unmatched ${d.unmatched.join(", ")})`);
  for (const f of result.componentTagFindings) console.log(`  component tag finding: ${f.reason} in "${f.dishTitle}" — ${f.detail}`);
  if (result.parallelGroupIssues.length) console.log(`  parallelGroup issues: ${result.parallelGroupIssues.map((i) => i.cls).join(", ")}`);
  for (const c of calls.filter((c) => c.target === t.key)) {
    console.log(`  call ${c.key.replace("store.", "")}: ${c.ok ? "ok" : `FAILED ${c.reason}`} · ${c.model} · out ${c.output} / cap ${file.maxOutputTokens} · in ${c.input} + cache read ${c.cacheRead} + created ${c.cacheCreation} · $${c.usd.toFixed(4)}`);
  }
  const rec = result.records.find((r) => r.written && r.mealId);
  if (!rec?.mealId) {
    const why = result.skips.find((s) => s.stage !== "dedup")?.reason ?? result.stoppedBy ?? (result.skips.some((s) => s.stage === "dedup") ? "already_written" : "unknown");
    failed.push({ t, why });
    console.log(`  ✗ not written: ${why}`);
    continue;
  }
  written.push({ t, mealId: rec.mealId });
  const [m] = await loadThx2Meals(prisma, [t.key]);
  printMeal(t, m);
}

const runCost = computeCacheAwareCostUsd(thisRun, rate);
console.log(`\nrun: written ${written.length} · not written ${failed.length}${failed.length ? ` (${failed.map((f) => `${f.t.key}: ${f.why}`).join("; ")})` : ""} · calls ${thisRun.aiCalls} · $${runCost.toFixed(4)} this run · $${(prior.spentUsd + runCost).toFixed(4)} cumulative on ${mode} · wall ${((Date.now() - t0) / 1000).toFixed(0)}s${breakerTripped ? " · STOPPED BY THE SPEND BREAKER" : ""}`);

// ── images ───────────────────────────────────────────────────────────────────
// materializeMeal writes imageStatus "pending"; nothing here calls OpenAI. The
// drain (Cloud Scheduler → POST /api/internal/images/drain, once a minute,
// ≤ 5 per minute org-wide) claims pending rows FIFO regardless of isPublic. On
// production that drain runs; on dev nothing drains unless
// scripts/ws9-row5/drain_once.ts is run by hand.
const all = await loadThx2Meals(prisma, targets.map((t) => t.key));
if (WAIT_MIN > 0) {
  const deadline = Date.now() + WAIT_MIN * 60_000;
  for (;;) {
    const states = await prisma.meal.findMany({ where: { id: { in: all.map((m) => m.id) } }, select: { imageStatus: true } });
    const open = states.filter((s) => s.imageStatus === "pending" || s.imageStatus === "generating").length;
    console.log(`images: ${states.length - open}/${states.length} settled (${open} pending or generating)`);
    if (open === 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
const imgs = await prisma.meal.findMany({ where: { id: { in: all.map((m) => m.id) } }, select: { dishFamilyKey: true, imageStatus: true, imageAttempts: true, imageUrl: true }, orderBy: { dishFamilyKey: "asc" } });
console.log(`\nimage state (${imgs.length} rows): ${["ready", "pending", "generating", "failed"].map((s) => `${s} ${imgs.filter((i) => String(i.imageStatus) === s).length}`).join(" · ")}`);
for (const i of imgs) console.log(`  ${String(i.dishFamilyKey).padEnd(42)} ${String(i.imageStatus).padEnd(10)} attempts ${i.imageAttempts}${i.imageUrl ? "" : " · no url"}`);
console.log(`\nnext: node --env-file=.env --import tsx scripts/thx2/review.ts   ·   revert: scripts/thx2/revert.ts (dry by default)`);
await prisma.$disconnect();

function printMeal(t: Thx2Target, m: MealGraph): void {
  const flags = flagsFor(t, file, flagInputs(m));
  console.log(`  ✓ ${m.id} "${m.title}" · ${m.dishes.length}/${t.dishes.length} dishes · derived ${m.estimatedTimeMinutes} min total, ${m.activeTimeMinutes ?? "-"} active · servings ${m.servingsDefault} · public ${m.isPublic} · tags [${m.tags.join(", ")}]`);
  for (const d of m.dishes) console.log(`    ${d.positionIndex}. [${d.role}] ${d.title} · ${d.ingredients.length} ingredients · ${d.steps.length} steps${d.tags.length ? ` · dish tags [${d.tags.join(", ")}]` : ""}`);
  console.log(`    asked order: ${t.dishes.map((d) => d.name).join(" · ")}`);
  console.log(`    allergens [${m.allergens.join(", ")}] · sources ${JSON.stringify(m.allergenSources)}`);
  const ex = Object.entries(m.explain).filter(([, v]) => v.disqualified.length > 0);
  if (ex.length) console.log(`    disqualified matches: ${ex.map(([tok, v]) => `${tok}: ${v.disqualified.join(", ")}`).join(" · ")}`);
  console.log(`    explainAllergenMatches: ${Object.entries(m.explain).map(([tok, v]) => `${tok}=${v.matched.length}${v.disqualified.length ? `(-${v.disqualified.length})` : ""}`).join(" ") || "none"}`);
  if (flags.length) for (const f of flags) console.log(`    🚩 ${f.code}: ${f.detail}`);
  else console.log(`    flags: none`);
}

function indent(s: string): string {
  return s.split("\n").map((l) => `      ${l}`).join("\n");
}
