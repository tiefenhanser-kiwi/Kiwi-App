// QA-NIGHT-1 — the night run. DEV ONLY.
//
//   from artifacts/kiwi:   pnpm run qa:night
//   env: KIWI_QA_BUDGET_USD (default 15) · KIWI_QA_HOUSEHOLDS=1,6,10 (default all)
//        KIWI_QA_UI=0 to skip the browser pass · KIWI_QA_OUT=<dir> (default
//        artifacts/kiwi/e2e/out/night-<date>)
//        --cook-sim (or KIWI_QA_COOK_SIM=1): the kitchen simulator on every
//        household's Cook Mode sessions and the AI home cooks on 5 rotating meals
//        (scripts/qa-cook; cookSim.ts) — its own section in summary.md
//        KIWI_QA_PORT=<n> with KIWI_QA_UI=0: the child on another port (API only)
//
// In order: the dev-database fence; its own api-server on :3100 with every mail
// switch off, proven from the child's own boot output (server.ts); the
// households, each through the real API, reconciled (R1–R11), its spend read
// from LLMCallLog and its account deleted and proven gone; the browser pass
// (web export --clear, the :9410 proxy, the qa-night spec); the morning summary.
// Exit 1 when a NEW high-severity finding exists (or the run could not start).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase, DEV_HOST_MARKER } from "../../src/lib/scripts/requireDatabaseHost";
import { Client } from "./http";
import { Household, type HouseholdSpec } from "./journeys";
import { reconcileR1, reconcileR2 } from "./reconcileGrocery";
import { reconcileR10, reconcileR11 } from "./reconcilePrepCook";
import { QA_PORT, readDotEnv, startServer, stopServer, type OwnedServer } from "./server";
import { type CookSimNight, cookSimWanted, emptyNight, householdViews, nightHits, renderNight, runNightCooks, simulateAll } from "./cookSim";
import type { CookView } from "../qa-cook/types";
import { addTally, EMPTY_TALLY, mayStart, tallySpend, type SpendTally } from "./spend";
import { type KnownBug, matchKnown, newHigh, renderSummary, type RunFacts } from "./summary";
import type { CallRecord, Finding, RuleResult } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const KIWI_ROOT = resolve(API_ROOT, "..", "kiwi");
export const WEB_PORT = 9410;

/** 🔴 The fence, before anything: the dev branch, and only the dev branch (no production override). */
export function assertDevDatabase(env: NodeJS.ProcessEnv): void {
  const { host, mode } = assertScriptDatabase("qa-night", env);
  if (mode !== "dev" || !host.includes(DEV_HOST_MARKER)) throw new Error("refusing: qa-night runs on the dev branch only");
}

async function main(): Promise<number> {
  const t0 = Date.now();
  const dotEnv = readDotEnv(API_ROOT);
  assertDevDatabase({ ...process.env, DATABASE_URL: dotEnv.DATABASE_URL });
  process.env.DATABASE_URL = dotEnv.DATABASE_URL;
  console.log("[qa-night] dev database: PASS (ep-broad-haze)");

  const date = new Date().toISOString().slice(0, 10);
  const runTag = `${date.replace(/-/g, "").slice(2)}${Date.now().toString(36).slice(-4)}`;
  const outDir = resolve(process.env.KIWI_QA_OUT ?? join(KIWI_ROOT, "e2e", "out", `night-${date}`));
  mkdirSync(outDir, { recursive: true });
  const budget = Number(process.env.KIWI_QA_BUDGET_USD ?? 15);
  const all = (JSON.parse(readFileSync(join(HERE, "households.json"), "utf8")) as { households: HouseholdSpec[] }).households;
  const wanted = process.env.KIWI_QA_HOUSEHOLDS ? new Set(process.env.KIWI_QA_HOUSEHOLDS.split(",").map((s) => s.trim())) : null;
  const specs = all.filter((h) => !wanted || wanted.has(h.id));
  const known = (JSON.parse(readFileSync(join(HERE, "known.json"), "utf8")) as { known: KnownBug[] }).known;
  const withUi = process.env.KIWI_QA_UI !== "0";
  // QA-COOK-1 (E) — the cook simulation, and KIWI_QA_PORT for a second night run beside one on :3100 (API only: the UI pass's proxy is wired to :3100).
  const night: CookSimNight | null = cookSimWanted(process.argv, process.env) ? emptyNight() : null;
  const port = Number(process.env.KIWI_QA_PORT ?? QA_PORT);
  const api = `http://localhost:${port}/api`;
  if (port !== QA_PORT && withUi) throw new Error(`KIWI_QA_PORT=${port} needs KIWI_QA_UI=0: the browser pass is wired to :${QA_PORT}`);

  const server: OwnedServer = await startServer(API_ROOT, outDir, port);
  const bootProof = `RESEND_API_KEY ${server.proof.RESEND_API_KEY}, SIGNUP_ALERT_TO ${server.proof.SIGNUP_ALERT_TO}, LIFECYCLE_EMAIL_ENABLED ${server.proof.LIFECYCLE_EMAIL_ENABLED} (child pid ${server.proof.pid}, :${port}; server line "lifecycle email: off")`;
  console.log(`[qa-night] api-server child on :${port} — ${bootProof}`);

  const prisma = new PrismaClient();
  const calls: CallRecord[] = [];
  const results: RuleResult[] = [];
  const facts: RunFacts = {
    date, runTag, households: [], skipped: [], spendUsd: 0, budgetUsd: budget, spendByPrompt: {},
    wallMin: 0, accountsCreated: 0, accountsDeleted: 0, accountsLeft: [], bootProof, ui: withUi ? "pending" : "off (KIWI_QA_UI=0)",
  };
  let spend: SpendTally = { ...EMPTY_TALLY, byPrompt: {} };
  let worstSeen = 0;
  const outcomes: unknown[] = [];
  let cookMeals: CookView[] = [];

  try {
    for (const spec of specs) {
      const reserve = Math.max(spec.estimateUsd, worstSeen);
      if (!mayStart(spend.usd, reserve, budget)) {
        facts.skipped.push({ id: spec.id, reason: `budget: $${spend.usd.toFixed(2)} spent + $${reserve.toFixed(2)} reserved > $${budget}` });
        console.log(`[qa-night] h${spec.id} SKIPPED — budget`);
        continue;
      }
      console.log(`[qa-night] h${spec.id} ${spec.label} …`);
      const started = new Date(Date.now() - 2000);
      const h = new Household(spec, runTag, new Client(api, spec.id, calls), prisma);
      const ht0 = Date.now();
      await runHousehold(h, night);
      // R10 and the spend are read BEFORE the delete: DELETE /me nulls LLMCallLog.userId.
      if (h.out.userId) {
        const plans = Object.keys(h.out.ticksPut).length ? Object.keys(h.out.ticksPut) : h.out.planId ? [h.out.planId] : [];
        const r10Plans = await Promise.all(plans.map(async (planId) => ({
          planId, label: `plan ${planId.slice(0, 8)}`, ticksPut: h.out.ticksPut[planId] ?? 0,
          prepStartedRows: await prisma.userActivity.count({ where: { userId: h.out.userId!, eventType: "plan_prep_started", entityId: planId } }),
        })));
        const cookRows = await prisma.userActivity.count({ where: { userId: h.out.userId, eventType: "cook_finished" } });
        h.push(reconcileR10(spec.id, { plans: r10Plans, finishesRecorded: h.out.finishesRecorded, cookFinishedRows: cookRows }));
      }
      const mine = await tallySpend(prisma, { userIds: h.out.userId ? [h.out.userId] : [], guestSessionIds: h.out.guestSessionId ? [h.out.guestSessionId] : [] }, started);
      await h.path("delete account", () => h.deleteAccount());
      spend = addTally(spend, mine);
      worstSeen = Math.max(worstSeen, mine.usd);
      if (h.out.email) facts.accountsCreated++;
      if (h.out.deleted.status === 204 && h.out.deleted.rowGone) facts.accountsDeleted++;
      else if (h.out.email) {
        h.push({ rule: "R11", checked: 1, findings: [{ rule: "R11", signature: "R11:account-not-deleted", severity: "high", household: spec.id, detail: `DELETE /me → ${h.out.deleted.status}; GET /auth/me after → ${h.out.deleted.meAfter}; row gone ${h.out.deleted.rowGone}` }] });
      }
      h.push(reconcileR11(spec.id, calls.filter((c) => c.household === spec.id)));
      h.out.wallMs = Date.now() - ht0;
      results.push(...h.out.results);
      const failedPaths = Object.values(h.out.paths).filter((v) => v !== "ran").length;
      facts.households.push({ id: spec.id, label: spec.label, status: failedPaths ? `ran (${failedPaths} path${failedPaths > 1 ? "s" : ""} failed)` : "ran", usd: mine.usd, wallMin: h.out.wallMs / 60000, paths: h.out.paths });
      outcomes.push({ ...h.out, spend: mine });
      writeFileSync(join(outDir, `household-${spec.id}.json`), JSON.stringify({ ...h.out, spend: mine }, null, 2));
      console.log(`[qa-night] h${spec.id} done — $${mine.usd.toFixed(3)}, ${(h.out.wallMs / 60000).toFixed(1)} min, ${h.out.results.reduce((n, r) => n + r.findings.length, 0)} finding(s)`);
    }

    // ── the AI home cooks (QA-COOK-1 E): tonight's 5 meals, inside the budget ─
    if (night) {
      const cookReserve = 0.5;
      if (!mayStart(spend.usd, cookReserve, budget)) {
        cookMeals = [];
        console.log(`[qa-night] cook sim: AI cooks skipped — budget ($${spend.usd.toFixed(2)} + $${cookReserve} > $${budget})`);
      } else {
        cookMeals = await runNightCooks(night, { apiKey: dotEnv.ANTHROPIC_API_KEY, date, model: process.env.KIWI_COOKSIM_MODEL ?? "claude-haiku-5-5", budgetLeftUsd: Math.min(cookReserve, budget - spend.usd), seed: 1028 });
        spend = addTally(spend, { calls: night.runs.reduce((n, r) => n + r.calls, 0), usd: night.usd, failures: night.runs.filter((r) => r.error).length, byPrompt: { "qa-cook.persona (direct)": { calls: night.runs.reduce((n, r) => n + r.calls, 0), usd: night.usd } } });
      }
      console.log(`[qa-night] cook sim: ${night.views.length} sessions simulated, AI cooks on ${cookMeals.length} meals ($${night.usd.toFixed(3)})`);
    }

    // ── the browser pass ────────────────────────────────────────────────────
    if (withUi) {
      const uiReserve = 1.5;
      if (!mayStart(spend.usd, uiReserve, budget)) {
        facts.ui = `skipped — budget ($${spend.usd.toFixed(2)} + $${uiReserve} > $${budget})`;
      } else {
        const started = new Date(Date.now() - 2000);
        const ui = await runUiPass(outDir, runTag);
        facts.ui = ui.summary;
        results.push(...ui.results);
        if (ui.userId) {
          const t = await tallySpend(prisma, { userIds: [ui.userId], guestSessionIds: [] }, started);
          spend = addTally(spend, t);
          facts.accountsCreated++;
          const gone = (await prisma.user.findUnique({ where: { id: ui.userId }, select: { id: true } })) === null;
          if (gone) facts.accountsDeleted++;
        }
      }
    }
  } finally {
    // Every account this run made must be gone: by the run's own address pattern.
    const left = await prisma.user.findMany({ where: { email: { startsWith: `qa-night-${runTag}-` } }, select: { email: true } });
    facts.accountsLeft = left.map((u) => u.email);
    if (left.length) {
      results.push({ rule: "R11", checked: 1, findings: left.map<Finding>((u) => ({ rule: "R11", signature: "R11:account-left-behind", severity: "high", household: "run", detail: `account ${u.email} still exists after the run` })) });
    }
    await prisma.$disconnect();
    await stopServer(server);
  }

  for (const r of results) for (const f of r.findings) f.known = matchKnown(f, known);
  facts.spendUsd = spend.usd;
  facts.spendByPrompt = spend.byPrompt;
  facts.wallMin = (Date.now() - t0) / 60000;
  // The cook simulation has its own section; its findings never move the exit code.
  const summary = renderSummary(results, facts) + (night ? `\n${renderNight(night, cookMeals)}` : "");
  writeFileSync(join(outDir, "summary.md"), summary);
  writeFileSync(join(outDir, "findings.json"), JSON.stringify({ facts, findings: results.flatMap((r) => r.findings), checked: results.map((r) => ({ rule: r.rule, checked: r.checked, findings: r.findings.length })), ...(night ? { cookSim: { views: night.views.length, usd: night.usd, meals: cookMeals.map((v) => v.title), hits: nightHits(night) } } : {}) }, null, 2));
  if (night) writeFileSync(join(outDir, "cook-sim.json"), JSON.stringify({ views: night.views, runs: night.runs }, null, 1));
  writeFileSync(join(outDir, "calls.json"), JSON.stringify(calls, null, 1));
  console.log(`\n${summary}`);
  console.log(`[qa-night] wrote ${join(outDir, "summary.md")}`);
  const fresh = newHigh(results);
  return fresh.length > 0 ? 1 : 0;
}

async function runHousehold(h: Household, night: CookSimNight | null): Promise<void> {
  const s = h.spec;
  if (!(await h.path("sign up + onboarding", () => h.signUp()))) return;
  if (!(await h.path("plan", () => h.makePlan()))) return;
  await h.path("load meals", async () => {
    h.meals = (await h.loadMeals()).meals;
  });
  let before: Awaited<ReturnType<Household["grocery"]>> | null = null;
  await h.path("grocery", async () => {
    before = await h.grocery();
    h.push(reconcileR1(s.id, before));
    h.push(reconcileR2(s.id, before));
    await h.checkThird(before);
  });
  for (const e of s.edits) {
    await h.path(`edit: ${e}`, async () => {
      if (!before) throw new Error("no list to follow (grocery failed)");
      await h.edit(e, before);
    });
  }
  await h.path("Cook Mode unprepped", () => h.cookUnprepped());
  if (night) await h.path("cook sim: unprepped", async () => simulateAll(night, await householdViews(h, "unprepped")));
  for (const p of s.prep) {
    if (p === "full") await h.path("Prep the Week full", () => h.prepFull());
    if (p === "partial") await h.path("Prep the Week partial", () => h.prepPartial());
    if (p === "subset") await h.path("Prep selected meals (2 of N)", () => h.prepSubset("subset"));
    if (p === "one-meal") await h.path("Prep one meal", () => h.prepSubset("one-meal"));
    if (p === "recipes-yes") await h.path("Recipes · Yes, I prepped", () => h.recipesYes());
    if (p === "feast") await h.path("the feast", () => h.feast());
  }
  if (night && s.prep.length) await h.path("cook sim: after prep", async () => simulateAll(night, await householdViews(h, "after prep")));
  await h.path("finish a cook", () => h.finish());
}

// ── the browser pass ─────────────────────────────────────────────────────────

interface UiOutcome {
  summary: string;
  results: RuleResult[];
  userId: string | null;
}

function pnpm(args: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string): number {
  // Windows runs pnpm.cmd through a shell, which splits an unquoted "C:\Cooking App\…".
  const win = process.platform === "win32";
  const argv = win ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  const r = spawnSync(win ? "pnpm.cmd" : "pnpm", argv, { cwd, env, encoding: "utf8", shell: win, maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(logFile, `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  return r.status ?? -1;
}

async function runUiPass(outDir: string, runTag: string): Promise<UiOutcome> {
  const dist = join(outDir, "dist");
  console.log("[qa-night] UI: expo export --platform web --clear …");
  const exported = pnpm(["exec", "expo", "export", "--platform", "web", "--clear", "--output-dir", dist], KIWI_ROOT, { ...process.env, EXPO_PUBLIC_API_BASE_URL: `http://localhost:${WEB_PORT}/api` }, join(outDir, "export.log"));
  if (exported !== 0 || !existsSync(join(dist, "index.html"))) {
    return { summary: `FAILED — web export exited ${exported} (export.log)`, results: [], userId: null };
  }
  const proxy = spawn(process.execPath, [join(KIWI_ROOT, "e2e", "src", "nightProxy.cjs")], {
    env: { ...process.env, KIWI_QA_WEB_PORT: String(WEB_PORT), KIWI_QA_API_PORT: String(QA_PORT), KIWI_QA_DIST: dist },
    stdio: "ignore", windowsHide: true,
  });
  try {
    for (let i = 0; i < 40; i++) {
      const up = await fetch(`http://localhost:${WEB_PORT}/api/healthz`).then((r) => r.ok).catch(() => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const resultFile = join(outDir, "ui-result.json");
    const status = pnpm(
      ["exec", "playwright", "test", "-c", "e2e/playwright.config.ts", "e2e/specs/qa-night.spec.ts"],
      KIWI_ROOT,
      {
        ...process.env,
        KIWI_E2E_WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
        KIWI_E2E_API_ORIGIN: `http://localhost:${QA_PORT}`,
        KIWI_E2E_RUN_ID: `night-${runTag}-ui`,
        KIWI_QA_NIGHT: "1",
        KIWI_QA_RUN_TAG: runTag,
        KIWI_QA_UI_RESULT: resultFile,
      },
      join(outDir, "ui.log"),
    );
    if (!existsSync(resultFile)) return { summary: `FAILED — playwright exited ${status} with no result (ui.log)`, results: [], userId: null };
    const ui = JSON.parse(readFileSync(resultFile, "utf8")) as { userId: string | null; checks: { name: string; pass: boolean; detail: string }[]; consoleErrors: string[]; apiErrors: string[] };
    const findings: Finding[] = ui.checks.filter((c) => !c.pass).map((c) => ({ rule: "R11", signature: `R11:ui:${c.name}`, severity: "medium", household: "ui", detail: c.detail }));
    const results: RuleResult[] = [
      { rule: "R11", checked: ui.checks.length, findings },
      reconcileR11("ui", [], [...ui.consoleErrors, ...ui.apiErrors]),
    ];
    const passed = ui.checks.filter((c) => c.pass).length;
    return { summary: `${passed}/${ui.checks.length} screen checks, ${ui.consoleErrors.length} console error(s), playwright exit ${status}`, results, userId: ui.userId };
  } finally {
    proxy.kill();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[qa-night] ABORTED: ${String((err as Error).stack ?? err)}`);
    process.exit(2);
  },
);

