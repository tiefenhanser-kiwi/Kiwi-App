// THX-2G follow-up C — what Prep the Week builds for a Thanksgiving week, for
// the review page. IN MEMORY, WRITING NOTHING.
//
// The route (POST /plans/:planId/prep-week, routes/cooking.ts) needs a stored
// plan. Instead of creating one, this hands the route's own loader
// (loadPrepWeekInput) a read-only Prisma proxy: `mealPlanInstance.findUnique`
// answers with a synthetic plan built from the real meal rows, every other read
// passes through, and ANY write method throws. Then it runs the route's own
// sequence: buildPrepWeekPlan → assemblePrepWeekResult → the PrepWeekResult
// schema check → summarizePrepWeek(finishPrepWeek(…)).
//
// The one thing skipped is the narration (`prep.narrate_steps`, an AI call): a
// stub supplies each step's engine title as its prose. Everything the narrator
// does NOT own — the steps, their minutes (BUG-204: code-owned), containers,
// the storage notes, the cook-day holds, the header numbers, the 30-step cap —
// is the route's own output.
//
// The week: Wednesday pizza night, Thursday the feast (servingsOverride = its
// authored servings, as THX-2S's template item carries), Friday that plan's
// leftovers meal. Monday and Tuesday are lane A's catalog picks and are not in
// this database's thx2- rows, so they are left out (they would add their own
// steps on top). Dated as the anchored template runs: start Monday November 23,
// prep read on Sunday November 22.

import type { PrismaClient } from "@prisma/client";

import { PrepWeekResultSchema, type PrepWeekResult } from "../../src/lib/ai/schemas/prepWeek";
import type { PrepNarrationResult } from "../../src/lib/ai/schemas/prepNarration";
import { loadPrepWeekInput } from "../../src/lib/prepWeekAggregation";
import { assemblePrepWeekResult, engineTitle, summarizePrepWeek } from "../../src/lib/prepWeekAssembly";
import { buildPrepWeekPlan, finishPrepWeek } from "../../src/lib/prepWeekBuild";
import type { Thx2Target, TargetsFile } from "./thx2Core";

export const PREP_WEEK_START = new Date("2026-11-23T00:00:00Z"); // Monday
export const PREP_READ_AT = new Date("2026-11-22T15:00:00Z"); // Sunday
export const PHASE_STEP_CAP = 30;

const WRITE_METHODS = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany",
]);
const WRITE_CLIENT = new Set(["$executeRaw", "$executeRawUnsafe", "$transaction"]);

/**
 * A Prisma client that can only read. `mealPlanInstance.findUnique` returns
 * `plan`; every other model read goes to `real`; any write throws.
 */
export function readOnlyPrisma(real: PrismaClient, plan: unknown): PrismaClient {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "mealPlanInstance") return { findUnique: async () => plan };
      if (typeof prop === "string" && WRITE_CLIENT.has(prop)) {
        return () => { throw new Error(`thx2Prep: ${prop} refused — the review computes prep in memory and writes nothing`); };
      }
      const value = Reflect.get(target, prop, receiver);
      if (value && typeof value === "object" && typeof (value as { findMany?: unknown }).findMany === "function") {
        return new Proxy(value as object, {
          get(model, method, r) {
            if (typeof method === "string" && WRITE_METHODS.has(method)) {
              return () => { throw new Error(`thx2Prep: ${String(prop)}.${method} refused — the review writes nothing`); };
            }
            const fn = Reflect.get(model, method, r);
            return typeof fn === "function" ? fn.bind(model) : fn;
          },
        });
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

export interface WeekSlot { key: string; day: string; servingsOverride: number | null }

/** The Wednesday–Friday slots of a feast's week (keys that exist in targets.json). */
export function weekFor(feast: Thx2Target, file: TargetsFile): WeekSlot[] {
  const friday = file.targets.find((t) => t.kind === "friday" && t.plan === feast.plan);
  const wednesday = file.targets.find((t) => t.kind === "weeknight");
  return [
    ...(wednesday ? [{ key: wednesday.key, day: "Wednesday", servingsOverride: null }] : []),
    { key: feast.key, day: "Thursday", servingsOverride: feast.servings },
    ...(friday ? [{ key: friday.key, day: "Friday", servingsOverride: null }] : []),
  ];
}

/** Each planned step's engine title as its prose: the narration, minus the AI. */
function stubNarration(steps: ReturnType<typeof buildPrepWeekPlan>["stepPlan"]["steps"]): PrepNarrationResult {
  return {
    steps: steps
      .filter((s) => !s.fixedProse)
      .map((s) => {
        const title = engineTitle(s).slice(0, 120) || "Prep";
        return { stepId: s.stepId, title, instructions: `${title}.`.slice(0, 800) };
      }),
  };
}

export interface PrepReport {
  days: { day: string; key: string; title: string }[];
  missing: string[];
  result: PrepWeekResult | null;
  schemaOk: boolean;
  schemaErrors: string[];
  overCap: { phase: string; steps: number }[];
  error?: string;
}

export async function prepReportFor(prisma: PrismaClient, feast: Thx2Target, file: TargetsFile): Promise<PrepReport> {
  const slots = weekFor(feast, file);
  const include = {
    dishLinks: {
      orderBy: { positionIndex: "asc" as const },
      include: { dish: { include: { dishIngredients: { orderBy: { positionIndex: "asc" as const }, include: { ingredient: true } } } } },
    },
  };
  const items: unknown[] = [];
  const days: PrepReport["days"] = [];
  const missing: string[] = [];
  for (const [i, s] of slots.entries()) {
    const meal = await prisma.meal.findFirst({ where: { sourceType: "batch_generated", dishFamilyKey: s.key }, include });
    if (!meal) { missing.push(s.key); continue; }
    days.push({ day: s.day, key: s.key, title: meal.title });
    items.push({ id: `review-item-${i}`, mealId: meal.id, positionIndex: i, assignedDayOfWeek: s.day, servingsOverride: s.servingsOverride, meal });
  }
  const empty = { days, missing, result: null, schemaOk: false, schemaErrors: [] as string[], overCap: [] as PrepReport["overCap"] };
  if (!days.some((d) => d.key === feast.key)) return { ...empty, error: "the feast is not in this database" };
  const plan = { id: `review-${feast.key}`, userId: "thx2-review", titleOverride: `${feast.title} week`, startDate: PREP_WEEK_START, revisionId: 0, items };
  try {
    const load = await loadPrepWeekInput({ planId: plan.id, userId: plan.userId, prisma: readOnlyPrisma(prisma, plan), now: PREP_READ_AT });
    const build = buildPrepWeekPlan(load);
    const assembled = assemblePrepWeekResult(build.stepPlan, stubNarration(build.stepPlan.steps));
    const parsed = PrepWeekResultSchema.safeParse(assembled);
    const result = summarizePrepWeek(finishPrepWeek(assembled, build));
    return {
      days,
      missing,
      result,
      schemaOk: parsed.success,
      schemaErrors: parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      overCap: result.phases.filter((p) => p.steps.length > PHASE_STEP_CAP).map((p) => ({ phase: p.phase, steps: p.steps.length })),
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}
