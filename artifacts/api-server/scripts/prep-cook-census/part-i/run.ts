// [prepcook] Part I — all three surfaces, through the REAL routes.
//
// Where Part A called the pipeline, this mounts the shipped routers
// (`createCookingRouter`, `createPlansRouter`) in-process and drives them over
// HTTP as the test account, so what is measured is what the phone is served:
//
//   1. POST /plans/:id/prep-week                 — Prep the Week, full plan (narrated)
//   2. POST /plans/:id/prep-week {mealIds:[a,b]} — Prep Selected Meals
//   3. POST /meals/:id/cooking-sequence          — Cook Mode, every meal
//      + PUT  /plans/:id/prep-week/completions   — the prepped path: tick a meal's
//      + GET  /plans/:id                           steps, read `isPrepped`, render
//                                                  Cook Mode as cook-session does,
//                                                  then delete what was written.
//
// Beside the routes the ENGINE runs read-only (loader → combine → step plan) so
// the checker can see container membership, classes and moments, which the wire
// does not carry. Same code, same rows, same day → same stepKeys; the run
// asserts that rather than assuming it.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-i/run.ts --budget 5.8 [--only A01,E-b4aa6fee]
//
// ── fences ──────────────────────────────────────────────────────────────────
//   • dev branch only;
//   • every plan must be owned by TEST_USER_ID, and e55a9305 is refused by id;
//   • EVERY Prisma write is proxied: allowed only on `lLMCallLog`, and on
//     `prepWeekStructure` / `prepStepCompletion` rows whose planId is a corpus
//     plan. Anything else throws, so a route that writes somewhere unexpected
//     stops the run instead of touching a row;
//   • completion rows this run adds are deleted again (pre-existing ones kept);
//   • the spy prices every SDK call and the run stops before crossing --budget.
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import express from "express";

import { signToken } from "../../../src/lib/auth";
import { runAICall as productionRunAICall } from "../../../src/lib/ai/runAICall";
import { createCookingRouter } from "../../../src/routes/cooking";
import { createPlansRouter } from "../../../src/routes/plans";
import { composeMealDetail } from "../../../src/routes/meals";
import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepCombineInput } from "../../../src/lib/prepCombineAdapter";
import { combinePrep } from "../../../src/lib/prepCombineEngine";
import { buildStepPlan } from "../../../src/lib/prepWeekAssembly";
import { loadPrepStepSet } from "../../../src/lib/prepStepSet";
import { deriveMealTiming } from "../../../src/lib/mealTiming";
import type { PrepWeekResult } from "../../../src/lib/ai/schemas/prepWeek";

import * as prepWeekModelNs from "../../../../kiwi/lib/cooking/prepWeekModel";
import * as cookSessionNs from "../../../../kiwi/lib/cooking/cookSession";

import { FORBIDDEN_PLAN, TEST_USER_ID, loadCorpus, type CorpusRow } from "./corpus";

function unwrap<T extends object>(ns: unknown, probe: string): T {
  const m = ns as { default?: T } & T;
  const picked = (m as Record<string, unknown>)[probe] ? m : (m.default as T);
  if (typeof (picked as Record<string, unknown>)?.[probe] !== "function") throw new Error(`client module missing ${probe}`);
  return picked as T;
}
const { buildPrepWeekModel, buildMealLabelLookup } = unwrap<typeof prepWeekModelNs>(prepWeekModelNs, "buildPrepWeekModel");
const cs = unwrap<typeof cookSessionNs>(cookSessionNs, "sequenceMealSteps");

// ── fences ──────────────────────────────────────────────────────────────────
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
  throw new Error("REFUSING: DATABASE_URL is not the dev branch");
}
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const LEGACY_OUT = join(HERE, "..", "out"); // check.ts reads PlanRecords from here
mkdirSync(OUT, { recursive: true });
mkdirSync(LEGACY_OUT, { recursive: true });

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const BUDGET = Number(arg("budget", "5.8"));
const ONLY = (arg("only", "") ?? "").split(",").filter(Boolean);
const TAG = "parti";

const WRITE_OPS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany", "executeRaw", "executeRawUnsafe"]);
const allowedPlanIds = new Set<string>();
const writeLog: string[] = [];

function planIdOfArgs(a: Record<string, unknown> | undefined): string | undefined {
  if (!a) return undefined;
  const w = a.where as Record<string, unknown> | undefined;
  const c = a.create as Record<string, unknown> | undefined;
  const d = a.data as Record<string, unknown> | undefined;
  const compound = w?.planId_stepKey as Record<string, unknown> | undefined;
  const v = (w?.planId ?? compound?.planId ?? c?.planId ?? d?.planId) as unknown;
  return typeof v === "string" ? v : undefined;
}

function fenced(base: PrismaClient): PrismaClient {
  const cache = new Map<string, unknown>();
  return new Proxy(base, {
    get(target, prop: string, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "$executeRaw" || prop === "$executeRawUnsafe") {
        return async () => { throw new Error(`REFUSING raw write ${prop}`); };
      }
      if (prop === "$transaction") {
        // Array form runs the (already-fenced) operations; callback form gets the fenced client.
        return (first: unknown, ...rest: unknown[]) =>
          Array.isArray(first)
            ? Promise.all(first as Promise<unknown>[])
            : typeof first === "function"
              ? (first as (tx: unknown) => unknown)(recv)
              : (v as (...a: unknown[]) => unknown).call(target, first, ...rest);
      }
      if (typeof prop !== "string" || prop.startsWith("$") || prop.startsWith("_") || v === null || typeof v !== "object") {
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      if (prop === "lLMCallLog" || prop === "llmCallLog") return v;
      const hit = cache.get(prop);
      if (hit) return hit;
      const proxy = new Proxy(v as object, {
        get(t, op: string) {
          const f = Reflect.get(t, op);
          if (typeof op === "string" && WRITE_OPS.has(op)) {
            return async (a: Record<string, unknown>) => {
              const pid = planIdOfArgs(a);
              const ok = (prop === "prepWeekStructure" || prop === "prepStepCompletion") && pid !== undefined && allowedPlanIds.has(pid) && pid !== FORBIDDEN_PLAN;
              if (!ok) throw new Error(`REFUSING: ${prop}.${op} (planId=${pid ?? "?"}) is outside the Part I write fence`);
              writeLog.push(`${prop}.${op} ${pid.slice(0, 8)}`);
              return (f as (x: unknown) => unknown).call(t, a);
            };
          }
          return typeof f === "function" ? (f as (...a: unknown[]) => unknown).bind(t) : f;
        },
      });
      cache.set(prop, proxy);
      return proxy;
    },
  }) as PrismaClient;
}

const realPrisma = new PrismaClient();
const prisma = fenced(realPrisma);

// ── the AI spy (server's own rate table: claude-sonnet-4-6 $3 / $15 per MTok) ──
interface AICall { label: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; ms: number }
const calls: AICall[] = [];
let currentLabel = "";
const spent = () => calls.reduce((s, c) => s + c.costUsd, 0);
function spyClient(): Pick<Anthropic, "messages"> {
  const real = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  return {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        const t0 = Date.now();
        const res = (await real.messages.create(params)) as Anthropic.Message;
        const i = res.usage?.input_tokens ?? 0;
        const o = res.usage?.output_tokens ?? 0;
        calls.push({ label: currentLabel, model: String(params.model), inputTokens: i, outputTokens: o, costUsd: (i / 1e6) * 3 + (o / 1e6) * 15, ms: Date.now() - t0 });
        return res;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
}

// ── the server ──────────────────────────────────────────────────────────────
async function spinUp(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  const allow = { can: async () => ({ allowed: true }) } as never;
  app.use("/api", createCookingRouter({
    prisma,
    subscriptionService: allow,
    rateLimiterOpts: { capacity: 10_000, refillPerSec: 10_000 },
    completionLimiterOpts: { capacity: 10_000, refillPerSec: 10_000 },
    runAICall: ((k: string, v: Record<string, unknown>, s: never, o: Record<string, unknown> = {}) =>
      productionRunAICall(k, v, s, { ...o, client: spyClient() })) as never,
  }));
  app.use("/api", createPlansRouter({ prisma, subscriptionService: allow, rateLimiterOpts: { capacity: 10_000, refillPerSec: 10_000 }, mutationLimiterOpts: { capacity: 10_000, refillPerSec: 10_000 } }));
  return await new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const a = server.address();
      const port = typeof a === "object" && a ? a.port : 0;
      resolve({ base: `http://127.0.0.1:${port}/api`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const TOKEN = signToken(TEST_USER_ID);
async function call<T = unknown>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json: json as T };
}

// ── record shapes ───────────────────────────────────────────────────────────
interface Envelope { cacheHit: boolean; subset: boolean; result: PrepWeekResult; promptVersion?: number; error?: string; reason?: string }

interface RenderedPrep {
  status: number;
  error: string | null;
  cacheHit: boolean | null;
  promptVersion: number | null;
  containerCount: number | null;
  statedMinutes: number | null;
  serverTotal: number | null;
  phoneTotal: number | null;
  heldForCookDay: string[];
  phaseNotes: Record<string, string>;
  steps: {
    stepKey: string; phase: string; number: number; title: string; instructions: string;
    estimatedMinutes: number; storageNote: string | null; skipSuggested: boolean; rendered: boolean;
    holdsNoContainer: boolean; containerId: string | null; containerNames: string[];
    contributesToMealIds: string[]; destinationLabels: string[];
  }[];
}

function renderPrep(status: number, env: Envelope | null, items: PlanItem[], err: string | null): RenderedPrep {
  if (!env || status !== 200) {
    return { status, error: err, cacheHit: null, promptVersion: null, containerCount: null, statedMinutes: null, serverTotal: null, phoneTotal: null, heldForCookDay: [], phaseNotes: {}, steps: [] };
  }
  const lookup = buildMealLabelLookup(items.map((i) => ({ mealId: i.mealId, assignedDayOfWeek: i.assignedDayOfWeek, meal: { title: i.meal.title } })));
  const vm = buildPrepWeekModel(env.result as never, { mealLabel: lookup });
  const renderedKeys = new Set<string>();
  for (const p of vm.phases) for (const s of p.steps) renderedKeys.add(s.stepKey);
  const held: string[] = [];
  const notes: Record<string, string> = {};
  const steps: RenderedPrep["steps"] = [];
  for (const ph of env.result.phases) {
    if (ph.heldForCookDay) held.push(...ph.heldForCookDay);
    if (ph.note) notes[ph.phase] = ph.note;
    for (const s of ph.steps) {
      steps.push({
        stepKey: s.stepKey, phase: ph.phase, number: s.number, title: s.title, instructions: s.instructions,
        estimatedMinutes: s.estimatedMinutes, storageNote: s.storageNote ?? null, skipSuggested: s.skipSuggested === true,
        rendered: renderedKeys.has(s.stepKey), holdsNoContainer: s.holdsNoContainer === true,
        containerId: s.containerId ?? null, containerNames: s.containerNames ?? [],
        contributesToMealIds: [...s.contributesToMealIds],
        destinationLabels: s.contributesToMealIds.map((id) => lookup(id)?.name ?? "A planned meal"),
      });
    }
  }
  return {
    status, error: null, cacheHit: env.cacheHit, promptVersion: env.promptVersion ?? null,
    containerCount: env.result.containerCount ?? null, statedMinutes: env.result.estimatedMinutes ?? null,
    serverTotal: env.result.totalEstimatedMinutes, phoneTotal: vm.totalEstimatedMinutes,
    heldForCookDay: held, phaseNotes: notes, steps,
  };
}

/** The engine's own view, read-only — what the wire does not carry. */
async function engineView(planId: string, mealIds?: string[]) {
  const { input, cookDays, identity } = await loadPrepWeekInput({ planId, userId: TEST_USER_ID, prisma, ...(mealIds ? { mealIds } : {}) });
  const combine = combinePrep(buildPrepCombineInput(input), identity?.foldedIdByIngredientId);
  const stepTextByDishId = new Map<string, string[]>();
  for (const m of input.meals) for (const d of m.dishes) stepTextByDishId.set(d.dishId, d.stepTexts);
  const plan = buildStepPlan(combine, input.planName, stepTextByDishId, cookDays.lagByMealId);
  const ingredients: { mealId: string; dishId: string; dishName: string; ingredientId: string; name: string; category: string | null; purchaseUnit: string | null; note: string | null; qty: number; unit: string }[] = [];
  const componentSteps: Record<string, { stepIndex: number; text: string; componentKey: string | null; phaseType: string; ingredientIds: string[] }[]> = {};
  for (const m of input.meals) {
    for (const d of m.dishes) {
      componentSteps[d.dishId] = d.componentSteps as never;
      for (const i of d.ingredients) {
        ingredients.push({ mealId: m.mealId, dishId: d.dishId, dishName: d.dishName, ingredientId: i.ingredientId, name: i.ingredientName, category: i.category ?? null, purchaseUnit: i.purchaseUnit ?? null, note: i.preparationNote, qty: i.quantity, unit: i.unit });
      }
    }
  }
  return {
    steps: plan.steps.map((s) => ({
      stepKey: s.stepKey, phase: s.phase, isBlend: s.isBlend, bowlName: s.bowlName ?? null, containerId: s.containerId ?? null,
      closes: s.closes ?? [], demoted: s.demoted?.reason ?? null, daysUntilCook: s.daysUntilCook ?? null,
      holdsNoContainer: s.holdsNoContainer === true, cookDaySentence: s.cookDaySentence ?? null,
      marinadeJoin: s.marinadeJoin ?? null, estimatedMinutes: s.estimatedMinutes, minutesOverCap: s.minutesOverCap === true,
      contributesToMealIds: s.contributesToMealIds,
      components: s.components.map((c) => ({ ingredientName: c.ingredientName, preparationNote: c.preparationNote ?? null, measures: c.measures })),
    })),
    containerExtras: plan.containerExtras ? Object.fromEntries(plan.containerExtras) : {},
    narrationInput: plan.narrationInput,
    ingredients,
    componentSteps,
    lagByMealId: Object.fromEntries(cookDays.lagByMealId),
    dayNameByMealId: Object.fromEntries(cookDays.dayNameByMealId),
    prepDay: cookDays.prepDay,
  };
}

type PlanItem = {
  id: string; mealId: string; assignedDayOfWeek: string | null; assignedDate: Date | null;
  servingsOverride: number | null; recipeOverrideJson: unknown; componentSelections: unknown;
  meal: { id: string; title: string; estimatedTimeMinutes: number; activeTimeMinutes: number | null };
};

async function cookMeal(base: string, item: PlanItem) {
  const seq = await call<{ sequence: { dishId: string; originalStepIndex: number; sequenceIndex: number; startOffsetMinutes: number; reason?: string }[]; totalEstimatedMinutes: number; dishCount: number }>(base, "POST", `/meals/${item.mealId}/cooking-sequence`);
  const detail = await composeMealDetail(prisma, item.mealId, item.recipeOverrideJson as never, item.servingsOverride);
  if (!detail || seq.status !== 200) return { error: `sequence ${seq.status}`, mealId: item.mealId };
  const isMultiDish = detail.steps.length === 0 && detail.dishes.length > 1; // cook-session.tsx:78
  const sequenced = cs.sequenceMealSteps(detail as never, seq.json.sequence as never);
  const phoneSteps = isMultiDish ? sequenced : cs.flattenMealSteps(detail as never);
  const footer = cs.remainingMinutesToServe(phoneSteps, 0) ?? cs.remainingMinutes(phoneSteps, 0);
  const offsetByKey = new Map(seq.json.sequence.map((e) => [`${e.dishId}#${e.originalStepIndex}`, e.startOffsetMinutes]));
  const rawSteps = await prisma.recipeInstructionStep.findMany({
    where: { ownerType: "dish", ownerId: { in: detail.dishes.map((d) => d.dishId) } },
    select: { ownerId: true, stepIndex: true, phaseType: true, isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true, estimatedMinutes: true },
  });
  const rawByKey = new Map(rawSteps.map((s) => [`${s.ownerId}#${s.stepIndex}`, s]));
  const links = await prisma.mealDishLink.findMany({ where: { mealId: item.mealId }, select: { dishId: true, positionIndex: true, dish: { select: { title: true } } } });
  const byDish = new Map<string, typeof rawSteps>();
  for (const s of rawSteps) { const l = byDish.get(s.ownerId) ?? []; l.push(s); byDish.set(s.ownerId, l); }
  const timing = deriveMealTiming(links.map((l) => ({
    dishId: l.dishId, title: l.dish.title, positionIndex: l.positionIndex,
    steps: (byDish.get(l.dishId) ?? []).slice().sort((a, b) => a.stepIndex - b.stepIndex).map((s) => ({
      stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes <= 0 ? 1 : s.estimatedMinutes, phaseType: s.phaseType as never,
      isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, componentKey: s.componentKey, pathKey: s.pathKey,
    })),
  })));
  const toRec = (list: typeof sequenced) => list.map((c, i) => {
    const raw = rawByKey.get(c.key);
    const [dishId, idx] = c.key.split("#");
    return {
      sequenceIndex: i, dishId, dishTitle: c.dishTitle ?? null, originalStepIndex: Number(idx),
      startOffsetMinutes: offsetByKey.get(c.key) ?? null, estimatedMinutes: c.estimatedMinutes, phaseType: c.phaseType,
      isTimingSensitive: c.isTimingSensitive, parallelGroup: raw?.parallelGroup ?? null, componentKey: raw?.componentKey ?? null,
      pathKey: raw?.pathKey ?? null, cue: c.cue ?? null, text: c.text, isPrep: c.isPrep, appended: !offsetByKey.has(c.key),
    };
  });
  return {
    mealId: item.mealId, mealTitle: item.meal.title, planItemId: item.id,
    assignedDayOfWeek: item.assignedDayOfWeek, assignedDate: item.assignedDate?.toISOString().slice(0, 10) ?? null,
    hasRecipeOverride: item.recipeOverrideJson != null, componentSelections: item.componentSelections ?? null,
    dishCount: seq.json.dishCount, isMultiDish, sequenceTotalMinutes: seq.json.totalEstimatedMinutes,
    cardTotalMinutes: item.meal.estimatedTimeMinutes, cardActiveMinutes: item.meal.activeTimeMinutes,
    derivedTotalMinutes: timing.totalMinutes, derivedActiveMinutes: timing.activeMinutes, ignoredTags: timing.ignoredTags,
    phoneFooterMinutes: footer,
    /** The SCHEDULER's order for every meal (K-rules read this). */
    steps: toRec(sequenced),
    /** What cook-session.tsx actually shows (flatten for single-dish — BUG-344). */
    phoneSteps: toRec(phoneSteps),
  };
}

type CookRec = Exclude<Awaited<ReturnType<typeof cookMeal>>, { error: string }>;

async function getPlanItems(base: string, planId: string) {
  // The route answers `{ plan: { …, items } }`. The first run read `items` off the
  // envelope, got nothing, and every isPrepped came back as the `?? false` default.
  const r = await call<{ plan?: { items?: { id: string; mealId: string; isPrepped: boolean }[] } }>(base, "GET", `/plans/${planId}`);
  if (r.status !== 200 || !r.json.plan?.items) throw new Error(`GET /plans/${planId} → ${r.status}`);
  return { status: r.status, items: r.json.plan.items };
}

async function tick(base: string, planId: string, keys: string[], added: Set<string>, pre: Set<string>) {
  for (const k of keys) {
    const r = await call(base, "PUT", `/plans/${planId}/prep-week/completions`, { stepKey: k });
    if (r.status !== 200) throw new Error(`PUT completion ${r.status}`);
    if (!pre.has(k)) added.add(k);
  }
}

async function cleanup(planId: string, added: Set<string>) {
  if (added.size === 0) return 0;
  const r = await prisma.prepStepCompletion.deleteMany({ where: { planId, stepKey: { in: [...added] } } });
  added.clear();
  return r.count;
}

async function runPlan(base: string, row: CorpusRow) {
  const planId = row.planId;
  if (planId === FORBIDDEN_PLAN) throw new Error("REFUSING e55a9305");
  const plan = await prisma.mealPlanInstance.findUniqueOrThrow({
    where: { id: planId },
    select: {
      userId: true, titleOverride: true, startDate: true, endDate: true,
      items: { orderBy: { positionIndex: "asc" }, select: { id: true, mealId: true, assignedDayOfWeek: true, assignedDate: true, servingsOverride: true, recipeOverrideJson: true, componentSelections: true, meal: { select: { id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true } } } },
    },
  });
  if (plan.userId !== TEST_USER_ID) throw new Error(`REFUSING: ${planId} is not on the test account`);
  allowedPlanIds.add(planId);
  const items = plan.items as PlanItem[];
  const pre = new Set((await prisma.prepStepCompletion.findMany({ where: { planId }, select: { stepKey: true } })).map((r) => r.stepKey));
  const added = new Set<string>();

  // ── 0. a cache already on the row: what does the phone get TODAY? ─────────
  let staleCache: null | { cacheHit: boolean; promptVersion: number | null; blobKeys: number; headKeys: number; missingFromBlob: string[]; extraInBlob: string[] } = null;
  const existing = await realPrisma.prepWeekStructure.findUnique({ where: { planId }, select: { planId: true } });
  const engineFull = await engineView(planId);
  if (existing) {
    currentLabel = `${row.code} cached`;
    const r = await call<Envelope>(base, "POST", `/plans/${planId}/prep-week`);
    const blobKeys = new Set((r.json.result?.phases ?? []).flatMap((p) => p.steps.map((s) => s.stepKey)));
    const headKeys = new Set(engineFull.steps.map((s) => s.stepKey));
    staleCache = {
      cacheHit: r.json.cacheHit, promptVersion: r.json.promptVersion ?? null, blobKeys: blobKeys.size, headKeys: headKeys.size,
      missingFromBlob: [...headKeys].filter((k) => !blobKeys.has(k)), extraInBlob: [...blobKeys].filter((k) => !headKeys.has(k)),
    };
    if (r.json.cacheHit) await prisma.prepWeekStructure.delete({ where: { planId } });
  }

  // ── 1. Prep the Week, full ────────────────────────────────────────────────
  if (spent() >= BUDGET) throw new Error("BUDGET");
  currentLabel = `${row.code} full`;
  const f = await call<Envelope>(base, "POST", `/plans/${planId}/prep-week`);
  const full = renderPrep(f.status, f.status === 200 ? f.json : null, items, f.status === 200 ? null : `${f.json.reason ?? ""} ${f.json.error ?? JSON.stringify(f.json).slice(0, 200)}`);
  const fullKeys = new Set(full.steps.map((s) => s.stepKey));
  const engineKeys = new Set(engineFull.steps.map((s) => s.stepKey));
  const parity = full.status === 200 ? {
    wireNotEngine: [...fullKeys].filter((k) => !engineKeys.has(k)),
    engineNotWire: [...engineKeys].filter((k) => !fullKeys.has(k)),
  } : null;

  // ── 2. Prep Selected Meals — the first and the last distinct meals ───────
  const distinct = [...new Map(items.map((i) => [i.mealId, i])).values()];
  const subsetMealIds = distinct.length >= 2 ? [distinct[0].mealId, distinct[distinct.length - 1].mealId] : [distinct[0].mealId];
  if (spent() >= BUDGET) throw new Error("BUDGET");
  currentLabel = `${row.code} subset`;
  const sR = await call<Envelope>(base, "POST", `/plans/${planId}/prep-week`, { mealIds: subsetMealIds });
  const subset = renderPrep(sR.status, sR.status === 200 ? sR.json : null, items, sR.status === 200 ? null : `${sR.json.reason ?? ""} ${sR.json.error ?? ""}`);
  const engineSubset = await engineView(planId, subsetMealIds).catch((e) => ({ error: String(e) }));

  const subsetTick = await subsetTicks(base, planId, subsetMealIds, subset, fullKeys, pre);

  // ── 3. Cook Mode, every meal ──────────────────────────────────────────────
  const meals: CookRec[] = [];
  const cookErrors: string[] = [];
  for (const item of distinct) {
    try {
      const r = await cookMeal(base, item);
      if ("error" in r) cookErrors.push(`${item.meal.title}: ${r.error}`); else meals.push(r as CookRec);
    } catch (e) { cookErrors.push(`${item.meal.title}: ${String(e)}`); }
  }

  const prepped = await preppedPath(base, planId, items, full, meals, pre);

  return {
    code: row.code, planId, planName: plan.titleOverride,
    startDate: plan.startDate?.toISOString().slice(0, 10) ?? null, endDate: plan.endDate?.toISOString().slice(0, 10) ?? null,
    mealCount: items.length,
    dayByMealId: Object.fromEntries(items.map((i) => [i.mealId, { day: i.assignedDayOfWeek, date: i.assignedDate?.toISOString().slice(0, 10) ?? null }])),
    titleByMealId: Object.fromEntries(items.map((i) => [i.mealId, i.meal.title])),
    shapes: [...new Set([...row.planShapes, ...row.meals.flatMap((m) => m.shapes)])],
    staleCache, full, parity, engineFull,
    subsetMealIds, subset, engineSubset, subsetTick,
    meals, cookErrors, prepped,
  };
}

/** Subset completions → do they count toward the FULL plan's isPrepped? Cleans up after itself. */
async function subsetTicks(base: string, planId: string, subsetMealIds: string[], subset: RenderedPrep, fullKeys: Set<string>, pre: Set<string>) {
  const added = new Set<string>();
  const out: { keysTicked: string[]; notInFull: string[]; isPrepped: Record<string, boolean | null>; requiredForSubsetMeals: string[]; uncovered: string[] } = { keysTicked: [], notInFull: [], isPrepped: {}, requiredForSubsetMeals: [], uncovered: [] };
  if (subset.status !== 200) return out;
  try {
    const keys = subset.steps.filter((s) => s.rendered).map((s) => s.stepKey);
    await tick(base, planId, keys, added, pre);
    const g = await getPlanItems(base, planId);
    const required = await loadPrepStepSet({ planId, userId: TEST_USER_ID, prisma });
    const req = required.filter((r) => r.contributesToMealIds.some((m) => subsetMealIds.includes(m))).map((r) => r.stepKey);
    const ticked = new Set([...pre, ...keys]);
    out.keysTicked = keys;
    out.notInFull = keys.filter((k) => !fullKeys.has(k));
    out.requiredForSubsetMeals = req;
    out.uncovered = req.filter((k) => !ticked.has(k));
    for (const id of subsetMealIds) out.isPrepped[id] = g.items.find((i) => i.mealId === id)?.isPrepped ?? null;
  } finally {
    await cleanup(planId, added);
  }
  return out;
}

/** The prepped path: one multi-dish meal, its steps ticked, Cook Mode rendered. Cleans up. */
async function preppedPath(base: string, planId: string, items: PlanItem[], full: RenderedPrep, meals: CookRec[], pre: Set<string>) {
  const added = new Set<string>();
  // Prefer a multi-dish meal OTHER than the first (which is the unprepped sample).
  const multi = meals.filter((m) => m.dishCount > 1);
  const target = multi.find((m) => m.mealId !== multi[0]?.mealId) ?? multi[0];
  let prepped: null | Record<string, unknown> = null;
  if (target && full.status === 200) try {
    const before = await getPlanItems(base, planId);
    const mine = full.steps.filter((s) => s.contributesToMealIds.includes(target.mealId));
    const renderedKeys = mine.filter((s) => s.rendered).map((s) => s.stepKey);
    await tick(base, planId, renderedKeys, added, pre);
    const afterRendered = await getPlanItems(base, planId);
    const required = (await loadPrepStepSet({ planId, userId: TEST_USER_ID, prisma })).filter((r) => r.contributesToMealIds.includes(target.mealId));
    const ticked = new Set([...pre, ...renderedKeys]);
    const blockers = required.filter((r) => !ticked.has(r.stepKey)).map((r) => {
      const w = full.steps.find((s) => s.stepKey === r.stepKey);
      return { stepKey: r.stepKey, onWire: !!w, rendered: w?.rendered ?? false, title: w?.title ?? null, skipSuggested: w?.skipSuggested ?? null };
    });
    const allKeys = mine.map((s) => s.stepKey);
    await tick(base, planId, allKeys, added, pre);
    const afterAll = await getPlanItems(base, planId);
    const isPreppedRendered = afterRendered.items.find((i) => i.mealId === target.mealId)?.isPrepped ?? null;
    const isPreppedAll = afterAll.items.find((i) => i.mealId === target.mealId)?.isPrepped ?? null;
    // Cook Mode as cook-session.tsx renders it, with the value the route returned.
    const item = items.find((i) => i.mealId === target.mealId)!;
    const detail = await composeMealDetail(prisma, item.mealId, item.recipeOverrideJson as never, item.servingsOverride);
    const seq = await call<{ sequence: never[] }>(base, "POST", `/meals/${item.mealId}/cooking-sequence`);
    const allSteps = cs.sequenceMealSteps(detail as never, seq.json.sequence);
    const renderWith = (isPrepped: boolean) => {
      const gate = cs.resolvePrepGate(true, isPrepped);
      const active = cs.applyPrepFilter(allSteps, gate === "prepped");
      return {
        gate,
        recapShown: gate === "prepped",
        recap: cs.misePlaceItems(allSteps),
        steps: active.map((s) => ({ dishTitle: s.dishTitle ?? null, phaseType: s.phaseType, isPrep: s.isPrep, text: s.text, cue: s.cue ?? null, startOffsetMinutes: s.startOffsetMinutes ?? null, estimatedMinutes: s.estimatedMinutes })),
        footer: cs.remainingMinutesToServe(active, 0) ?? cs.remainingMinutes(active, 0),
      };
    };
    prepped = {
      mealId: target.mealId, mealTitle: target.mealTitle,
      isPreppedBefore: before.items.find((i) => i.mealId === target.mealId)?.isPrepped ?? null,
      renderedKeysTicked: renderedKeys.length, allKeysTicked: allKeys.length,
      isPreppedAfterRendered: isPreppedRendered, isPreppedAfterAll: isPreppedAll, blockers,
      prepStepsForMeal: mine.map((s) => ({ stepKey: s.stepKey, title: s.title, rendered: s.rendered, phase: s.phase, instructions: s.instructions })),
      /** What the screen shows given the route's answer after the rendered ticks. */
      asServed: renderWith(isPreppedRendered === true),
      /** The prepped branch itself, forced — the path under test. */
      forcedPrepped: renderWith(true),
    };
  } finally {
    await cleanup(planId, added);
  }
  return prepped;
}

type PartIRecord = Awaited<ReturnType<typeof runPlan>>;

/** check.ts's PlanRecord, so K-R1…K-R6 / P-R1…P-R6 run unchanged over this corpus. */
function legacyRecord(r: PartIRecord) {
  const p = r.full;
  return {
    planId: r.planId, planName: r.planName, startDate: r.startDate, endDate: r.endDate, mealCount: r.mealCount,
    datedItems: Object.values(r.dayByMealId).filter((d) => d.date).length, dayByMealId: r.dayByMealId,
    prep: p.status !== 200 ? null : {
      totalEstimatedMinutes: p.serverTotal, renderedTotalMinutes: p.phoneTotal, heldForCookDay: p.heldForCookDay,
      stepsPerPhase: Object.fromEntries(["seasonings_dry", "produce", "sauces_marinades", "proteins"].map((k) => [k, p.steps.filter((s) => s.phase === k && s.rendered).length])),
      containerCount: p.containerCount, statedMinutes: p.statedMinutes, steps: p.steps, phaseNotes: p.phaseNotes,
      narrationInputHash: "", plannedStepCount: r.engineFull.steps.length,
    },
    prepError: p.error,
    meals: r.meals.map(({ phoneSteps: _p, ...m }) => m),
  };
}

function renderText(r: PartIRecord): string {
  const L: string[] = [];
  const dayOf = (id: string) => r.dayByMealId[id]?.day ?? "?";
  L.push(`PLAN ${r.planId}  [${r.code}]  ${r.planName ?? ""}`);
  L.push(`  range ${r.startDate} .. ${r.endDate}   meals ${r.mealCount}   prep day ${r.engineFull.prepDay}   shapes: ${r.shapes.join(", ")}`);
  if (r.staleCache) L.push(`  CACHE BEFORE RUN: hit=${r.staleCache.cacheHit} v${r.staleCache.promptVersion} · blob ${r.staleCache.blobKeys} keys vs HEAD ${r.staleCache.headKeys} · ${r.staleCache.missingFromBlob.length} HEAD keys absent from blob · ${r.staleCache.extraInBlob.length} blob keys HEAD no longer emits`);
  const prep = (title: string, p: RenderedPrep) => {
    L.push("", `══════════ ${title} ══════════`);
    if (p.status !== 200) { L.push(`  (HTTP ${p.status}: ${p.error})`); return; }
    L.push(`  HEADER: ${p.containerCount} containers · about ${p.statedMinutes} min   (server total ${p.serverTotal} · phone ${p.phoneTotal}) · cacheHit=${p.cacheHit} · prompt v${p.promptVersion}`);
    for (const h of p.heldForCookDay) L.push(`  HELD: ${h}`);
    let phase = "";
    for (const s of p.steps) {
      if (s.phase !== phase) { phase = s.phase; L.push("", `  ── ${s.phase} ──`); if (p.phaseNotes[s.phase]) L.push(`     » ${p.phaseNotes[s.phase]}`); }
      L.push(`  ${s.rendered ? " " : "×"} ${String(s.number).padStart(2)}. ${s.title}   (${s.estimatedMinutes} min)${s.rendered ? "" : "  [RENDER-OMITTED]"}`);
      for (const line of s.instructions.split("\n")) L.push(`        ${line}`);
      if (s.storageNote) L.push(`        » storage: ${s.storageNote}`);
      L.push(`        » for: ${s.destinationLabels.map((n, i) => `${n} (${dayOf(s.contributesToMealIds[i])})`).join(", ")}`);
    }
  };
  prep("PREP THE WEEK — full plan, as Screen 3 renders it", r.full);
  prep(`PREP SELECTED MEALS — ${r.subsetMealIds.map((id) => r.titleByMealId[id]).join(" + ")}`, r.subset);
  L.push("", `  subset ticks: ${r.subsetTick.keysTicked.length} keys, ${r.subsetTick.notInFull.length} not in the full plan; required for these meals ${r.subsetTick.requiredForSubsetMeals.length}, uncovered ${r.subsetTick.uncovered.length}; isPrepped ${JSON.stringify(Object.fromEntries(Object.entries(r.subsetTick.isPrepped).map(([k, v]) => [r.titleByMealId[k]?.slice(0, 30), v])))}`);
  L.push("", "══════════ COOK MODE (cook-session.tsx: sequenced if multi-dish, flattened if single) ══════════");
  for (const m of r.meals) {
    L.push("", `  ▸ ${m.mealTitle}   [${m.assignedDayOfWeek}]  ${m.isMultiDish ? "SEQUENCED" : "FLATTENED (single-dish)"}`);
    L.push(`    footer ${m.phoneFooterMinutes} min | scheduler ${m.sequenceTotalMinutes} | card ${m.cardTotalMinutes} | fresh derive ${m.derivedTotalMinutes} | dishes ${m.dishCount}`);
    for (const s of m.phoneSteps) {
      const off = s.startOffsetMinutes == null ? "    —" : `T${s.startOffsetMinutes}`;
      L.push(`    ${String(s.sequenceIndex + 1).padStart(3)}. [${off.padStart(5)}] (${String(s.estimatedMinutes).padStart(3)}m ${s.phaseType}) ${s.dishTitle ?? ""}`);
      if (s.cue) L.push(`         ⟶ ${s.cue}`);
      L.push(`         ${s.text}`);
    }
  }
  if (r.prepped) {
    const p = r.prepped as { mealTitle: string; isPreppedAfterRendered: boolean; isPreppedAfterAll: boolean; renderedKeysTicked: number; allKeysTicked: number; blockers: unknown[]; forcedPrepped: { recap: string[]; steps: { dishTitle: string | null; phaseType: string; text: string; cue: string | null; startOffsetMinutes: number | null }[]; footer: number } };
    L.push("", `══════════ COOK MODE — PREPPED PATH: ${p.mealTitle} ══════════`);
    L.push(`  ticked ${p.renderedKeysTicked} rendered prep steps → isPrepped=${p.isPreppedAfterRendered}; + every wire step for the meal (${p.allKeysTicked}) → isPrepped=${p.isPreppedAfterAll}; blockers ${JSON.stringify(p.blockers)}`);
    L.push("  recap (\"You already prepped this — get your:\"):");
    for (const x of p.forcedPrepped.recap) L.push(`    · ${x}`);
    L.push(`  footer ${p.forcedPrepped.footer} min; steps after the prep filter:`);
    for (const [i, s] of p.forcedPrepped.steps.entries()) {
      L.push(`    ${String(i + 1).padStart(3)}. [T${s.startOffsetMinutes ?? "—"}] (${s.phaseType}) ${s.dishTitle ?? ""}${s.cue ? `  ⟶ ${s.cue}` : ""}`);
      L.push(`         ${s.text}`);
    }
  }
  return L.join("\n");
}

/**
 * --ticks-only: redo the completion passes (subset ticks + prepped path) over the
 * SAVED records, through the routes, with no AI call. Exists because the first run
 * read `isPrepped` off the wrong envelope level.
 */
async function ticksOnly() {
  const { readFileSync, readdirSync } = await import("node:fs");
  const server = await spinUp();
  try {
    for (const f of readdirSync(OUT).filter((x) => /^[0-9a-f]{8}\.json$/.test(x))) {
      const rec = JSON.parse(readFileSync(join(OUT, f), "utf8")) as PartIRecord;
      if (ONLY.length && !ONLY.includes(rec.code)) continue;
      if (rec.planId === FORBIDDEN_PLAN) throw new Error("REFUSING e55a9305");
      const plan = await prisma.mealPlanInstance.findUniqueOrThrow({
        where: { id: rec.planId },
        select: { userId: true, items: { orderBy: { positionIndex: "asc" }, select: { id: true, mealId: true, assignedDayOfWeek: true, assignedDate: true, servingsOverride: true, recipeOverrideJson: true, componentSelections: true, meal: { select: { id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true } } } } },
      });
      if (plan.userId !== TEST_USER_ID) throw new Error(`REFUSING: ${rec.planId} is not on the test account`);
      allowedPlanIds.add(rec.planId);
      const pre = new Set((await prisma.prepStepCompletion.findMany({ where: { planId: rec.planId }, select: { stepKey: true } })).map((r) => r.stepKey));
      const fullKeys = new Set(rec.full.steps.map((s) => s.stepKey));
      rec.subsetTick = (await subsetTicks(server.base, rec.planId, rec.subsetMealIds, rec.subset, fullKeys, pre)) as never;
      rec.prepped = (await preppedPath(server.base, rec.planId, plan.items as PlanItem[], rec.full, rec.meals, pre)) as never;
      writeFileSync(join(OUT, f), JSON.stringify(rec, null, 2));
      writeFileSync(join(OUT, f.replace(".json", ".txt")), renderText(rec));
      const p = rec.prepped as { isPreppedAfterRendered?: boolean | null; isPreppedAfterAll?: boolean | null } | null;
      console.error(`${rec.code} subset isPrepped ${JSON.stringify(Object.values(rec.subsetTick.isPrepped))} · prepped ${p ? `${p.isPreppedAfterRendered}/${p.isPreppedAfterAll}` : "-"}`);
    }
  } finally {
    await server.close();
  }
  console.error(`${writeLog.length} fenced writes (${[...new Set(writeLog.map((w) => w.split(" ")[0]))].join(", ")})`);
}

async function main() {
  if (process.argv.includes("--ticks-only")) return ticksOnly();
  const rows = (await loadCorpus(prisma)).filter((r) => ONLY.length === 0 || ONLY.includes(r.code));
  for (const r of rows) {
    if (r.planId === FORBIDDEN_PLAN) throw new Error("REFUSING e55a9305");
  }
  const server = await spinUp();
  const summary: { code: string; planId: string; costUsd: number; full: number; subset: number; meals: number; error?: string }[] = [];
  try {
    for (const row of rows) {
      if (spent() >= BUDGET) { console.error(`BUDGET STOP at $${spent().toFixed(4)}`); break; }
      const before = spent();
      process.stderr.write(`${row.code} ${row.planId.slice(0, 8)} … `);
      try {
        const rec = await runPlan(server.base, row);
        writeFileSync(join(OUT, `${row.planId.slice(0, 8)}.json`), JSON.stringify(rec, null, 2));
        writeFileSync(join(OUT, `${row.planId.slice(0, 8)}.txt`), renderText(rec));
        writeFileSync(join(LEGACY_OUT, `${TAG}__${row.planId.slice(0, 8)}.json`), JSON.stringify(legacyRecord(rec), null, 2));
        writeFileSync(join(LEGACY_OUT, `${TAG}__${row.planId.slice(0, 8)}__narration-input.json`), JSON.stringify(rec.engineFull.narrationInput, null, 2));
        summary.push({ code: row.code, planId: row.planId, costUsd: spent() - before, full: rec.full.status, subset: rec.subset.status, meals: rec.meals.length });
        console.error(`full ${rec.full.status} (${rec.full.steps.length} steps) · subset ${rec.subset.status} · ${rec.meals.length} meals · $${(spent() - before).toFixed(4)}`);
      } catch (e) {
        summary.push({ code: row.code, planId: row.planId, costUsd: spent() - before, full: 0, subset: 0, meals: 0, error: String(e) });
        console.error(`FAILED: ${String(e)}`);
        if (String(e).includes("BUDGET")) break;
      }
    }
  } finally {
    await server.close();
  }
  const out = { generatedAt: new Date().toISOString(), costUsd: Number(spent().toFixed(4)), calls, summary, writes: writeLog.length, writeKinds: [...new Set(writeLog.map((w) => w.split(" ")[0]))] };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(out, null, 2));
  console.error(`\n${summary.length} plans · ${calls.length} AI calls · $${out.costUsd} · ${writeLog.length} fenced writes (${out.writeKinds.join(", ")})`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => realPrisma.$disconnect());
void crypto;
