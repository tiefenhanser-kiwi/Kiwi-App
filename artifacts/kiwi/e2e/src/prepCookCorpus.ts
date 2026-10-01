// ─────────────────────────────────────────────────────────────────────────────
// Build the prep-cook census's PlanRecord out of what the HTTP API returns.
//
// This turned out to be the cheap half of the bridge, because `GET /meals/:id`
// already carries every per-step tag the census reads straight out of Prisma:
// phaseType, isTimingSensitive, parallelGroup, componentKey, pathKey. The
// browser lane therefore scores K-R1…K-R6 on exactly the same fields the
// server-side census does, with no database read of its own.
//
// 🔴 THE ONE THING THAT IS GENUINELY OUT OF REACH: the NARRATION INPUT.
// prep-cook-census/census.ts writes `<tag>__<plan>__narration-input.json`
// straight out of `buildStepPlan`'s intermediate — what the narrator was
// handed, before the AI answered. P-R1's container arithmetic and the whole of
// P-R2 ("one named bowl per component across phases") are derived from it, and
// NO endpoint exposes it: POST /plans/:id/prep-week returns the assembled
// result only.
//
// The bridge does not fake it. It writes no narration file, the checker's own
// `try/catch` nulls it, and P-R2 then scores 0-of-0 — visibly a rule with no
// candidates rather than a rule that passed. P-R1 keeps its rendered-text arm
// ("the prose asks for N containers explicitly"), which needs no narration.
// ─────────────────────────────────────────────────────────────────────────────
import type { Api, CookingSequenceResponse, PlanResponse } from "./api";

export interface PrepCookGaps {
  gaps: string[];
}

interface CookStepRecord {
  sequenceIndex: number;
  dishId: string;
  dishTitle: string | null;
  originalStepIndex: number;
  startOffsetMinutes: number | null;
  estimatedMinutes: number;
  phaseType: string;
  isTimingSensitive: boolean;
  parallelGroup: string | null;
  componentKey: string | null;
  pathKey: string | null;
  cue: string | null;
  text: string;
  appended: boolean;
}

interface WireStep {
  stepIndex: number;
  text: string;
  estimatedMinutes: number;
  phaseType: string;
  isTimingSensitive: boolean;
  parallelGroup: string | null;
  componentKey: string | null;
  pathKey: string | null;
  amountRefs?: unknown;
}

interface WireDish {
  dishId: string;
  title: string;
  steps: WireStep[];
}

interface WireMeal {
  id: string;
  title: string;
  minutes: number;
  activeTimeMinutes: number | null;
  dishes: WireDish[];
  steps: WireStep[];
}

/**
 * One meal's CookMeal record: the sequenced order joined back onto the held
 * meal detail, exactly as CookSessionView does it, through the phone's own
 * `sequenceMealSteps`.
 */
export async function buildCookMeal(
  api: Api,
  args: {
    mealId: string;
    planItemId: string;
    assignedDayOfWeek: string | null;
    assignedDate: string | null;
  },
  gaps: string[],
): Promise<{
  record: CookStepRecord[];
  meal: WireMeal;
  seq: CookingSequenceResponse | null;
  /** What the app's own footer expression yields, for the screen cross-check. */
  appFooterMinutes: number | null;
  /** The discredited serial sum, kept only so the report can show the delta. */
  serialSumMinutes: number;
}> {
  const { sequenceMealSteps, remainingMinutes, remainingMinutesToServe } = await import(
    "../../lib/cooking/cookSession"
  );

  const detailRaw = (await api.meal(args.mealId, args.planItemId)) as { meal?: WireMeal };
  const meal = (detailRaw.meal ?? (detailRaw as unknown as WireMeal)) as WireMeal;

  // The SAME gate CookSessionView applies (PRD §13.5.4 / §7.13): the sequencer
  // is called only for a genuine multi-dish meal that renders from dish steps.
  // A single-dish meal degrades to naive ordering and must not hit the endpoint
  // — calling it anyway would measure a path the app never takes.
  const isMultiDish =
    meal.dishes.length > 1 && (meal.steps?.length ?? 0) === 0 &&
    meal.dishes.every((d) => (d.steps?.length ?? 0) > 0);

  let seq: CookingSequenceResponse | null = null;
  if (isMultiDish) {
    // No request body — mealId travels in the path (lib/api/cooking.ts).
    seq = await api.cookingSequence(args.mealId, undefined);
  }

  const rawByKey = new Map<string, { dish: WireDish; step: WireStep }>();
  for (const d of meal.dishes) {
    for (const s of d.steps ?? []) rawByKey.set(`${d.dishId}#${s.stepIndex}`, { dish: d, step: s });
  }

  const record: CookStepRecord[] = [];

  if (seq) {
    // THE PHONE'S RENDER — the same client function Cook Mode calls.
    const cookSteps = sequenceMealSteps(meal as never, seq.sequence as never) as {
      key: string;
      text: string;
      phaseType: string;
      estimatedMinutes: number;
      isTimingSensitive: boolean;
      dishTitle?: string;
      cue?: string;
      startOffsetMinutes?: number | null;
    }[];
    const seqIdxByKey = new Map<string, number>();
    for (const e of seq.sequence) {
      seqIdxByKey.set(`${e.dishId}#${e.originalStepIndex}`, e.sequenceIndex);
    }
    cookSteps.forEach((s, i) => {
      const raw = rawByKey.get(s.key);
      const [dishId, idxRaw] = s.key.split("#");
      record.push({
        sequenceIndex: seqIdxByKey.get(s.key) ?? i,
        dishId,
        dishTitle: s.dishTitle ?? raw?.dish.title ?? null,
        originalStepIndex: Number(idxRaw),
        startOffsetMinutes: s.startOffsetMinutes ?? null,
        estimatedMinutes: s.estimatedMinutes,
        phaseType: s.phaseType,
        isTimingSensitive: s.isTimingSensitive,
        parallelGroup: raw?.step.parallelGroup ?? null,
        componentKey: raw?.step.componentKey ?? null,
        pathKey: raw?.step.pathKey ?? null,
        cue: s.cue ?? null,
        text: s.text,
        // §27's defensive append: a held step the sequence did not name.
        appended: !seqIdxByKey.has(s.key),
      });
    });
  } else {
    // Naive order, and NO offsets — which is the truth of this path, not a gap.
    // K-R1/K-R2/K-R3 all key on startOffsetMinutes/cue, so a single-dish meal
    // contributes no candidates to them and the checker's denom says so.
    const flat = meal.dishes.flatMap((d) => (d.steps ?? []).map((s) => ({ d, s })));
    flat.forEach(({ d, s }, i) => {
      record.push({
        sequenceIndex: i,
        dishId: d.dishId,
        dishTitle: meal.dishes.length > 1 ? d.title : null,
        originalStepIndex: s.stepIndex,
        startOffsetMinutes: null,
        estimatedMinutes: s.estimatedMinutes,
        phaseType: s.phaseType,
        isTimingSensitive: s.isTimingSensitive,
        parallelGroup: s.parallelGroup ?? null,
        componentKey: s.componentKey ?? null,
        pathKey: s.pathKey ?? null,
        cue: null,
        text: s.text,
        appended: false,
      });
    });
    if (meal.dishes.length <= 1) {
      gaps.push(
        `${meal.title.slice(0, 40)}: single-dish, so Cook Mode never calls the sequencer ` +
          `(§7.13) — no offsets, no cues, and K-R1/2/3 have no candidates here`,
      );
    }
  }

  // ── the app's own footer expression, verbatim ────────────────────────────
  // app/cook-session.tsx:281 — `remainingMinutesToServe(activeSteps, i) ??
  // remainingMinutes(activeSteps, i)`, at i = 0. Both functions are imported
  // from the phone's module, not reimplemented. This is the cross-check for the
  // number scraped off the screen; where the two disagree, the harness trusts
  // the screen and the report says so.
  const stepsForFooter = record.map((s) => ({
    estimatedMinutes: s.estimatedMinutes,
    startOffsetMinutes: s.startOffsetMinutes,
  }));
  const appFooterMinutes =
    remainingMinutesToServe(stepsForFooter, 0) ?? remainingMinutes(stepsForFooter, 0);
  const serialSumMinutes = remainingMinutes(stepsForFooter, 0);

  return { record, meal, seq, appFooterMinutes, serialSumMinutes };
}

/** The full PlanRecord the prep-cook checker reads as data. */
export async function buildPlanRecord(
  api: Api,
  args: {
    planId: string;
    prepResult: unknown | null;
    prepError: string | null;
    /**
     * mealId → the "~N min left" the Cook Mode footer actually rendered at
     * step 0. THE AUTHORITY for K-R6. A meal missing from this map was not
     * opened in the browser, and its total falls back to the app's own footer
     * expression with that recorded per meal.
     */
    screenTotals?: Map<string, number>;
  },
  gaps: string[],
): Promise<Record<string, unknown>> {
  const { buildPrepWeekModel, buildMealLabelLookup } = await import(
    "../../lib/cooking/prepWeekModel"
  );

  const { plan } = (await api.plan(args.planId)) as PlanResponse;

  const dayByMealId: Record<string, { day: string | null; date: string | null }> = {};
  for (const it of plan.items) {
    if (dayByMealId[it.mealId]) continue; // first slot wins (D-WS7-182)
    dayByMealId[it.mealId] = {
      day: it.assignedDayOfWeek,
      date: it.assignedDate ? String(it.assignedDate).slice(0, 10) : null,
    };
  }

  // ── prep ────────────────────────────────────────────────────────────────
  let prep: Record<string, unknown> | null = null;
  if (args.prepResult) {
    const assembled = args.prepResult as {
      totalEstimatedMinutes: number;
      phases: {
        phase: string;
        title: string;
        steps: {
          stepKey: string;
          number: number;
          title: string;
          instructions: string;
          estimatedMinutes: number;
          storageNote?: string | null;
          skipSuggested?: boolean;
          contributesToMealIds: string[];
        }[];
      }[];
    };

    // THE PHONE'S RENDER — the same two client functions Screen 3 calls.
    const lookup = buildMealLabelLookup(
      plan.items.map((i) => ({
        mealId: i.mealId,
        assignedDayOfWeek: i.assignedDayOfWeek,
        meal: i.meal ? { title: i.meal.title } : null,
      })),
    );
    const vm = buildPrepWeekModel(assembled as never, { mealLabel: lookup }) as {
      totalEstimatedMinutes: number;
      phases: { steps: { stepKey: string }[] }[];
    };
    const renderedKeys = new Set<string>();
    for (const p of vm.phases) for (const s of p.steps) renderedKeys.add(s.stepKey);

    const steps = assembled.phases.flatMap((phase) =>
      phase.steps.map((s) => ({
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
      })),
    );

    prep = {
      totalEstimatedMinutes: assembled.totalEstimatedMinutes,
      renderedTotalMinutes: vm.totalEstimatedMinutes,
      steps,
      // Pre-AI in the census (stepPlan.steps.length); the API never exposes the
      // plan before narration, so this is the assembled count. The checker
      // declares the field and reads it nowhere, so nothing is scored on it.
      plannedStepCount: steps.length,
    };
  }

  // ── cook, one sequence per distinct meal ─────────────────────────────────
  const meals: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const it of plan.items) {
    if (seen.has(it.mealId)) continue;
    seen.add(it.mealId);
    const { record, meal, seq, appFooterMinutes, serialSumMinutes } = await buildCookMeal(
      api,
      {
        mealId: it.mealId,
        planItemId: it.id,
        assignedDayOfWeek: it.assignedDayOfWeek,
        assignedDate: it.assignedDate ? String(it.assignedDate).slice(0, 10) : null,
      },
      gaps,
    );
    // ── WHAT K-R6 IS GIVEN AS "Cook Mode's total" ───────────────────────────
    // The screen's own number when the browser read one; the app's footer
    // expression otherwise. NEVER the serial sum on its own — that is what
    // produced four findings about the instrument in the Part A pass.
    const screen = args.screenTotals?.get(it.mealId);
    const totalForRule = screen ?? appFooterMinutes ?? serialSumMinutes;
    if (screen != null && appFooterMinutes != null && screen !== appFooterMinutes) {
      gaps.push(
        `${meal.title.slice(0, 40)}: the Cook Mode footer rendered ${screen} min but the app's ` +
          `own expression yields ${appFooterMinutes} — the screen is used, and the difference ` +
          `is itself worth a look`,
      );
    }
    meals.push({
      mealId: it.mealId,
      mealTitle: meal.title,
      assignedDayOfWeek: it.assignedDayOfWeek,
      assignedDate: it.assignedDate ? String(it.assignedDate).slice(0, 10) : null,
      // Extra fields the checker declares nowhere and therefore ignores; they
      // exist so the report can show all three numbers side by side.
      qaScreenTotalMinutes: screen ?? null,
      qaAppFooterMinutes: appFooterMinutes,
      qaSerialSumMinutes: serialSumMinutes,
      // The census reads recipeOverrideJson off Prisma to warn where GET
      // /meals/:id and the sequencer disagree (its README's "one deviation").
      // No endpoint exposes it, so the browser lane cannot tell — false, and
      // recorded as a gap once per plan below.
      hasRecipeOverride: false,
      dishCount: meal.dishes.length,
      sequenceTotalMinutes: totalForRule,
      cardTotalMinutes: meal.minutes,
      cardActiveMinutes: meal.activeTimeMinutes ?? null,
      derivedTotalMinutes: null,
      derivedActiveMinutes: null,
      steps: record,
    });
  }

  gaps.push(
    "hasRecipeOverride is always false: MealPlanItem.recipeOverrideJson is not on any " +
      "wire, so the census's warning for meals where GET /meals/:id and the sequencer " +
      "read different steps cannot be reproduced from the browser lane",
  );
  gaps.push(
    "no narration-input file is written, so P-R2 scores 0-of-0 and P-R1 keeps only its " +
      "rendered-text arm — POST /plans/:id/prep-week returns the assembled result, never " +
      "what the narrator was handed",
  );

  return {
    planId: plan.id,
    planName: plan.name,
    startDate: plan.startDate ? String(plan.startDate).slice(0, 10) : null,
    endDate: plan.endDate ? String(plan.endDate).slice(0, 10) : null,
    mealCount: seen.size,
    datedItems: plan.items.filter((i) => !!i.assignedDate).length,
    dayByMealId,
    prep,
    prepError: args.prepError,
    meals,
  };
}
