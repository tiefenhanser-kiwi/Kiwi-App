// [prepcook] Part J.0 — the prepped path, the subset and the portion lines, over
// the Part I corpus, through the SHIPPED routes. No AI call.
//
// Why no narration is needed: what renders, what is required and every stepKey
// are the engine's and the overlay's (the narrator's skipSuggested is ignored
// since H7 2c). So the wire is assembled with stand-in prose by the same
// `buildPrepWeekPlan` the route uses, rendered with the PHONE's own
// `buildPrepWeekModel`, and the ticks go through PUT …/completions and are read
// back off GET /plans/:id — exactly what Part I did.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-j0/ticks.ts
//
// Fences as Part I: dev branch only; test-account plans only; every Prisma write
// proxied and allowed only on prepStepCompletion rows of a corpus plan; every
// completion this run adds is deleted again.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import express from "express";

import { signToken } from "../../../src/lib/auth";
import { createCookingRouter } from "../../../src/routes/cooking";
import { createPlansRouter } from "../../../src/routes/plans";
import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepWeekPlan, finishPrepWeek, tickableStepRefs, type PrepWeekBuild } from "../../../src/lib/prepWeekBuild";
import { assemblePrepWeekResult, summarizePrepWeek, OPENING_MAX } from "../../../src/lib/prepWeekAssembly";
import { PrepWeekResultSchema, type PrepWeekResult } from "../../../src/lib/ai/schemas/prepWeek";
import * as prepWeekModelNs from "../../../../kiwi/lib/cooking/prepWeekModel";

import { FORBIDDEN_PLAN, TEST_USER_ID, loadCorpus } from "../part-i/corpus";

if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
  throw new Error("REFUSING: DATABASE_URL is not the dev branch");
}
const m = prepWeekModelNs as unknown as { default?: typeof prepWeekModelNs } & typeof prepWeekModelNs;
const { buildPrepWeekModel, buildMealLabelLookup } = (m.buildPrepWeekModel ? m : m.default!) as typeof prepWeekModelNs;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });
const PART_I_OUT = join(HERE, "..", "part-i", "out");

// ── fence ───────────────────────────────────────────────────────────────────
const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const allowed = new Set<string>();
const realPrisma = new PrismaClient();
const prisma = new Proxy(realPrisma, {
  get(t, prop: string, r) {
    const v = Reflect.get(t, prop, r);
    if (typeof prop !== "string" || prop.startsWith("$") || v === null || typeof v !== "object") {
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    }
    return new Proxy(v as object, {
      get(tt, op: string) {
        const f = Reflect.get(tt, op);
        if (WRITE_OPS.has(op)) {
          return (a: { where?: { planId?: string; planId_stepKey?: { planId: string } }; create?: { planId?: string } }) => {
            const pid = a?.where?.planId ?? a?.where?.planId_stepKey?.planId ?? a?.create?.planId;
            if (prop !== "prepStepCompletion" || !pid || !allowed.has(pid) || pid === FORBIDDEN_PLAN) {
              throw new Error(`REFUSING ${prop}.${op} (${pid ?? "?"})`);
            }
            return (f as (x: unknown) => unknown).call(tt, a);
          };
        }
        return typeof f === "function" ? (f as (...a: unknown[]) => unknown).bind(tt) : f;
      },
    });
  },
}) as PrismaClient;

async function spinUp() {
  const app = express();
  app.use(express.json());
  const allow = { can: async () => ({ allowed: true }) } as never;
  const lim = { capacity: 10_000, refillPerSec: 10_000 };
  app.use("/api", createCookingRouter({ prisma, subscriptionService: allow, rateLimiterOpts: lim, completionLimiterOpts: lim }));
  app.use("/api", createPlansRouter({ prisma, subscriptionService: allow, rateLimiterOpts: lim, mutationLimiterOpts: lim }));
  return await new Promise<{ base: string; close: () => Promise<void> }>((res) => {
    const s: Server = app.listen(0, () => {
      const a = s.address();
      res({ base: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/api`, close: () => new Promise((r) => s.close(() => r())) });
    });
  });
}
const TOKEN = signToken(TEST_USER_ID);
async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json()) as T };
}

/** The route's assembly with stand-in prose ("Do it."), then the overlay — the wire minus prose. */
function wire(build: PrepWeekBuild): PrepWeekResult {
  const narration = { steps: build.stepPlan.narrationInput.steps.map((s) => ({ stepId: s.stepId, title: "Do it", instructions: "x".repeat(Number(process.env.OPENING ?? OPENING_MAX)) })) };
  const res = summarizePrepWeek(finishPrepWeek(assemblePrepWeekResult(build.stepPlan, narration), build));
  const v = PrepWeekResultSchema.safeParse(res);
  if (!v.success) throw new Error(`WIRE INVALID: ${JSON.stringify(v.error.flatten()).slice(0, 400)}`);
  return v.data;
}
type Items = { mealId: string; assignedDayOfWeek: string | null; meal: { title: string } }[];
/** The phone's tickable set: buildPrepWeekModel's rendered steps. */
function phoneKeys(res: PrepWeekResult, items: Items): Set<string> {
  const vm = buildPrepWeekModel(res as never, { mealLabel: buildMealLabelLookup(items as never) });
  return new Set(vm.phases.flatMap((p) => p.steps.map((s) => s.stepKey)));
}

async function getItems(base: string, planId: string) {
  const r = await call<{ plan: { items: { mealId: string; isPrepped: boolean; assignedDayOfWeek: string | null; meal: { title: string } }[] } }>(base, "GET", `/plans/${planId}`);
  if (r.status !== 200) throw new Error(`GET ${r.status}`);
  return r.json.plan.items;
}

async function main() {
  const rows = await loadCorpus(prisma);
  const server = await spinUp();
  const out: Record<string, unknown>[] = [];
  try {
    for (const row of rows) {
      if (row.planId === FORBIDDEN_PLAN) throw new Error("REFUSING e55a9305");
      const owner = await realPrisma.mealPlanInstance.findUniqueOrThrow({ where: { id: row.planId }, select: { userId: true } });
      if (owner.userId !== TEST_USER_ID) throw new Error(`REFUSING ${row.planId}`);
      allowed.add(row.planId);
      const partI = JSON.parse(readFileSync(join(PART_I_OUT, `${row.planId.slice(0, 8)}.json`), "utf8")) as {
        code: string; full: { status: number }; subsetMealIds: string[];
        prepped: null | { mealId: string; mealTitle: string; isPreppedAfterRendered: boolean | null };
        subsetTick: { isPrepped: Record<string, boolean | null> };
      };
      const pre = new Set((await realPrisma.prepStepCompletion.findMany({ where: { planId: row.planId }, select: { stepKey: true } })).map((r) => r.stepKey));
      const added = new Set<string>();
      const tick = async (keys: Iterable<string>) => {
        for (const k of keys) {
          const r = await call(server.base, "PUT", `/plans/${row.planId}/prep-week/completions`, { stepKey: k });
          if (r.status !== 200) throw new Error(`PUT ${r.status}`);
          if (!pre.has(k)) added.add(k);
        }
      };
      const cleanup = async () => {
        if (added.size) await prisma.prepStepCompletion.deleteMany({ where: { planId: row.planId, stepKey: { in: [...added] } } });
        added.clear();
      };

      const load = await loadPrepWeekInput({ planId: row.planId, userId: TEST_USER_ID, prisma });
      const items = (await getItems(server.base, row.planId)) as Items & { isPrepped: boolean }[];
      const full = buildPrepWeekPlan(load);
      const fullWire = wire(full);
      const fullPhone = phoneKeys(fullWire, items);
      const washKeys = new Set(fullWire.phases.flatMap((p) => p.steps.filter((s) => s.holdsNoContainer).map((s) => s.stepKey)));
      const derived = new Set(tickableStepRefs(full).map((r) => r.stepKey));
      const phoneNoWash = new Set([...fullPhone].filter((k) => !washKeys.has(k)));
      const a1 = { derivedNotRendered: [...derived].filter((k) => !phoneNoWash.has(k)), renderedNotDerived: [...phoneNoWash].filter((k) => !derived.has(k)) };

      // ── B: the code-rendered portion lines on the wire, with a WORST-CASE opening ──
      const portionSteps = fullWire.phases.flatMap((p) => p.steps).filter((s) => s.instructions.includes("\n") && s.instructions.startsWith("xxxx"));
      const b = {
        portionSteps: portionSteps.length,
        maxInstructions: Math.max(0, ...fullWire.phases.flatMap((p) => p.steps.map((s) => s.instructions.length))),
        overCap: portionSteps.filter((s) => s.instructions.length > 800).length,
        linesWithoutDestination: portionSteps.flatMap((s) => s.instructions.split("\n").slice(1)).filter((l) => !/ — (into the |same |the same )/.test(l)),
        labelTwice: portionSteps.filter((s) => {
          const labels = [...s.instructions.matchAll(/"([^"]+ — [^"]+)"/g)].map((x) => x[1]);
          return new Set(labels).size !== labels.length;
        }).length,
        shortTubSteps: portionSteps.filter((s) => s.instructions.split("\n").slice(1).some((l) => / — into the [^"]+ tub$/.test(l))).length,
        trimmed: portionSteps.filter((s) => s.instructions.endsWith("…")).length,
        plusMore: (fullWire.phases.flatMap((p) => p.steps.flatMap((s) => s.containerNames ?? []))).filter((n) => /\+\d+ more|…$/.test(n)),
      };

      // ── A1/A2: the census prepped-path meal, every rendered step for it ticked ──
      let prepped: Record<string, unknown> | null = null;
      if (partI.prepped) {
        const target = partI.prepped.mealId;
        const mine = fullWire.phases.flatMap((p) => p.steps).filter((s) => s.contributesToMealIds.includes(target) && fullPhone.has(s.stepKey)).map((s) => s.stepKey);
        try {
          await tick(mine);
          const after = await getItems(server.base, row.planId);
          prepped = { meal: partI.prepped.mealTitle, before: partI.prepped.isPreppedAfterRendered, after: after.find((i) => i.mealId === target)?.isPrepped ?? null, ticked: mine.length };
        } finally { await cleanup(); }
      }

      // ── A3: the census subset, built whole then scoped ──
      const sub = buildPrepWeekPlan(load, { scopeMealIds: partI.subsetMealIds });
      const subWire = wire(sub);
      const subPhone = phoneKeys(subWire, items);
      const fullStepByKey = new Map(full.stepPlan.steps.map((s) => [s.stepKey, s]));
      const notInFull = sub.stepPlan.steps.filter((s) => !fullStepByKey.has(s.stepKey)).map((s) => s.stepKey);
      const names = (s: (typeof full.stepPlan.steps)[number]) => [s.bowlName ?? "", ...s.components.flatMap((c) => c.measures.map((x) => x.destination ?? ""))].filter(Boolean);
      const nameDiffs = sub.stepPlan.steps.flatMap((s) => {
        const twin = fullStepByKey.get(s.stepKey);
        return twin ? names(s).filter((n) => !names(twin).includes(n)).map((n) => `${s.stepKey}: ${n}`) : [];
      });
      const amt = (b: PrepWeekBuild) => new Map(b.stepPlan.steps.flatMap((s) => s.components.flatMap((c) => c.measures.filter((x) => partI.subsetMealIds.includes(x.mealId ?? "")).map((x) => [`${s.stepKey}|${x.mealId}|${x.dishId}|${c.ingredientName}`, x.amount] as const))));
      const fa = amt(full);
      const qtyDiffs = [...amt(sub)].filter(([k, v]) => fa.get(k) !== v).map(([k, v]) => `${k}: ${v} vs ${fa.get(k)}`);
      let subsetIsPrepped: Record<string, boolean | null> = {};
      try {
        await tick(subPhone);
        const after = await getItems(server.base, row.planId);
        subsetIsPrepped = Object.fromEntries(partI.subsetMealIds.map((id) => [id, after.find((i) => i.mealId === id)?.isPrepped ?? null]));
      } finally { await cleanup(); }

      // ── A4: coversCookSteps on the wire ──
      const covers = fullWire.phases.flatMap((p) => p.steps).filter((s) => s.coversCookSteps?.length);
      const coveredCook = new Set(covers.flatMap((s) => s.coversCookSteps!.map((c) => `${c.dishId}#${c.stepIndex}`)));

      const rec = {
        code: partI.code, planId: row.planId, partIFullStatus: partI.full.status,
        a1, b, prepped,
        subset: { mealIds: partI.subsetMealIds, before: partI.subsetTick.isPrepped, after: subsetIsPrepped, notInFull, nameDiffs, qtyDiffs, steps: sub.stepPlan.steps.length },
        a4: { prepStepsWithCovers: covers.length, coveredCookSteps: coveredCook.size, sample: covers.slice(0, 2).map((s) => ({ stepKey: s.stepKey, title: s.title, coversCookSteps: s.coversCookSteps })) },
      };
      out.push(rec);
      console.error(`${partI.code.padEnd(10)} A1 ${a1.derivedNotRendered.length}/${a1.renderedNotDerived.length} · prepped ${prepped ? `${prepped.before}→${prepped.after}` : "-"} · subset ${JSON.stringify(Object.values(partI.subsetTick.isPrepped))}→${JSON.stringify(Object.values(subsetIsPrepped))} notInFull ${notInFull.length} names ${nameDiffs.length} qty ${qtyDiffs.length} · B max ${b.maxInstructions} over ${b.overCap} nodest ${b.linesWithoutDestination.length} twice ${b.labelTwice} short ${b.shortTubSteps} trim ${b.trimmed} +more ${b.plusMore.length} · covers ${coveredCook.size}`);
    }
  } finally {
    await server.close();
  }
  writeFileSync(join(OUT, "ticks.json"), JSON.stringify(out, null, 2));
  const left = await realPrisma.prepStepCompletion.count({ where: { planId: { in: [...allowed] } } });
  console.error(`completion rows on corpus plans after run: ${left}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => realPrisma.$disconnect());
