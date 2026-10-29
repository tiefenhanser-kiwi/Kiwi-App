// QA-COOK-1 (item E) — `pnpm run qa:night --cook-sim`: the kitchen simulator on
// every household's meals (free), and the AI home cooks on a rotating 5 meals.
//
// Twice per household, through the household's own account and the same reads
// Cook Mode makes (scripts/qa-cook/capture.ts's): right after "Cook Mode
// unprepped", and again after its prep paths (the plan's ticks then fold and
// word the steps; a household that never prepped reads the same as before).
// The views are the app's (scripts/qa-cook/appView.ts), the findings the
// simulator's (scripts/qa-cook/simulator.ts) and the cooks the personas'.
//
// The AI cooks take the night's 5 meals in turn: the unprepped sessions, one per
// meal title, sorted, and the window moves by 5 a day, so every meal comes
// round. Their spend is priced from each response and counted against the
// night's KIWI_QA_BUDGET_USD.
import Anthropic from "@anthropic-ai/sdk";

import { buildCookView, isMultiDish, type PrepEvidence, type SequenceReply } from "../qa-cook/appView";
import { collectHits, type Hit } from "../qa-cook/patterns";
import { pool, runPersona } from "../qa-cook/personas";
import { nightSection } from "../qa-cook/report";
import { simulate } from "../qa-cook/simulator";
import type { CookView, KFinding, PersonaId, PersonaRun, SampleCategory } from "../qa-cook/types";
import type { Household } from "./journeys";

export const COOK_SIM_FLAG = "--cook-sim";

export function cookSimWanted(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes(COOK_SIM_FLAG) || env.KIWI_QA_COOK_SIM === "1";
}

export interface CookSimNight {
  views: CookView[];
  sims: { view: CookView; findings: KFinding[] }[];
  runs: PersonaRun[];
  usd: number;
}

export function emptyNight(): CookSimNight {
  return { views: [], sims: [], runs: [], usd: 0 };
}

/** One household's Cook Mode sessions as the app shows them, at this point of its night. */
export async function householdViews(h: Household, stage: "unprepped" | "after prep"): Promise<CookView[]> {
  const out: CookView[] = [];
  const planId = h.planId;
  let prep: PrepEvidence | null = null;
  if (stage === "after prep") {
    const c = await h.api.must<any>("GET", `/plans/${planId}/prep-week/completions`);
    const completions = (c.completions as { stepKey: string; checkedAt: string }[]) ?? [];
    // Cook Mode loads the week's payload only once a completion exists (shouldLoadPrepForCook).
    if (completions.length === 0) return out;
    const w = await h.api.req<any>("POST", `/plans/${planId}/prep-week`, undefined, { expect: [400, 404, 409, 422, 502] });
    prep = { result: w.status === 200 ? w.body.result : undefined, checked: completions.map((x) => x.stepKey), completions };
  }
  for (const m of h.meals) {
    const meal = (await h.api.must<any>("GET", `/meals/${m.mealId}?planItemId=${m.planItemId}`)).meal;
    let sequence: SequenceReply | null = null;
    if (isMultiDish(meal)) {
      const r = await h.api.req<SequenceReply>("POST", `/meals/${m.mealId}/cooking-sequence`, { planItemId: m.planItemId }, { expect: [429] });
      if (r.status === 200) sequence = r.body;
    }
    const category: SampleCategory = m.isFeast ? "feast" : meal.dishes.length >= 3 ? "multi-dish" : "one-pan";
    const servings = meal.effectiveServings ?? m.servingsOverride ?? 4;
    // The meal's title stands for it across households: each forks its own copy.
    out.push(buildCookView({ meal, sequence, prep, sourceMealId: `title:${m.title}`, category, servings }));
  }
  return out;
}

export function simulateAll(night: CookSimNight, views: CookView[]): void {
  for (const v of views) {
    night.views.push(v);
    night.sims.push({ view: v, findings: simulate(v).findings });
  }
}

/** Tonight's 5 meals: one unprepped session per title, sorted, a window that moves 5 a day. */
export function rotatingMeals(views: CookView[], date: string, n = 5): CookView[] {
  const byTitle = new Map<string, CookView>();
  for (const v of views) if (!v.prepped && !byTitle.has(v.title)) byTitle.set(v.title, v);
  const all = [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title));
  if (all.length <= n) return all;
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  const start = (day * n) % all.length;
  return Array.from({ length: n }, (_, i) => all[(start + i) % all.length]);
}

export async function runNightCooks(night: CookSimNight, opts: { apiKey: string; date: string; model: string; budgetLeftUsd: number; seed: number }): Promise<CookView[]> {
  const meals = rotatingMeals(night.views, opts.date);
  const client = new Anthropic({ apiKey: opts.apiKey });
  const personas: PersonaId[] = ["beginner", "weeknight", "interrupted"];
  const jobs = meals.flatMap((v) => personas.map((persona) => ({ v, persona })));
  let left = opts.budgetLeftUsd;
  await pool(jobs, 6, async (j) => {
    // A Haiku step costs well under $0.001: reserve $0.002 a step, and stop when the night's budget would not hold it.
    const reserve = 0.002 * (j.v.steps.length + 1);
    if (reserve > left) return;
    left -= reserve;
    const r = await runPersona(client, j.v, j.persona, { model: opts.model, effort: "low", seed: opts.seed, maxRunUsd: reserve * 2 });
    left += reserve - r.usd;
    night.runs.push(r);
    night.usd += r.usd;
  });
  return meals;
}

export function nightHits(night: CookSimNight): Hit[] {
  return collectHits(night.sims, night.runs, night.views);
}

export function renderNight(night: CookSimNight, meals: CookView[]): string {
  return nightSection({ hits: nightHits(night), views: night.views.length, runs: night.runs, usd: night.usd, meals: meals.map((v) => v.title) });
}
