// QA-COOK-1 — the cook simulation pass. DEV ONLY.
//
//   from artifacts/api-server:
//     node --import tsx scripts/qa-cook/run.ts                 capture + simulator + AI cooks + patterns
//     node --import tsx scripts/qa-cook/run.ts --from <dir>    reuse <dir>/views.json (no server, no account)
//     node --import tsx scripts/qa-cook/run.ts --no-personas   simulator only (free after the capture)
//
//   env: KIWI_COOKSIM_BUDGET_USD (default 10) — every model call: the server's
//          (LLMCallLog by the run's account, read before the account is deleted)
//          plus the AI cooks' own (priced from each response's usage);
//        KIWI_COOKSIM_SIZE (30) · KIWI_COOKSIM_SEED (1028) · KIWI_COOKSIM_SERVINGS ("2,6")
//        KIWI_COOKSIM_MODEL (claude-haiku-5-5) · KIWI_COOKSIM_COMPARE_MODEL (claude-sonnet-5-5)
//        KIWI_COOKSIM_COMPARE (5: meals both models cook, for the comparison)
//        KIWI_COOKSIM_OUT (default artifacts/kiwi/e2e/out/cooksim-<date>)
//
// Fences (QA-NIGHT-1's, reused): assertDevDatabase first; its OWN api-server
// child (scripts/qa-night/server.ts) on :3110 — not the night run's :3100, so the
// two never share — with every mail switch off and proven from the child's own
// boot output before the first request; the account is deleted and proven gone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase, DEV_HOST_MARKER } from "../../src/lib/scripts/requireDatabaseHost";
import { Client } from "../qa-night/http";
import { readDotEnv, startServer, stopServer } from "../qa-night/server";
import { tallySpend } from "../qa-night/spend";
import { CookCapture, retryDb } from "./capture";
import Anthropic from "@anthropic-ai/sdk";

import { collectHits, patternOfIssue, rankPatterns } from "./patterns";
import { caughtFajita, pool, runPersona } from "./personas";
import { type ModelCompare, renderReport } from "./report";
import { drawSample, FAJITA_MEAL_ID, type SampleMeal } from "./sample";
import { simulate } from "./simulator";
import type { CookView, PersonaId, PersonaRun } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const KIWI_ROOT = resolve(API_ROOT, "..", "kiwi");
export const COOK_PORT = 3110;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1] ?? "";
};
const flag = (name: string) => process.argv.includes(name);

function assertDev(env: NodeJS.ProcessEnv): void {
  const { host, mode } = assertScriptDatabase("qa-cook", env);
  if (mode !== "dev" || !host.includes(DEV_HOST_MARKER)) throw new Error("refusing: qa-cook runs on the dev branch only");
}

export interface CaptureFacts {
  runTag: string;
  sample: SampleMeal[];
  views: number;
  serverUsd: number;
  serverCalls: number;
  byPrompt: Record<string, { calls: number; usd: number }>;
  wallMin: number;
  account: { email: string | null; deleted: unknown };
  notes: unknown[];
  failures: string[];
  bootProof: string;
  dirtyTree: string[];
}

/**
 * The capture. Every view is written to <out>/views.json as it arrives, so a run
 * that dies (a dropped connection) keeps what it had, and the next run in the
 * same folder resumes: a plan whose meals are all there is skipped. Before it
 * starts and after it ends, any qa-cook account a dead run left is swept.
 */
async function capture(outDir: string, size: number, seed: number, servingsList: number[]): Promise<{ views: CookView[]; facts: CaptureFacts }> {
  const t0 = Date.now();
  const dotEnv = readDotEnv(API_ROOT);
  assertDev({ ...process.env, DATABASE_URL: dotEnv.DATABASE_URL });
  process.env.DATABASE_URL = dotEnv.DATABASE_URL;
  // The leftover sweep signs a password-reset token in this process (as the request route would).
  process.env.JWT_SECRET ??= dotEnv.JWT_SECRET;
  console.log("[qa-cook] dev database: PASS (ep-broad-haze)");
  const prisma = new PrismaClient();
  const sample = await drawSample(prisma, { size, seed });
  console.log(`[qa-cook] sample: ${sample.length} meals (seed ${seed}) — ${Object.entries(sample.reduce<Record<string, number>>((m, x) => ({ ...m, [x.category]: (m[x.category] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const { execSync } = await import("node:child_process");
  const dirtyTree = execSync("git status --short -- src ../kiwi/lib ../kiwi/app", { cwd: API_ROOT, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);

  const server = await startServer(API_ROOT, outDir, COOK_PORT);
  const bootProof = `RESEND_API_KEY ${server.proof.RESEND_API_KEY}, SIGNUP_ALERT_TO ${server.proof.SIGNUP_ALERT_TO}, LIFECYCLE_EMAIL_ENABLED ${server.proof.LIFECYCLE_EMAIL_ENABLED} (child pid ${server.proof.pid}, :${COOK_PORT}; server line "lifecycle email: off")`;
  console.log(`[qa-cook] api-server child — ${bootProof}`);
  const runTag = `${new Date().toISOString().slice(2, 10).replace(/-/g, "")}${Date.now().toString(36).slice(-4)}`;
  const calls: any[] = [];
  const cap = new CookCapture(new Client(`http://localhost:${COOK_PORT}/api`, "cook", calls), prisma, runTag);
  const viewsPath = join(outDir, "views.json");
  const factsPath = join(outDir, "capture.json");
  // Resume: the views (and the spend) an earlier run in this folder already captured.
  const views: CookView[] = existsSync(viewsPath) ? JSON.parse(readFileSync(viewsPath, "utf8")) : [];
  const prior: Partial<CaptureFacts> = existsSync(factsPath) ? JSON.parse(readFileSync(factsPath, "utf8")) : {};
  if (views.length) console.log(`[qa-cook] resuming: ${views.length} views already in ${viewsPath}`);
  const have = (mealId: string, servings: number) =>
    views.some((v) => v.sourceMealId === mealId && v.servings === servings && !v.prepped) && views.some((v) => v.sourceMealId === mealId && v.servings === servings && v.prepped);
  const failures: string[] = [];
  const started = new Date(Date.now() - 2000);
  let spend = { usd: 0, calls: 0, byPrompt: {} as Record<string, { calls: number; usd: number }> };
  let deleted: unknown = null;
  const swept: string[] = [];
  const onView = (v: CookView) => {
    // A plan re-run after a failure replaces that meal's earlier view of the same kind.
    const at = views.findIndex((x) => x.sourceMealId === v.sourceMealId && x.servings === v.servings && x.prepped === v.prepped);
    if (at >= 0) views[at] = v;
    else views.push(v);
    writeFileSync(viewsPath, JSON.stringify(views, null, 1));
    console.log(`[qa-cook]   ${v.servings}p ${v.prepped ? "prepped  " : "unprepped"} ${v.steps.length} steps · ${v.title.slice(0, 70)}`);
  };
  try {
    swept.push(...(await cap.sweepLeftovers()));
    for (const s of swept) console.log(`[qa-cook] swept a leftover account: ${s}`);
    await cap.signUp();
    const catalog = sample.filter((m) => m.category !== "feast");
    const feasts = sample.filter((m) => m.category === "feast");
    for (const servings of servingsList) {
      try {
        await cap.catalogPass(catalog, servings, onView, have);
      } catch (e) {
        failures.push(`catalog ${servings}p: ${String((e as Error).message).slice(0, 300)}`);
      }
      for (const f of feasts) {
        if (have(f.id, servings)) continue;
        try {
          await cap.feastPass(f, servings, onView);
        } catch (e) {
          failures.push(`feast ${f.title} ${servings}p: ${String((e as Error).message).slice(0, 300)}`);
        }
      }
    }
  } finally {
    // Each clean-up step on its own: one failing (the database gone again) must not skip the others.
    const step = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        failures.push(`clean-up ${what}: ${String((e as Error).message).split("\n")[0].slice(0, 200)}`);
      }
    };
    await step("spend", async () => {
      if (cap.userId) spend = await retryDb(() => tallySpend(prisma, { userIds: [cap.userId!], guestSessionIds: [] }, started));
    });
    await step("delete", async () => {
      deleted = await cap.deleteAccount();
    });
    await step("sweep", async () => {
      const after = await cap.sweepLeftovers();
      swept.push(...after);
      const left = await retryDb(() => prisma.user.findMany({ where: { email: { startsWith: "qa-cook-" } }, select: { email: true } }));
      if (left.length) failures.push(`accounts left: ${left.map((u) => u.email).join(", ")}`);
    });
    await step("disconnect", () => prisma.$disconnect());
    await stopServer(server);
    writeFileSync(join(outDir, `calls-${runTag}.json`), JSON.stringify(calls, null, 1));
  }
  // Spend adds up across resumed runs (each run's own account, read before its delete).
  const byPrompt = { ...(prior.byPrompt ?? {}) };
  for (const [k, x] of Object.entries(spend.byPrompt)) byPrompt[k] = { calls: (byPrompt[k]?.calls ?? 0) + x.calls, usd: (byPrompt[k]?.usd ?? 0) + x.usd };
  const facts: CaptureFacts = {
    runTag: prior.runTag ? `${prior.runTag}+${runTag}` : runTag, sample, views: views.length,
    serverUsd: (prior.serverUsd ?? 0) + spend.usd, serverCalls: (prior.serverCalls ?? 0) + spend.calls, byPrompt,
    wallMin: (prior.wallMin ?? 0) + (Date.now() - t0) / 60000,
    account: { email: cap.email, deleted, ...(swept.length ? { swept } : {}) } as CaptureFacts["account"],
    notes: [...((prior.notes as unknown[]) ?? []), ...cap.notes], failures, bootProof, dirtyTree,
  };
  writeFileSync(factsPath, JSON.stringify(facts, null, 2));
  return { views, facts };
}

async function main(): Promise<number> {
  const date = new Date().toISOString().slice(0, 10);
  const outDir = resolve(process.env.KIWI_COOKSIM_OUT ?? arg("--out") ?? join(KIWI_ROOT, "e2e", "out", `cooksim-${date}`));
  mkdirSync(outDir, { recursive: true });
  const size = Number(process.env.KIWI_COOKSIM_SIZE ?? 30);
  const seed = Number(process.env.KIWI_COOKSIM_SEED ?? 1028);
  const servingsList = (process.env.KIWI_COOKSIM_SERVINGS ?? "2,6").split(",").map(Number);
  const from = arg("--from");

  let views: CookView[];
  let facts: CaptureFacts;
  if (from) {
    views = JSON.parse(readFileSync(join(from, "views.json"), "utf8"));
    facts = JSON.parse(readFileSync(join(from, "capture.json"), "utf8"));
    console.log(`[qa-cook] ${views.length} views from ${from}`);
  } else {
    ({ views, facts } = await capture(outDir, size, seed, servingsList));
    console.log(`[qa-cook] capture: ${views.length} views, server AI $${facts.serverUsd.toFixed(3)} (${facts.serverCalls} calls), ${facts.wallMin.toFixed(1)} min, failures ${facts.failures.length}`);
  }

  await enrichIngredients(views);
  const sims = views.map((v) => ({ view: v, res: simulate(v) }));
  writeFileSync(join(outDir, "sim.json"), JSON.stringify(sims.map((x) => ({ meal: x.view.title, servings: x.view.servings, prepped: x.view.prepped, serveAt: x.res.serveAt, idle: x.res.idleMinutes, findings: x.res.findings })), null, 1));
  const n = sims.reduce((a, x) => a + x.res.findings.length, 0);
  console.log(`[qa-cook] simulator: ${n} findings over ${sims.length} views`);
  if (flag("--capture-only")) return 0;

  // ── the AI cooks ───────────────────────────────────────────────────────────
  const budget = Number(process.env.KIWI_COOKSIM_BUDGET_USD ?? 10);
  const model = process.env.KIWI_COOKSIM_MODEL ?? "claude-haiku-5-5";
  const compareModel = process.env.KIWI_COOKSIM_COMPARE_MODEL ?? "claude-sonnet-5-5";
  const compareN = Number(process.env.KIWI_COOKSIM_COMPARE ?? 5);
  const runsPath = join(outDir, "personas.json");
  const runs: PersonaRun[] = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, "utf8")) : [];
  const runKey = (persona: string, m: string, v: { sourceMealId: string; servings: number; prepped: boolean }) => `${persona}|${m}|${v.sourceMealId}|${v.servings}|${v.prepped}`;
  const doneKeys = new Set(runs.map((r) => runKey(r.persona, r.model, r.view)));
  const doneBefore = runs.length;
  const ledger = { spent: facts.serverUsd + runs.reduce((a, r) => a + r.usd, 0), perStep: {} as Record<string, number> };
  const t1 = Date.now();

  const runAll = async (jobs: { v: CookView; persona: PersonaId; m: string }[]) => {
    const client = new Anthropic({ apiKey: readDotEnv(API_ROOT).ANTHROPIC_API_KEY });
    let stopped = 0;
    await pool(jobs, 8, async (j) => {
      if (doneKeys.has(runKey(j.persona, j.m, j.v))) return;
      // The cap: start only when spent + this run's worst-case (its steps × the dearest step seen, ×1.5) fits.
      const perStep = ledger.perStep[j.m] ?? (j.m.includes("haiku") ? 0.0008 : 0.02);
      const reserve = perStep * (j.v.steps.length + 1) * 1.5;
      if (ledger.spent + reserve > budget) {
        stopped++;
        return;
      }
      ledger.spent += reserve;
      const r = await runPersona(client, j.v, j.persona, { model: j.m, effort: "low", seed, maxRunUsd: reserve * 2 });
      ledger.spent += r.usd - reserve;
      if (r.calls) ledger.perStep[j.m] = Math.max(ledger.perStep[j.m] ?? 0, r.usd / r.calls);
      runs.push(r);
      doneKeys.add(runKey(j.persona, j.m, j.v));
      writeFileSync(runsPath, JSON.stringify(runs, null, 1));
      console.log(`[qa-cook]   ${j.m.replace("claude-", "")} ${j.persona.padEnd(11)} ${j.v.servings}p ${j.v.prepped ? "prepped  " : "unprepped"} ${r.issues.length} issue(s) $${r.usd.toFixed(4)}${r.error ? ` ERROR ${r.error.slice(0, 80)}` : ""} · ${j.v.title.slice(0, 50)} · spent $${ledger.spent.toFixed(2)}`);
    });
    if (stopped) console.log(`[qa-cook] budget: ${stopped} run(s) not started ($${ledger.spent.toFixed(2)} of $${budget})`);
  };

  const personas: PersonaId[] = ["beginner", "weeknight", "interrupted"];
  const order = (v: CookView) => (v.prepped ? 2 : 0) + (v.servings === 6 ? 0 : 1);
  // The fajita meal first (the calibration), then unprepped 6 → 2, prepped 6 → 2.
  const ordered = [...views].sort((a, b) => Number(b.sourceMealId === FAJITA_MEAL_ID) - Number(a.sourceMealId === FAJITA_MEAL_ID) || order(a) - order(b));
  if (!flag("--no-personas")) {
    console.log(`[qa-cook] AI cooks: ${model}, ${ordered.length} sessions × ${personas.length}`);
    await runAll(ordered.flatMap((v) => personas.map((persona) => ({ v, persona, m: model }))));
  }

  // ── the model comparison: the same sessions, a stronger model ──
  let compare: ModelCompare | null = null;
  if (!flag("--no-personas") && compareN > 0) {
    const sample: SampleMeal[] = facts.sample;
    const pick = [FAJITA_MEAL_ID, ...["one-pan", "stove+oven", "multi-dish", "bread"].map((c) => sample.find((m) => m.category === c && m.id !== FAJITA_MEAL_ID)?.id)].filter((x): x is string => !!x).slice(0, compareN);
    const cv = views.filter((v) => pick.includes(v.sourceMealId) && v.servings === 6 && !v.prepped);
    console.log(`[qa-cook] comparison: ${compareModel} on ${cv.length} sessions × ${personas.length}`);
    await runAll(cv.flatMap((v) => personas.map((persona) => ({ v, persona, m: compareModel }))));
    compare = compareModels(cv, runs, [model, compareModel]);
  }
  // The AI cooks' wall time is the run's that made them: a report regenerated from cached runs keeps it.
  const metaPath = join(outDir, "personas-meta.json");
  const ranNow = runs.length > doneBefore;
  const personaMin = ranNow || !existsSync(metaPath) ? (Date.now() - t1) / 60000 + (existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")).wallMin : 0) : JSON.parse(readFileSync(metaPath, "utf8")).wallMin;
  if (ranNow) writeFileSync(metaPath, JSON.stringify({ wallMin: personaMin }, null, 2));

  // ── patterns and the report ──
  const mainRuns = runs.filter((r) => r.model === model);
  const hits = collectHits(sims.map((x) => ({ view: x.view, findings: x.res.findings })), mainRuns, views);
  writeFileSync(join(outDir, "patterns.json"), JSON.stringify({ patterns: rankPatterns(hits), hits }, null, 1));
  const personaUsd = mainRuns.reduce((a, r) => a + r.usd, 0);
  const report = renderReport({
    views, sims: sims.map((x) => ({ view: x.view, findings: x.res.findings, serveAt: x.res.serveAt })), runs: mainRuns, hits, compare,
    spend: { serverUsd: facts.serverUsd, serverCalls: facts.serverCalls, personaUsd, personaCalls: mainRuns.reduce((a, r) => a + r.calls, 0), compareUsd: runs.filter((r) => r.model !== model).reduce((a, r) => a + r.usd, 0), budgetUsd: budget },
    time: { captureMin: facts.wallMin, personaMin, totalMin: facts.wallMin + personaMin },
    facts: { runTag: facts.runTag, sampleSize: size, seed, failures: facts.failures, bootProof: facts.bootProof, dirtyTree: facts.dirtyTree, model },
  });
  writeFileSync(join(outDir, "summary.md"), report);
  console.log(`\n${report}`);
  console.log(`[qa-cook] wrote ${join(outDir, "summary.md")}`);
  return 0;
}

/**
 * A view captured before the views carried each dish's ingredient names (the
 * Sequencer's dishUses reads them to tell a dish's own onion from the slaw's)
 * gets them from its catalog source: the same dish titles, read-only, dev.
 */
async function enrichIngredients(views: CookView[]): Promise<void> {
  const missing = views.filter((v) => v.dishes.some((d) => !d.ingredientNames));
  if (missing.length === 0) return;
  const dotEnv = readDotEnv(API_ROOT);
  assertDev({ ...process.env, DATABASE_URL: dotEnv.DATABASE_URL });
  process.env.DATABASE_URL = dotEnv.DATABASE_URL;
  const prisma = new PrismaClient();
  try {
    const ids = [...new Set(missing.map((v) => v.sourceMealId))];
    const meals = await retryDb(() => prisma.meal.findMany({
      where: { id: { in: ids } },
      select: { id: true, dishLinks: { select: { dish: { select: { title: true, displayTitle: true, dishIngredients: { select: { ingredient: { select: { canonicalName: true } } } } } } } } },
    }));
    const names = new Map<string, string[]>();
    for (const m of meals) {
      for (const l of m.dishLinks) {
        const list = l.dish.dishIngredients.map((i) => i.ingredient.canonicalName);
        names.set(`${m.id}|${l.dish.title}`, list);
        if (l.dish.displayTitle) names.set(`${m.id}|${l.dish.displayTitle}`, list);
      }
    }
    for (const v of missing) for (const d of v.dishes) d.ingredientNames ??= names.get(`${v.sourceMealId}|${d.title}`) ?? [];
  } finally {
    await prisma.$disconnect();
  }
}

/** The same sessions under two models: counts, cost, the fajita, and what each found that the other did not. */
function compareModels(cv: CookView[], runs: PersonaRun[], models: string[]): ModelCompare {
  const ids = new Set(cv.map((v) => `${v.sourceMealId}|${v.servings}|${v.prepped}`));
  const inSet = (r: PersonaRun) => ids.has(`${r.view.sourceMealId}|${r.view.servings}|${r.view.prepped}`);
  const issuesOf = (m: string) => runs.filter((r) => r.model === m && inSet(r)).flatMap((r) => r.issues.map((i) => ({ meal: r.view.title, step: i.step, pattern: patternOfIssue(i, r.persona), what: i.whatWentWrong })));
  const byModel = Object.fromEntries(models.map((m) => [m, issuesOf(m)]));
  const onlyIn: ModelCompare["onlyIn"] = {};
  for (const m of models) {
    const others = models.filter((x) => x !== m).flatMap((x) => byModel[x]);
    onlyIn[m] = byModel[m].filter((i) => !others.some((o) => o.meal === i.meal && o.pattern === i.pattern && Math.abs(o.step - i.step) <= 1));
  }
  return {
    meals: [...new Set(cv.map((v) => v.title))],
    models: models.map((m) => {
      const rs = runs.filter((r) => r.model === m && inSet(r));
      const patterns: Record<string, number> = {};
      for (const i of byModel[m]) patterns[i.pattern] = (patterns[i.pattern] ?? 0) + 1;
      return {
        model: m, runs: rs.length, issues: byModel[m].length, usd: rs.reduce((a, r) => a + r.usd, 0), minutes: rs.reduce((a, r) => a + r.ms, 0) / 60000,
        patterns, fajita: rs.some((r) => r.view.sourceMealId === FAJITA_MEAL_ID && caughtFajita(r).length > 0), errors: rs.filter((r) => r.error).length,
      };
    }),
    onlyIn,
  };
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[qa-cook] ABORTED: ${String((err as Error).stack ?? err)}`);
    process.exit(2);
  },
);
