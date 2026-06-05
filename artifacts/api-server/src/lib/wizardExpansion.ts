// WS7-5a — wizard-candidate expand orchestration.
//
// Branch B (PRD §5.6 redline): "View plan" expands one wizard candidate into
// per-meal recipe detail (ingredients + steps + per-dish macros) and persists
// a HIDDEN MealPlanInstance (isWizardDraft=true, status="draft"). The draft
// is invisible in my_plans / home; reachable only via GET /api/wizard/drafts
// for the WS7-5b "Resume where you left off" prompt; flipped to a normal
// active plan by the WS7-5b "Save and use" path.
//
// Persistence is isolated behind ONE swappable function (persistWizardDraft)
// so a future ephemeral swap (drop the row, lean on a Redis/MemcacheD blob)
// is mechanical: replace the body, leave the call site alone.

import type { Prisma, PrismaClient } from "@prisma/client";

import { estimateDishMacros } from "./dishMacros";
import { logger } from "./logger";
import { runAICall as productionRunAICall } from "./ai/runAICall";
import {
  WizardExpandResultDetailsSchema,
  type WizardExpandMealDetails,
  type WizardExpandRequest,
  type WizardExpandEnrichedDishDetails,
  type WizardExpandEnrichedMealDetails,
  type WizardExpandedPlanDetails,
} from "./ai/schemas/wizard";

// Per-meal max_tokens guardrail. WS7-5c Block A: dropped steps from call #2
// output (the heavy step text moved to call #3 finalize_steps). Ingredients
// + macros + role/title fields fit comfortably under 8k; held at 8k for
// headroom on a multi-dish meal with long ingredient lists. max_tokens does
// not affect output rate-limit accounting, so this carries no rate cost.
const WIZARD_EXPAND_PER_MEAL_MAX_TOKENS = 8192;

// 30-day TTL. The redline ruling: drafts represent the resume window. After
// 30 untouched days the user has either forgotten or moved on; the draft is
// hard-deleted on the next read of GET /api/wizard/drafts (lazy sweep — no
// scheduler infra in the api-server today; see D-WS7-062).
export const WIZARD_DRAFT_TTL_DAYS = 30;
const WIZARD_DRAFT_TTL_MS = WIZARD_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface ExpandCandidateOptions {
  prisma: PrismaClient;
  userId: string;
  request: WizardExpandRequest;
  // DI seams.
  runAICall?: typeof productionRunAICall;
  estimateDishMacrosImpl?: typeof estimateDishMacros;
}

export type ExpandCandidateResult =
  | { status: "success"; expanded: WizardExpandedPlanDetails }
  | {
      status: "ai_failed";
      reason: string;
      userFacingMessage: string;
    };

/**
 * Runs the wizard.candidate.expand AI call, then the per-dish
 * estimateDishMacros loop. Returns the enriched candidate (one full
 * WizardExpandedPlan) ready for persistWizardDraft.
 *
 * AI failure handling matches build-plans: the route returns 502 with the
 * userFacingMessage; activity_failure is the caller's responsibility.
 * Per-dish macro failures are NOT fatal — the dish row is persisted with
 * `macros: null` and the caller may surface a soft caveat.
 */
export async function expandCandidate(
  opts: ExpandCandidateOptions,
): Promise<ExpandCandidateResult> {
  const runAICall = opts.runAICall ?? productionRunAICall;
  const estimateImpl = opts.estimateDishMacrosImpl ?? estimateDishMacros;

  // 1. AI expand — sharded one call per meal title. The pre-shard path was
  //    a single plan-level call on the default 4096 max_tokens; large plans
  //    truncated the tool_use JSON mid-stream and the response failed schema
  //    validation. Per-meal sharding bounds each response well inside the
  //    Sonnet ceiling and the 16k guardrail covers any single-meal blow-up.
  //    Contract is preserved: the assembled meals[] is byte-equivalent to the
  //    pre-shard shape (mealTitles-order; same per-meal schema).
  const mealTitles = opts.request.candidate.mealTitles;
  const perMealResults = await Promise.all(
    mealTitles.map((title) =>
      expandOneMeal({
        runAICall,
        prisma: opts.prisma,
        userId: opts.userId,
        candidate: opts.request.candidate,
        candidateContext: opts.request.candidateContext,
        mealTitle: title,
      }),
    ),
  );

  const firstFailure = perMealResults.find((r) => !r.ok);
  if (firstFailure && !firstFailure.ok) {
    logger.warn(
      {
        event: "wizard_expand_meal_failed",
        userId: opts.userId,
        mealTitle: firstFailure.mealTitle,
        reason: firstFailure.reason,
      },
      "Wizard per-meal expand failed; aborting plan expand",
    );
    return {
      status: "ai_failed",
      reason: `meal_failed:${firstFailure.mealTitle}`,
      userFacingMessage: firstFailure.userFacingMessage,
    };
  }

  const assembledMeals: WizardExpandMealDetails[] = perMealResults.map((r) => {
    if (!r.ok) {
      // Already filtered above; this branch is unreachable but keeps the
      // map() typed without a cast.
      throw new Error(
        `wizard_expand_assemble_invariant: ${r.mealTitle}`,
      );
    }
    return r.meal;
  });

  // 2. Per-dish macros pass. Run in parallel across (meal, dish) pairs —
  //    mirrors planMacros.ts:280-318 (same Promise.all shape, same per-dish
  //    failure semantics: a null macros field is non-blocking, the draft
  //    persists and the user sees a soft caveat downstream).
  type DishWork = {
    mealIdx: number;
    dishIdx: number;
    dish: WizardExpandEnrichedMealDetails["dishes"][number];
    servings: number;
  };
  const work: DishWork[] = [];
  for (let mi = 0; mi < assembledMeals.length; mi++) {
    const meal = assembledMeals[mi];
    for (let di = 0; di < meal.dishes.length; di++) {
      work.push({
        mealIdx: mi,
        dishIdx: di,
        dish: { ...meal.dishes[di], macros: null },
        servings: meal.servings,
      });
    }
  }

  const macroResults = await Promise.all(
    work.map(async (w): Promise<WizardExpandEnrichedDishDetails> => {
      const result = await estimateImpl({
        prisma: opts.prisma,
        userId: opts.userId,
        dishTitle: w.dish.title,
        servings: w.servings,
        ingredients: w.dish.ingredients.map((ing) => ({
          name: ing.name,
          quantity: ing.quantity,
          unit: ing.unit,
          isOptional: ing.isOptional,
        })),
      });

      if (result.status === "failed") {
        logger.warn(
          {
            event: "wizard_expand_dish_macros_failed",
            userId: opts.userId,
            dishTitle: w.dish.title,
            error: result.error,
          },
          "Per-dish macro estimate failed during wizard expand",
        );
        return { ...w.dish, macros: { caloriesPerServing: 0, proteinGPerServing: 0, carbsGPerServing: 0, fatGPerServing: 0, failed: true } };
      }

      return {
        ...w.dish,
        macros: {
          caloriesPerServing: result.perServing.calories,
          proteinGPerServing: result.perServing.proteinG,
          carbsGPerServing: result.perServing.carbsG,
          fatGPerServing: result.perServing.fatG,
        },
      };
    }),
  );

  // 3. Re-assemble macros back into the meal/dish tree.
  const enrichedMeals: WizardExpandEnrichedMealDetails[] = assembledMeals.map(
    (meal, mi) => ({
      ...meal,
      dishes: meal.dishes.map((_, di) => {
        // The work[] index for (mi, di) is the count of preceding dishes.
        let k = 0;
        for (let p = 0; p < mi; p++) k += assembledMeals[p].dishes.length;
        return macroResults[k + di];
      }),
    }),
  );

  return {
    status: "success",
    expanded: {
      candidateId: opts.request.candidate.id,
      title: opts.request.candidate.title,
      tags: opts.request.candidate.tags,
      whyBullets: opts.request.candidate.whyBullets,
      meals: enrichedMeals,
    },
  };
}

// ── per-meal shard helper ────────────────────────────────────────────────

type PerMealResult =
  | { ok: true; mealTitle: string; meal: WizardExpandMealDetails }
  | {
      ok: false;
      mealTitle: string;
      reason: string;
      userFacingMessage: string;
    };

interface ExpandOneMealOptions {
  runAICall: typeof productionRunAICall;
  prisma: PrismaClient;
  userId: string;
  candidate: WizardExpandRequest["candidate"];
  candidateContext: WizardExpandRequest["candidateContext"];
  mealTitle: string;
}

/**
 * Expand ONE meal title via the existing `wizard.candidate.expand` prompt.
 *
 * The prompt + schema are unchanged from the unsharded path; we just trim
 * `candidate.mealTitles` to the single title we want this shard to expand
 * and unwrap `meals[0]` from the response. The full candidate context
 * (title, tags, whyBullets, dailyMacros) is still passed so constraint
 * carry-over from build-plans is preserved.
 *
 * Retry semantics: relies SOLELY on runAICall's built-in retry
 * (`retryOnValidationFailure: true` → up to 2 attempts). No meal-level
 * retry wrapper — that would compound to up to 4 Sonnet attempts on a
 * doomed meal, and the built-in 2 attempts already match the retry depth
 * the original single-call (pre-shard) expand had. If runAICall fails for
 * a meal, that meal fails; the caller then fails the whole expand —
 * all-or-nothing because the draft write requires a complete plan.
 */
async function expandOneMeal(
  opts: ExpandOneMealOptions,
): Promise<PerMealResult> {
  const perMealRequest: WizardExpandRequest = {
    candidate: { ...opts.candidate, mealTitles: [opts.mealTitle] },
    candidateContext: opts.candidateContext,
  };
  const ai = await opts.runAICall(
    "wizard.candidate.expand",
    { expandInput: perMealRequest },
    WizardExpandResultDetailsSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      maxTokens: WIZARD_EXPAND_PER_MEAL_MAX_TOKENS,
    },
  );

  if (!ai.success) {
    return {
      ok: false,
      mealTitle: opts.mealTitle,
      reason: ai.reason,
      userFacingMessage: ai.userFacingMessage,
    };
  }
  if (ai.data.meals.length === 0) {
    // Defensive: schema enforces .min(1) so this branch is unreachable today.
    return {
      ok: false,
      mealTitle: opts.mealTitle,
      reason: "validation_failed",
      userFacingMessage: "Kiwi got distracted. Try again?",
    };
  }
  return { ok: true, mealTitle: opts.mealTitle, meal: ai.data.meals[0] };
}

// ── persistence (the swappable seam) ──────────────────────────────────────

export interface PersistWizardDraftOptions {
  prisma: PrismaClient;
  userId: string;
  expanded: WizardExpandedPlanDetails;
}

export interface WizardDraftPersistedRef {
  planId: string;
  createdAt: Date;
}

/**
 * Writes the expanded plan as a hidden draft MealPlanInstance. ONE swappable
 * persistence function — replace the body to swap to ephemeral (Redis,
 * Memcached, etc.) without touching the call site.
 *
 * Persisted row shape:
 *   - isWizardDraft: true (the my_plans / home / activeThisWeek exclusion
 *     discriminator; see planQueries.ts).
 *   - status: "draft" (PlanStatus.draft; aligns with PRD §5.6 redline intent
 *     even though existing flows also write this value — see Phase 3 report
 *     §3 for the discriminator decision).
 *   - isActiveThisWeek: false (drafts are never "this week" until activated).
 *   - mealPlanTemplateId: null (no template; this is a fresh wizard candidate).
 *   - titleOverride: the candidate's display title.
 *   - optimizationNotes: the entire WizardExpandedPlan JSON. Drafts read
 *     back from here in GET /wizard/drafts and the WS7-5b activation path.
 *     No MealPlanItem rows are written at draft time — materialization is
 *     deferred to "Save and use" so the meal-graph stays clean on sweep.
 */
export async function persistWizardDraft(
  opts: PersistWizardDraftOptions,
): Promise<WizardDraftPersistedRef> {
  const created = await opts.prisma.mealPlanInstance.create({
    data: {
      userId: opts.userId,
      mealPlanTemplateId: null,
      titleOverride: opts.expanded.title,
      status: "draft",
      // WS7-6 (E): isActiveThisWeek column dropped — wizard drafts are
      // null-dated and the date-range predicate already treats them as
      // not-current. Null-exempt from the EXCLUDE constraint.
      isWizardDraft: true,
      startDate: null,
      endDate: null,
      optimizationNotes: opts.expanded as unknown as Prisma.InputJsonValue,
      breakfastOverrides: null,
      lunchOverrides: null,
    },
    select: { id: true, createdAt: true },
  });

  return { planId: created.id, createdAt: created.createdAt };
}

// ── lazy sweep (read-path TTL enforcement) ────────────────────────────────

/**
 * Hard-deletes wizard drafts older than WIZARD_DRAFT_TTL_DAYS for the given
 * user. Called from GET /api/wizard/drafts before returning the live list —
 * lazy because there's no scheduler in the api-server today (D-WS7-062).
 *
 * Returns the number of rows deleted (mostly for logging / tests). Failures
 * are logged and swallowed; the caller's read path proceeds with whatever
 * survived (or the now-empty set).
 */
export async function sweepStaleWizardDrafts(opts: {
  prisma: PrismaClient;
  userId: string;
  now?: Date;
}): Promise<number> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - WIZARD_DRAFT_TTL_MS);
  try {
    const result = await opts.prisma.mealPlanInstance.deleteMany({
      where: {
        userId: opts.userId,
        isWizardDraft: true,
        createdAt: { lt: cutoff },
      },
    });
    if (result.count > 0) {
      logger.info(
        {
          event: "wizard_draft_lazy_sweep",
          userId: opts.userId,
          deleted: result.count,
          ttlDays: WIZARD_DRAFT_TTL_DAYS,
        },
        "Swept stale wizard drafts on read",
      );
    }
    return result.count;
  } catch (err) {
    logger.warn(
      { event: "wizard_draft_lazy_sweep_failed", userId: opts.userId, err },
      "Failed to sweep stale wizard drafts",
    );
    return 0;
  }
}
