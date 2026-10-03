// [prepcook] A — the Prep & Cook census harness.
//
// Read-only. Builds a golden corpus: real dev plans run through the real
// Prep-the-Week and Cook-Mode pipelines at HEAD, stopped before persistence,
// and rendered exactly as the phone composes them. `check.ts` measures K-R1…6
// and P-R1…6 against these files.
//
// Run from artifacts/api-server:
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/census.ts \
//     --plans b4aa6fee,31c7a885,… --tag live --budget 5
//
// ── The fences, and why each one holds ──────────────────────────────────────
//
// | fence                | how                                                |
// |----------------------|----------------------------------------------------|
// | dev branch only      | throws unless DATABASE_URL's host contains         |
// |                      | `ep-broad-haze` (below).                           |
// | no prep cache write  | the harness calls the PIPELINE (loadPrepWeekInput → |
// |                      | buildPrepCombineInput → combinePrep → buildStepPlan |
// |                      | → runAICall → assemblePrepWeekResult), NOT the      |
// |                      | route. The route owns the `prepWeekStructure`       |
// |                      | upsert; nothing here can reach it.                 |
// | no cache READ either | same reason — every plan is generated fresh, so the |
// |                      | corpus measures HEAD's prompt, not a stored blob    |
// |                      | some older version wrote.                          |
// | belt and braces      | every write op on EVERY Prisma delegate is proxied  |
// |                      | to a recorder that THROWS. `$transaction(array)` is |
// |                      | Promise.all'd. The only writes the pass allows are  |
// |                      | LLMCallLog rows, so that one delegate is passed     |
// |                      | through.                                           |
// | budget               | the spy sums SDK token counts through the server's  |
// |                      | own rate table and aborts before the plan that      |
// |                      | would cross --budget.                              |
//
// Cook Mode costs nothing: BUG-018 B2 removed the sequencer's Sonnet call, so
// `runCookingSequence` is pure arithmetic over persisted steps.

import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";

import { loadPrepWeekInput } from "../../src/lib/prepWeekAggregation";
import { buildPrepCombineInput } from "../../src/lib/prepCombineAdapter";
import { combinePrep } from "../../src/lib/prepCombineEngine";
import { buildStepPlan, assemblePrepWeekResult, summarizePrepWeek } from "../../src/lib/prepWeekAssembly";
import { PrepNarrationResultSchema } from "../../src/lib/ai/schemas/prepNarration";
import { PrepWeekResultSchema } from "../../src/lib/ai/schemas/prepWeek";
import { runAICall } from "../../src/lib/ai/runAICall";
import { applyStorageOverlay, type StorageContext } from "../../src/lib/prepStorage";
import { runCookingSequence } from "../../src/lib/cookingSequence";
import { composeMealDetail } from "../../src/routes/meals";
import { deriveMealTiming } from "../../src/lib/mealTiming";

// The CLIENT's render, imported not re-implemented — same modules the phone runs.
import * as prepWeekModelNs from "../../../kiwi/lib/cooking/prepWeekModel";
import * as cookSessionNs from "../../../kiwi/lib/cooking/cookSession";

// The client modules are authored for Metro; under tsx they may land behind a
// CJS default. Unwrap rather than re-implement — the render authority is theirs.
function unwrap<T extends object>(ns: unknown, probe: string): T {
  const m = ns as { default?: T } & T;
  const picked = (m as Record<string, unknown>)[probe] ? m : (m.default as T);
  if (typeof (picked as Record<string, unknown>)?.[probe] !== "function") {
    throw new Error(`could not load the client render module (missing ${probe})`);
  }
  return picked as T;
}
const { buildPrepWeekModel, buildMealLabelLookup } = unwrap<typeof prepWeekModelNs>(prepWeekModelNs, "buildPrepWeekModel");
const { sequenceMealSteps } = unwrap<typeof cookSessionNs>(cookSessionNs, "sequenceMealSteps");

// ── the fence ────────────────────────────────────────────────────────────────
const DB_HOST = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!DB_HOST.includes("ep-broad-haze")) {
  throw new Error(`REFUSING: DATABASE_URL host is not the dev branch (${DB_HOST.slice(0, 8)}…)`);
}

const WRITE_OPS = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany",
  "upsert", "delete", "deleteMany", "executeRaw", "executeRawUnsafe",
]);
// The one delegate the pass is allowed to write: the AI ledger.
const WRITABLE_DELEGATES = new Set(["lLMCallLog", "llmCallLog"]);

function guarded(base: PrismaClient): PrismaClient {
  const cache = new Map<string, unknown>();
  return new Proxy(base, {
    get(target, prop: string, recv) {
      if (prop === "$transaction") {
        const real = Reflect.get(target, prop, recv) as (...a: unknown[]) => unknown;
        return (first: unknown, ...rest: unknown[]) =>
          Array.isArray(first)
            ? Promise.all(first as Promise<unknown>[])
            : (real as (...a: unknown[]) => unknown).call(target, first, ...rest);
      }
      const v = Reflect.get(target, prop, recv);
      // Delegates are plain objects; everything else (functions, symbols) passes.
      if (typeof prop !== "string" || prop.startsWith("$") || prop.startsWith("_")) {
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      if (WRITABLE_DELEGATES.has(prop)) return v;
      if (v === null || typeof v !== "object") {
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      const hit = cache.get(prop);
      if (hit) return hit;
      const proxy = new Proxy(v as object, {
        get(t, op: string) {
          if (typeof op === "string" && WRITE_OPS.has(op)) {
            return async () => {
              throw new Error(`REFUSING: census attempted ${prop}.${op} — this harness is read-only`);
            };
          }
          const f = Reflect.get(t, op);
          return typeof f === "function" ? (f as (...a: unknown[]) => unknown).bind(t) : f;
        },
      });
      cache.set(prop, proxy);
      return proxy;
    },
  }) as PrismaClient;
}

const realPrisma = new PrismaClient();
const prisma = guarded(realPrisma);

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const TAG = arg("tag", "live")!;
const BUDGET = Number(arg("budget", "5"));
const PREFIXES = (arg("plans", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (PREFIXES.length === 0) throw new Error("--plans is required");

// ── the AI spy ───────────────────────────────────────────────────────────────
// Sonnet 4.5 list price. Matches the server's own rate table for the narrating
// model; cost is measured from the SDK's token counts, not read off a row.
const RATE_IN_PER_MTOK = 3;
const RATE_OUT_PER_MTOK = 15;

interface AICall {
  model: string;
  maxTokens: unknown;
  promptHash: string;
  outputHash: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
}

const allCalls: AICall[] = [];

function spyClient(): Pick<Anthropic, "messages"> {
  const real = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  return {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        const t0 = Date.now();
        const res = (await real.messages.create(params)) as Anthropic.Message;
        const text = res.content
          .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
          .join("");
        const inTok = res.usage?.input_tokens ?? 0;
        const outTok = res.usage?.output_tokens ?? 0;
        allCalls.push({
          model: String(params.model),
          maxTokens: (params as { max_tokens?: unknown }).max_tokens,
          promptHash: sha(JSON.stringify(params)),
          outputHash: sha(text),
          inputTokens: inTok,
          outputTokens: outTok,
          costUsd: (inTok / 1e6) * RATE_IN_PER_MTOK + (outTok / 1e6) * RATE_OUT_PER_MTOK,
          ms: Date.now() - t0,
        });
        return res;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
}

const spentUsd = () => allCalls.reduce((s, c) => s + c.costUsd, 0);

// ── corpus record shapes ─────────────────────────────────────────────────────

export interface CookStepRecord {
  sequenceIndex: number;
  dishId: string;
  dishTitle: string | null;
  originalStepIndex: number;
  /** Serve-anchored: 0 = serve, negative = minutes before serve. */
  startOffsetMinutes: number | null;
  estimatedMinutes: number;
  phaseType: string;
  isTimingSensitive: boolean;
  parallelGroup: string | null;
  componentKey: string | null;
  pathKey: string | null;
  cue: string | null;
  text: string;
  /** True when the step came off the §27 defensive append, not the sequence. */
  appended: boolean;
}

export interface CookMealRecord {
  mealId: string;
  mealTitle: string;
  assignedDayOfWeek: string | null;
  assignedDate: string | null;
  hasRecipeOverride: boolean;
  dishCount: number;
  /** Cook Mode's live total, from scheduleCookingSequence. */
  sequenceTotalMinutes: number;
  /** The stored card number (Meal.estimatedTimeMinutes). */
  cardTotalMinutes: number;
  cardActiveMinutes: number | null;
  /** Re-derived here through mealTiming's canonical dish order. */
  derivedTotalMinutes: number | null;
  derivedActiveMinutes: number | null;
  ignoredTags: unknown[];
  steps: CookStepRecord[];
}

export interface PrepStepRecord {
  stepKey: string;
  phase: string;
  phaseTitle: string;
  number: number;
  title: string;
  instructions: string;
  estimatedMinutes: number;
  storageNote: string | null;
  skipSuggested: boolean;
  /** Rendered by the phone? (skipSuggested steps are render-omitted.) */
  rendered: boolean;
  contributesToMealIds: string[];
  destinationLabels: string[];
  /**
   * H4 / rule 11(c) — the container this step works on, when it has one. Two
   * steps sharing one value are ONE container, which is what the header counts.
   */
  /**
   * H5 — the step holds no food at all (the wash step; a cook-day sentence). The
   * product excludes it from the header count, and without it here the harness's
   * own decomposition over-reported by exactly one.
   */
  holdsNoContainer: boolean;
  containerId: string | null;
  /** H6.1-B — the vessels this step fills, by name. The header counts their union. */
  containerNames: string[];
}

export interface PlanRecord {
  planId: string;
  planName: string | null;
  startDate: string | null;
  endDate: string | null;
  mealCount: number;
  /** Did EVERY item carry a day? P-R3 can only be judged where a day exists. */
  datedItems: number;
  dayByMealId: Record<string, { day: string | null; date: string | null }>;
  prep: {
    totalEstimatedMinutes: number;
    /** The phone's number — KEPT steps only (skipSuggested render-omitted). */
    renderedTotalMinutes: number;
    /** D-WS9-301 rule 13 — the held-for-cook-day lines, as the screen shows them. */
    heldForCookDay: string[];
    /** D-WS9-301 rule 9 — rendered steps per phase, for P-R1's breakdown. */
    stepsPerPhase: Record<string, number>;
    /** D-WS9-301 ruling 4 — the two numbers the HEADER shows, from the product. */
    containerCount: number;
    statedMinutes: number;
    steps: PrepStepRecord[];
    /** D-WS9-298 item 3 — the quiet per-phase line, code-owned. */
    phaseNotes: Record<string, string>;
    /** What the narrator was handed, verbatim — the audit trail for a prompt fix. */
    narrationInputHash: string;
    plannedStepCount: number;
  } | null;
  prepError: string | null;
  meals: CookMealRecord[];
}

// ── per-plan run ─────────────────────────────────────────────────────────────

async function runPlan(planId: string): Promise<PlanRecord> {
  const plan = await prisma.mealPlanInstance.findUnique({
    where: { id: planId },
    select: {
      id: true,
      userId: true,
      titleOverride: true,
      startDate: true,
      endDate: true,
      items: {
        orderBy: { positionIndex: "asc" },
        select: {
          mealId: true,
          assignedDayOfWeek: true,
          assignedDate: true,
          servingsOverride: true,
          recipeOverrideJson: true,
          meal: { select: { id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true } },
        },
      },
    },
  });
  if (!plan) throw new Error(`plan ${planId} not found`);

  const dayByMealId: PlanRecord["dayByMealId"] = {};
  for (const it of plan.items) {
    if (!(it.mealId in dayByMealId)) {
      dayByMealId[it.mealId] = {
        day: it.assignedDayOfWeek,
        date: it.assignedDate ? it.assignedDate.toISOString().slice(0, 10) : null,
      };
    }
  }

  const rec: PlanRecord = {
    planId: plan.id,
    planName: plan.titleOverride,
    startDate: plan.startDate?.toISOString().slice(0, 10) ?? null,
    endDate: plan.endDate?.toISOString().slice(0, 10) ?? null,
    mealCount: plan.items.length,
    datedItems: plan.items.filter((i) => i.assignedDate != null).length,
    dayByMealId,
    prep: null,
    prepError: null,
    meals: [],
  };

  // ── Prep the Week (the blended path, cache bypassed on both sides) ────────
  try {
    const { input, cookDays } = await loadPrepWeekInput({ planId: plan.id, userId: plan.userId, prisma });
    const combineResult = combinePrep(buildPrepCombineInput(input));
    const stepTextByDishId = new Map<string, string[]>();
    for (const meal of input.meals) {
      for (const dish of meal.dishes) stepTextByDishId.set(dish.dishId, dish.stepTexts);
    }
    // D-WS9-298 — the lag map comes off the LOADER now. B1 computed it here and
    // in the route, two copies of one arithmetic; the reversal removed both.
    const stepPlan = buildStepPlan(combineResult, input.planName, stepTextByDishId, cookDays.lagByMealId);
    if (stepPlan.steps.length === 0) {
      rec.prepError = "empty step plan";
    } else {
      const ai = await runAICall(
        "prep.narrate_steps",
        { prepNarrationInput: stepPlan.narrationInput },
        PrepNarrationResultSchema,
        { prisma, maxTokens: 16384, client: spyClient() },
      );
      if (!ai.success) {
        rec.prepError = `ai ${ai.reason}`;
      } else {
        // D-WS9-298 — the SAME overlay the route applies on every read. Without
        // it the corpus would measure prose the screen never shows: the storage
        // notes and the protein demotions are computed, not narrated.
        const mealNameById = new Map(input.meals.map((m) => [m.mealId, m.mealName]));
        const storageContext = new Map<string, StorageContext>();
        for (const st of stepPlan.steps) {
          const names = st.components.map((c) => c.ingredientName);
          const notes = st.components.flatMap((c) => [
            c.preparationNote ?? "",
            ...c.measures.map((x) => x.preparationNote ?? ""),
          ]);
          // D-WS9-301 rule 13 — the held line names the day and the meal, and
          // the ROUTE supplies both. A harness that leaves them out reports an
          // empty held list on a plan that has one; that is the B2 E lesson for
          // the third time this pass, so it is copied rather than approximated.
          const latest = st.contributesToMealIds
            .map((id) => ({ id, lag: cookDays.lagByMealId.get(id) ?? -1 }))
            .sort((x, y) => y.lag - x.lag)[0];
          const dayName = latest ? cookDays.dayNameByMealId.get(latest.id) : undefined;
          const mealName = latest ? mealNameById.get(latest.id) : undefined;
          storageContext.set(st.stepKey, {
            daysUntilCook: st.daysUntilCook,
            phase: st.phase,
            ...(dayName ? { dayName } : {}),
            ...(mealName ? { mealName } : {}),
            // The BOWL NAME is part of the text on purpose: "Fajita spice
            // blend" and "… seasoning" say what the mixture IS, and without it a
            // dry blend read as loose produce and got a fridge note.
            text: [...names, ...notes].join(" "),
            bowlName: st.bowlName,
            ingredientNames: names,
          });
        }
        const assembled = PrepWeekResultSchema.parse(
          applyStorageOverlay(assemblePrepWeekResult(stepPlan, ai.data), storageContext),
        );
        // THE PHONE'S RENDER — the same two client functions Screen 3 calls.
        const lookup = buildMealLabelLookup(
          plan.items.map((i) => ({
            mealId: i.mealId,
            assignedDayOfWeek: i.assignedDayOfWeek,
            meal: i.meal ? { title: i.meal.title } : null,
          })),
        );
        // D-WS9-299 — the ENGINE's demotion, folded in before the client model
        // sees it. `buildPrepWeekModel` render-omits `skipSuggested`, and a
        // code-owned demotion has to reach it the same way an AI one does.
        const engineDemoted = new Set(
          stepPlan.steps.filter((s) => s.demoted).map((s) => s.stepKey),
        );
        const withDemotions = {
          ...assembled,
          phases: assembled.phases.map((ph) => ({
            ...ph,
            steps: ph.steps.map((st) =>
              engineDemoted.has(st.stepKey) ? { ...st, skipSuggested: true } : st,
            ),
          })),
        };
        const vm = buildPrepWeekModel(withDemotions, { mealLabel: lookup });
        const renderedKeys = new Set<string>();
        for (const p of vm.phases) for (const s of p.steps) renderedKeys.add(s.stepKey);

        const steps: PrepStepRecord[] = [];
        for (const phase of withDemotions.phases) {
          for (const s of phase.steps) {
            steps.push({
              stepKey: s.stepKey,
              phase: phase.phase,
              phaseTitle: phase.title,
              number: s.number,
              title: s.title,
              instructions: s.instructions,
              estimatedMinutes: s.estimatedMinutes,
              storageNote: s.storageNote ?? null,
              skipSuggested: s.skipSuggested === true,
              rendered: renderedKeys.has(s.stepKey),
              contributesToMealIds: [...s.contributesToMealIds],
              destinationLabels: s.contributesToMealIds.map(
                (id) => lookup(id)?.name ?? "A planned meal",
              ),
              holdsNoContainer: s.holdsNoContainer === true,
              containerId: s.containerId ?? null,
              containerNames: s.containerNames ?? [],
            });
          }
        }
        const phaseNotes: Record<string, string> = {};
        for (const ph of withDemotions.phases) if (ph.note) phaseNotes[ph.phase] = ph.note;
        // D-WS9-301 rule 13 + the P-R1 phase breakdown.
        const heldForCookDay: string[] = [];
        const stepsPerPhase: Record<string, number> = {};
        for (const ph of withDemotions.phases) {
          if (ph.heldForCookDay) heldForCookDay.push(...ph.heldForCookDay);
          stepsPerPhase[ph.phase] = ph.steps.filter((x) => !x.skipSuggested).length;
        }
        const summary = summarizePrepWeek(withDemotions);
        rec.prep = {
          phaseNotes,
          totalEstimatedMinutes: assembled.totalEstimatedMinutes,
          renderedTotalMinutes: vm.totalEstimatedMinutes,
          // D-WS9-301 ruling 4 — the SAME function the route calls on every read.
          // Without it the corpus could not see the header at all, which is the
          // B2 E lesson again: a harness that renders less than the product
          // misreports the product.
          heldForCookDay,
          stepsPerPhase,
          containerCount: summary.containerCount ?? 0,
          statedMinutes: summary.estimatedMinutes ?? 0,
          steps,
          narrationInputHash: sha(JSON.stringify(stepPlan.narrationInput)),
          plannedStepCount: stepPlan.steps.length,
        };
        writeFileSync(
          join(OUT, `${TAG}__${plan.id.slice(0, 8)}__narration-input.json`),
          JSON.stringify(stepPlan.narrationInput, null, 2),
        );
      }
    }
  } catch (err) {
    rec.prepError = String((err as Error)?.message ?? err);
  }

  // ── Cook Mode, one sequence per meal (deterministic, free) ────────────────
  const seen = new Set<string>();
  for (const item of plan.items) {
    if (seen.has(item.mealId) || !item.meal) continue;
    seen.add(item.mealId);
    try {
      const seq = await runCookingSequence({
        mealId: item.mealId,
        userId: plan.userId,
        deps: { prisma },
      });
      const detail = await composeMealDetail(
        prisma,
        item.mealId,
        item.recipeOverrideJson,
        item.servingsOverride,
      );
      if (!detail) continue;

      // THE PHONE'S RENDER — the same client function Cook Mode calls.
      const cookSteps = sequenceMealSteps(detail, seq.sequence);
      const offsetByKey = new Map<string, number>();
      const cueByKey = new Map<string, string | undefined>();
      const seqIdxByKey = new Map<string, number>();
      for (const e of seq.sequence) {
        const k = `${e.dishId}#${e.originalStepIndex}`;
        offsetByKey.set(k, e.startOffsetMinutes);
        cueByKey.set(k, e.reason);
        seqIdxByKey.set(k, e.sequenceIndex);
      }
      // The scheduler's own view of each step, for the tags the render drops.
      const rawSteps = await prisma.recipeInstructionStep.findMany({
        where: { ownerType: "dish", ownerId: { in: detail.dishes.map((d) => d.dishId) } },
        select: {
          ownerId: true, stepIndex: true, phaseType: true, isTimingSensitive: true,
          parallelGroup: true, componentKey: true, pathKey: true, estimatedMinutes: true,
        },
      });
      const rawByKey = new Map(rawSteps.map((s) => [`${s.ownerId}#${s.stepIndex}`, s]));

      const steps: CookStepRecord[] = cookSteps.map((cs, i) => {
        const raw = rawByKey.get(cs.key);
        const [dishId, idxStr] = cs.key.split("#");
        return {
          sequenceIndex: i,
          dishId,
          dishTitle: cs.dishTitle ?? null,
          originalStepIndex: Number(idxStr),
          startOffsetMinutes: offsetByKey.get(cs.key) ?? null,
          estimatedMinutes: cs.estimatedMinutes,
          phaseType: cs.phaseType,
          isTimingSensitive: cs.isTimingSensitive,
          parallelGroup: raw?.parallelGroup ?? null,
          componentKey: raw?.componentKey ?? null,
          pathKey: raw?.pathKey ?? null,
          cue: cs.cue ?? null,
          text: cs.text,
          appended: !offsetByKey.has(cs.key),
        };
      });

      // Re-derive through mealTiming so the card's own code path is measured,
      // not a second copy of it.
      const byDish = new Map<string, typeof rawSteps>();
      for (const s of rawSteps) {
        const l = byDish.get(s.ownerId);
        if (l) l.push(s); else byDish.set(s.ownerId, [s]);
      }
      const links = await prisma.mealDishLink.findMany({
        where: { mealId: item.mealId },
        select: { dishId: true, positionIndex: true, dish: { select: { title: true } } },
      });
      const timing = deriveMealTiming(
        links.map((l) => ({
          dishId: l.dishId,
          title: l.dish.title,
          positionIndex: l.positionIndex,
          steps: (byDish.get(l.dishId) ?? [])
            .slice()
            .sort((a, b) => a.stepIndex - b.stepIndex)
            .map((s) => ({
              stepIndex: s.stepIndex,
              estimatedMinutes: s.estimatedMinutes <= 0 ? 1 : s.estimatedMinutes,
              phaseType: s.phaseType as never,
              isTimingSensitive: s.isTimingSensitive,
              parallelGroup: s.parallelGroup,
              componentKey: s.componentKey,
              pathKey: s.pathKey,
            })),
        })),
      );

      rec.meals.push({
        mealId: item.mealId,
        mealTitle: item.meal.title,
        assignedDayOfWeek: item.assignedDayOfWeek,
        assignedDate: item.assignedDate ? item.assignedDate.toISOString().slice(0, 10) : null,
        hasRecipeOverride: item.recipeOverrideJson != null,
        dishCount: seq.dishCount,
        sequenceTotalMinutes: seq.totalEstimatedMinutes,
        cardTotalMinutes: item.meal.estimatedTimeMinutes,
        cardActiveMinutes: item.meal.activeTimeMinutes,
        derivedTotalMinutes: timing.totalMinutes,
        derivedActiveMinutes: timing.activeMinutes,
        ignoredTags: timing.ignoredTags,
        steps,
      });
    } catch (err) {
      console.error(`  meal ${item.mealId.slice(0, 8)} failed: ${String((err as Error)?.message ?? err)}`);
    }
  }

  return rec;
}

// ── readable render ──────────────────────────────────────────────────────────

function renderText(rec: PlanRecord): string {
  const L: string[] = [];
  L.push(`PLAN ${rec.planId}  ${rec.planName ?? "(untitled)"}`);
  L.push(`  range ${rec.startDate ?? "-"} .. ${rec.endDate ?? "-"}   meals ${rec.mealCount}   dated ${rec.datedItems}/${rec.mealCount}`);
  L.push("");
  L.push("══════════ PREP THE WEEK (as Screen 3 renders it) ══════════");
  if (!rec.prep) {
    L.push(`  (no prep: ${rec.prepError})`);
  } else {
    // D-WS9-301 ruling 4 — print the HEADER first, because it is the first thing
    // the cook reads and a corpus that does not print it cannot audit it.
    L.push(`  HEADER: ${rec.prep.containerCount} containers · about ${rec.prep.statedMinutes} min`);
    L.push(
      `  phases: ` +
        ["seasonings_dry", "produce", "sauces_marinades", "proteins"]
          .map((p) => `${p} ${rec.prep!.stepsPerPhase[p] ?? 0}`)
          .join(" · "),
    );
    // H4 / rule 11(c) — WHAT THE FIRST NUMBER IS MADE OF. Without this the
    // corpus prints a count and no way to tell a real rise from a re-sort.
    {
      const live = rec.prep.steps.filter((x) => !x.skipSuggested);
      // H6.2 — MIRROR summarizePrepWeek EXACTLY: distinct container NAMES plus the
      // steps that name none (each its own container). The earlier version counted
      // every nameless step as "ingredient" and reported 27 where the header said 20 —
      // the harness-renders-less-than-the-product lesson, fifth time this pass.
      const names = new Set<string>();
      let unnamed = 0;
      let twoStep = 0;
      {
        const perName = new Map<string, number>();
        for (const x of live) {
          if (x.holdsNoContainer) continue;
          const here = x.containerNames ?? [];
          if (here.length === 0) { unnamed += 1; continue; }
          for (const n of here) { names.add(n); perName.set(n, (perName.get(n) ?? 0) + 1); }
        }
        twoStep = [...perName.values()].filter((n) => n > 1).length;
      }
      L.push(
        `  CONTAINERS: ${names.size} named (${twoStep} touched by more than one step) + ${unnamed} own = ${names.size + unnamed}`,
      );
    }
    for (const h of rec.prep.heldForCookDay) L.push(`  HELD: ${h}`);
    L.push(`  server total ${rec.prep.totalEstimatedMinutes} min · phone shows ${rec.prep.renderedTotalMinutes} min · ${rec.prep.steps.length} steps (${rec.prep.plannedStepCount} planned)`);
    let phase = "";
    for (const s of rec.prep.steps) {
      if (s.phase !== phase) {
        phase = s.phase;
        L.push("");
        L.push(`  ── ${s.phaseTitle} [${s.phase}] ──`);
        const note = rec.prep?.phaseNotes?.[s.phase];
        if (note) L.push(`     » ${note}`);
      }
      L.push(`  ${s.rendered ? " " : "×"} ${String(s.number).padStart(2)}. ${s.title}   (${s.estimatedMinutes} min)${s.skipSuggested ? "  [skipSuggested — RENDER-OMITTED]" : ""}`);
      for (const line of s.instructions.split("\n")) L.push(`        ${line}`);
      if (s.storageNote) L.push(`        » storage: ${s.storageNote}`);
      const days = s.contributesToMealIds.map((id) => {
        const d = rec.dayByMealId[id];
        return `${rec.prep ? "" : ""}${d?.day ?? "?"}${d?.date ? ` ${d.date}` : ""}`;
      });
      L.push(`        » for: ${s.destinationLabels.map((n, i) => `${n} (${days[i]})`).join(", ")}`);
    }
  }
  L.push("");
  L.push("══════════ COOK MODE (as the cook session renders it) ══════════");
  for (const m of rec.meals) {
    L.push("");
    L.push(`  ▸ ${m.mealTitle}   [${m.assignedDayOfWeek ?? "unassigned"}${m.assignedDate ? ` ${m.assignedDate}` : ""}]`);
    L.push(`    cook-mode total ${m.sequenceTotalMinutes} min | card ${m.cardTotalMinutes} min | card-active ${m.cardActiveMinutes ?? "-"} | re-derived ${m.derivedTotalMinutes}/${m.derivedActiveMinutes} | dishes ${m.dishCount}`);
    if (m.hasRecipeOverride) L.push(`    ⚠ plan item carries a recipeOverride — the sequence did not see it`);
    for (const s of m.steps) {
      const off = s.startOffsetMinutes == null ? "  APPD" : `T${s.startOffsetMinutes >= 0 ? "+" : ""}${s.startOffsetMinutes}`;
      L.push(`    ${String(s.sequenceIndex + 1).padStart(3)}. [${off.padStart(6)}] (${String(s.estimatedMinutes).padStart(3)}m ${s.phaseType}${s.isTimingSensitive ? "!" : " "}) ${s.dishTitle ?? ""}`);
      if (s.cue) L.push(`         ⟶ ${s.cue}`);
      L.push(`         ${s.text}`);
    }
  }
  return L.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────

async function resolve(prefix: string): Promise<string> {
  const rows = await prisma.mealPlanInstance.findMany({
    where: { id: { startsWith: prefix } },
    select: { id: true },
  });
  if (rows.length === 0) throw new Error(`no plan matches ${prefix}`);
  if (rows.length > 1) throw new Error(`ambiguous plan prefix ${prefix} (${rows.length} matches)`);
  return rows[0].id;
}

async function main() {
  const records: PlanRecord[] = [];
  for (const prefix of PREFIXES) {
    if (spentUsd() >= BUDGET) {
      console.error(`BUDGET STOP: $${spentUsd().toFixed(4)} spent, --budget ${BUDGET}; ${PREFIXES.length - records.length} plans not run`);
      break;
    }
    const id = await resolve(prefix);
    process.stderr.write(`${prefix} … `);
    const before = spentUsd();
    const rec = await runPlan(id);
    records.push(rec);
    writeFileSync(join(OUT, `${TAG}__${id.slice(0, 8)}.json`), JSON.stringify(rec, null, 2));
    writeFileSync(join(OUT, `${TAG}__${id.slice(0, 8)}.txt`), renderText(rec));
    console.error(
      `${rec.prep ? `${rec.prep.steps.length} prep steps` : `PREP FAILED (${rec.prepError})`}, ${rec.meals.length} meals, $${(spentUsd() - before).toFixed(4)}`,
    );
  }

  const summary = {
    tag: TAG,
    generatedAt: new Date().toISOString(),
    plans: records.length,
    meals: records.reduce((s, r) => s + r.meals.length, 0),
    prepSteps: records.reduce((s, r) => s + (r.prep?.steps.length ?? 0), 0),
    cookSteps: records.reduce((s, r) => s + r.meals.reduce((t, m) => t + m.steps.length, 0), 0),
    aiCalls: allCalls.length,
    inputTokens: allCalls.reduce((s, c) => s + c.inputTokens, 0),
    outputTokens: allCalls.reduce((s, c) => s + c.outputTokens, 0),
    costUsd: Number(spentUsd().toFixed(4)),
    calls: allCalls,
  };
  writeFileSync(join(OUT, `${TAG}__summary.json`), JSON.stringify(summary, null, 2));
  console.error(
    `\n${summary.plans} plans · ${summary.meals} meals · ${summary.prepSteps} prep steps · ${summary.cookSteps} cook steps · ${summary.aiCalls} AI calls · $${summary.costUsd}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => realPrisma.$disconnect());
