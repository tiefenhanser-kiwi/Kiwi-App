// [prepcook] Part J.1 0e — GET /plans/:id latency: the pre-J.0 step-set loader vs
// the current one, through the shipped plans router, in-process, READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-j1/get-latency.ts [label] [n=12]
//
// "pre-J.0" is reconstructed here exactly as it shipped before 796b416: the loader
// WITHOUT step texts, buildStepPlan without text or lags, the blob's flags. The
// router takes `loadPrepStepSet` by injection, so the two arms share everything else.
import { appendFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import express from "express";

import { signToken } from "../../../src/lib/auth";
import { createPlansRouter } from "../../../src/routes/plans";
import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepCombineInput } from "../../../src/lib/prepCombineAdapter";
import { combinePrep } from "../../../src/lib/prepCombineEngine";
import { buildStepPlan } from "../../../src/lib/prepWeekAssembly";
import { demotedStepKeysFromStructure, loadPrepStepSet } from "../../../src/lib/prepStepSet";
import { TEST_USER_ID } from "../part-i/corpus";

if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const base = new PrismaClient();
const prisma = base.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
  if (WRITE_OPS.has(operation)) throw new Error(`WRITE BLOCKED: ${model}.${operation}`);
  return query(args);
} } } }) as unknown as PrismaClient;

const PLANS = ["873796cd-4e7e-4a4a-bdfe-28a802f295d7", "3f9d46e8-b078-4bd4-b479-9f93cb8c76cd", "b4aa6fee"];
const LABEL = process.argv[2] ?? "now";
const N = Number(process.argv[3] ?? 12);

/** The loader as it shipped before 796b416. */
const preJ0: typeof loadPrepStepSet = async ({ planId, userId, prisma: p }) => {
  const { input, identity } = await loadPrepWeekInput({ planId, userId, prisma: p, includeStepTexts: false });
  const plan = buildStepPlan(combinePrep(buildPrepCombineInput(input), identity?.foldedIdByIngredientId), input.planName);
  const refs = plan.steps.filter((s) => !s.holdsNoContainer).map((s) => ({ stepKey: s.stepKey, contributesToMealIds: s.contributesToMealIds }));
  const cached = await p.prepWeekStructure.findUnique({ where: { planId } });
  const demoted = demotedStepKeysFromStructure(cached?.structureJson);
  return refs.filter((r) => !demoted.has(r.stepKey));
};

async function serve(loader: typeof loadPrepStepSet) {
  const app = express();
  app.use(express.json());
  const lim = { capacity: 10_000, refillPerSec: 10_000 };
  app.use("/api", createPlansRouter({ prisma, loadPrepStepSet: loader, subscriptionService: { can: async () => ({ allowed: true }) } as never, rateLimiterOpts: lim, mutationLimiterOpts: lim } as never));
  const s: Server = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const a = s.address();
  return { base: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/api`, close: () => s.close() };
}

const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  const token = signToken(TEST_USER_ID);
  const ids: string[] = [];
  for (const p of PLANS) ids.push((await base.mealPlanInstance.findFirstOrThrow({ where: { id: { startsWith: p }, userId: TEST_USER_ID }, select: { id: true } })).id);
  const arms: [string, typeof loadPrepStepSet][] = [["pre-J.0", preJ0], [LABEL, loadPrepStepSet]];
  const out: Record<string, Record<string, number>> = {};
  for (const [name, loader] of arms) {
    const srv = await serve(loader);
    for (const id of ids) {
      const t: number[] = [];
      for (let i = 0; i < N + 2; i++) {
        const t0 = performance.now();
        const r = await fetch(`${srv.base}/plans/${id}`, { headers: { authorization: `Bearer ${token}` } });
        await r.json();
        if (r.status !== 200) throw new Error(`GET ${r.status}`);
        if (i >= 2) t.push(performance.now() - t0); // two warm-ups
      }
      (out[id.slice(0, 8)] ??= {})[name] = Math.round(p50(t));
    }
    srv.close();
  }
  const line = Object.entries(out).map(([k, v]) => `${k} pre-J.0 ${v["pre-J.0"]} ms · ${LABEL} ${v[LABEL]} ms · Δ ${v[LABEL] - v["pre-J.0"]} ms`).join("\n");
  console.log(line);
  appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "get-latency.txt"), `## ${new Date().toISOString()} ${LABEL} (n=${N})\n${line}\n`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => base.$disconnect());
