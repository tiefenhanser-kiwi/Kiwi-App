// [prepcook] Part J.0 B — regenerate Prep the Week (full plan) through the
// shipped route, on whatever model and prompt version the DB rows now say.
// PAID: one narration call per plan (plus retries).
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-j0/regen.ts --only A02,A07 [--budget 1.5]
//
// Fences as Part I: dev branch; test-account plans only; Prisma writes allowed
// on LLMCallLog and on prepWeekStructure / prepStepCompletion rows of the named
// plans (the route's own cache write and orphan-prune), nothing else.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import express from "express";

import { signToken } from "../../../src/lib/auth";
import { createCookingRouter } from "../../../src/routes/cooking";
import type { PrepWeekResult } from "../../../src/lib/ai/schemas/prepWeek";
import { FORBIDDEN_PLAN, TEST_USER_ID, loadCorpus } from "../part-i/corpus";

if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });
const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const ONLY = (arg("only", "") ?? "").split(",").filter(Boolean);
// Part J.1 — one named plan (Hans's e55a9305 needs --allow-hans too), a subset, an output dir.
const PLAN = arg("plan");
const ALLOW_HANS = process.argv.includes("--allow-hans");
const SUBSET = (arg("subset", "") ?? "").split(",").filter(Boolean);
const OUT_DIR = arg("out");
const BUDGET = Number(arg("budget", "1.5"));

const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const allowed = new Set<string>();
const realPrisma = new PrismaClient();
const prisma = new Proxy(realPrisma, {
  get(t, prop: string, r) {
    const v = Reflect.get(t, prop, r);
    if (typeof prop !== "string" || prop.startsWith("$") || v === null || typeof v !== "object") {
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    }
    if (prop === "lLMCallLog") return v;
    return new Proxy(v as object, {
      get(tt, op: string) {
        const f = Reflect.get(tt, op);
        if (WRITE_OPS.has(op)) {
          return (a: { where?: { planId?: string }; create?: { planId?: string } }) => {
            const pid = a?.where?.planId ?? a?.create?.planId;
            const ok = (prop === "prepWeekStructure" || prop === "prepStepCompletion") && !!pid && allowed.has(pid) && (pid !== FORBIDDEN_PLAN || ALLOW_HANS);
            if (!ok) throw new Error(`REFUSING ${prop}.${op} (${pid ?? "?"})`);
            return (f as (x: unknown) => unknown).call(tt, a);
          };
        }
        return typeof f === "function" ? (f as (...a: unknown[]) => unknown).bind(tt) : f;
      },
    });
  },
}) as PrismaClient;

function render(code: string, planId: string, status: number, body: { result?: PrepWeekResult; promptVersion?: number; error?: string; reason?: string }, titles: Map<string, string>): string {
  const L = [`PLAN ${planId}  [${code}]  HTTP ${status}`];
  if (status !== 200 || !body.result) return [...L, `  ${body.reason ?? ""} ${body.error ?? ""}`].join("\n");
  const r = body.result;
  L.push(`  HEADER: ${r.containerCount} containers · about ${r.estimatedMinutes} min · prompt v${body.promptVersion}`);
  for (const ph of r.phases) {
    L.push("", `  ── ${ph.phase} ──`);
    if (ph.note) L.push(`     » ${ph.note}`);
    for (const h of ph.heldForCookDay ?? []) L.push(`     HELD: ${h}`);
    for (const s of ph.steps) {
      L.push(`  ${s.skipSuggested ? "×" : " "} ${String(s.number).padStart(2)}. ${s.title}   (${s.estimatedMinutes} min)${s.skipSuggested ? "  [RENDER-OMITTED]" : ""}   [${s.instructions.length} chars]`);
      for (const line of s.instructions.split("\n")) L.push(`        ${line}`);
      if (s.storageNote) L.push(`        » storage: ${s.storageNote}`);
      if (s.coversCookSteps?.length) L.push(`        » covers cook steps: ${s.coversCookSteps.map((c) => `${titles.get(c.dishId) ?? c.dishId.slice(0, 8)}#${c.stepIndex}`).join(", ")}`);
    }
  }
  return L.join("\n");
}

async function main() {
  const rows = PLAN
    ? [{ code: PLAN === FORBIDDEN_PLAN ? "HANS-e55a9305" : ALLOW_HANS ? `HANS-${PLAN.slice(0, 8)}` : PLAN.slice(0, 8), planId: PLAN }]
    : (await loadCorpus(prisma)).filter((r) => ONLY.length === 0 || ONLY.includes(r.code));
  const app = express();
  app.use(express.json());
  const lim = { capacity: 10_000, refillPerSec: 10_000 };
  app.use("/api", createCookingRouter({ prisma, subscriptionService: { can: async () => ({ allowed: true }) } as never, rateLimiterOpts: lim, completionLimiterOpts: lim }));
  const server: Server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const a = server.address();
  const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/api`;
  const summary: Record<string, unknown>[] = [];
  let spent = 0;
  try {
    for (const row of rows) {
      if (row.planId === FORBIDDEN_PLAN && !ALLOW_HANS) throw new Error("REFUSING e55a9305 without --allow-hans");
      const owner = await realPrisma.mealPlanInstance.findUniqueOrThrow({ where: { id: row.planId }, select: { userId: true } });
      // Part J.1c — `--allow-hans` admits a plan on Hans's own account only when it is
      // named with --plan (J.1c regenerates his newest, f49f5209, as the prompt asks).
      const hans = (await realPrisma.mealPlanInstance.findUniqueOrThrow({ where: { id: FORBIDDEN_PLAN }, select: { userId: true } })).userId;
      const hansNamed = ALLOW_HANS && PLAN === row.planId && owner.userId === hans;
      if (owner.userId !== TEST_USER_ID && row.planId !== FORBIDDEN_PLAN && !hansNamed) throw new Error(`REFUSING ${row.planId}`);
      const token = signToken(owner.userId);
      if (spent >= BUDGET) { console.error(`BUDGET STOP $${spent.toFixed(3)}`); break; }
      allowed.add(row.planId);
      const t0 = new Date();
      const res = await fetch(`${base}/plans/${row.planId}/prep-week`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(SUBSET.length ? { body: JSON.stringify({ mealIds: SUBSET }) } : {}) });
      const body = await res.json();
      const logs = await realPrisma.lLMCallLog.findMany({
        where: { promptKey: "prep.narrate_steps", userId: owner.userId, createdAt: { gte: t0 } },
        select: { model: true, promptVersion: true, inputTokens: true, outputTokens: true, costEstimateUsd: true, success: true, failureReason: true, retryCount: true, latencyMs: true },
      });
      const cost = logs.reduce((s, l) => s + Number(l.costEstimateUsd ?? 0), 0);
      spent += cost;
      const items = await realPrisma.mealPlanItem.findMany({
        where: { mealPlanInstanceId: row.planId },
        select: { meal: { select: { dishLinks: { select: { dish: { select: { id: true, title: true } } } } } } },
      });
      const titles = new Map<string, string>(items.flatMap((i) => i.meal.dishLinks.map((l) => [l.dish.id, l.dish.title] as [string, string])));
      writeFileSync(join(OUT_DIR ?? OUT, `regen_${row.planId.slice(0, 8)}${SUBSET.length ? "_subset" : ""}.txt`), render(row.code, row.planId, res.status, body, titles));
      const steps = body.result ? (body.result as PrepWeekResult).phases.flatMap((p) => p.steps) : [];
      const s = {
        code: row.code, planId: row.planId, status: res.status, reason: body.reason ?? null, cacheHit: body.cacheHit ?? null,
        promptVersion: body.promptVersion ?? null, containerCount: body.result?.containerCount ?? null, estimatedMinutes: body.result?.estimatedMinutes ?? null,
        maxInstructions: Math.max(0, ...steps.map((x) => x.instructions.length)),
        calls: logs, costUsd: Number(cost.toFixed(4)),
      };
      summary.push(s);
      console.error(`${row.code.padEnd(10)} HTTP ${res.status} ${body.reason ?? ""} · v${s.promptVersion} · ${s.containerCount} containers · about ${s.estimatedMinutes} min · max ${s.maxInstructions} chars · ${logs.map((l) => `${l.model}/${l.success ? "ok" : l.failureReason}/r${l.retryCount}`).join(",")} · $${s.costUsd}`);
    }
  } finally {
    server.close();
  }
  let prior: Record<string, unknown>[] = [];
  try { prior = JSON.parse(readFileSync(join(OUT_DIR ?? OUT, "regen.json"), "utf8")); } catch { /* first run */ }
  writeFileSync(join(OUT_DIR ?? OUT, "regen.json"), JSON.stringify([...prior.filter((p) => !summary.some((s) => s.planId === p.planId)), ...summary], null, 2));
  console.error(`spent $${spent.toFixed(4)}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => realPrisma.$disconnect());
