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

import { Prisma, type PrismaClient } from "@prisma/client";

import { estimateDishMacros } from "./dishMacros";
import { ingredientCanonicalKey, toEffectiveIngredient } from "./overrideResolver";
import { logger } from "./logger";
import { resolveEffectivePreferences } from "./wizardPreferences";
import { runAICall as productionRunAICall } from "./ai/runAICall";
import { composeStoreMealDetails } from "./store/storeMealDetails";
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
  | {
      status: "success";
      expanded: WizardExpandedPlanDetails;
      // BUG-040 — how many store slots were rejected for invalid ingredients
      // (bad catalog data) and fell back to live. 0 on a healthy catalog.
      storeMealsRejected: number;
      // Block 4b-1 (D-WS9-075) — store-hit telemetry. How many slots bound to a
      // catalog meal vs were composed live, so the catalog hit-rate is measurable.
      storeMealsBound: number;
      liveMealsComposed: number;
    }
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

  // Cookbook Phase B Block 2/4 (D-WS7-197, AMENDED by Block 4 / D-WS7-035) —
  // server-authoritative resolution of the generation prefs at expand. Expand
  // is where ingredients and estimatedTimeMinutes are AUTHORED, so sauce
  // sourcing and the cook-time cap must reach the prompt here.
  //
  // Block 2 blindly OVERWROTE these three fields from stored UserPreferences,
  // which silently reverted a legitimate per-run override (e.g. a 30-min cap
  // the user set for THIS plan in the wizard). Block 4 replaces that overwrite
  // with the shared resolver: the per-run override wins when present, else
  // stored. This is NOT "trust the client echo" — the server still resolves
  // and authors the value; it just now accounts for a real per-run override
  // the user set. The override reaches here because the wizard screens re-send
  // it on candidateContext (the user's own input for this run), and the
  // resolver bounds it against stored. Discovery is not re-resolved — it is a
  // generate-only concern (R6). Presence semantics (null cap wins) live in the
  // resolver. Falls back to column defaults when the user has no prefs row.
  const ctx = opts.request.candidateContext;
  const resolved = await resolveEffectivePreferences(opts.prisma, opts.userId, {
    saucePreference: ctx.saucePreference,
    maxCookTimeMinutes: ctx.maxCookTimeMinutes,
    maxCookTimeCoverage: ctx.maxCookTimeCoverage,
  });
  const serverCandidateContext: WizardExpandRequest["candidateContext"] = {
    ...ctx,
    saucePreference: resolved.saucePreference,
    maxCookTimeMinutes: resolved.maxCookTimeMinutes,
    maxCookTimeCoverage: resolved.maxCookTimeCoverage,
  };

  // Plan-Gen Arc Block 2 (D-WS9-038) — store-slot compose. For a slot the AI
  // marked store-filled, read the pool meal's detail (NO AI call) and slot it in
  // with a sourceStoreMealId marker; every unmarked slot is expanded live. A
  // pool meal that can't be read (missing / structurally unusable) falls back to
  // a live expand for that slot (graceful-degrade).
  const storeBySlot = new Map<number, string>();
  for (const s of opts.request.candidate.storeSlots ?? []) {
    storeBySlot.set(s.slotIndex, s.storeMealId);
  }

  const storeComposedBySlot = new Map<
    number,
    WizardExpandEnrichedMealDetails
  >();
  // BUG-040 — count store slots REJECTED for invalid ingredients (bad catalog
  // data) that fell back to live. Distinct from a plain coverage miss; surfaced
  // on the result so a batch of bad seed data is visible, not silent.
  let storeMealsRejected = 0;
  const liveSlots: { slotIndex: number; title: string }[] = [];
  for (let i = 0; i < mealTitles.length; i++) {
    const sid = storeBySlot.get(i);
    if (sid) {
      const composed = await composeStoreMealDetails(opts.prisma, sid);
      if (composed.status === "ok") {
        storeComposedBySlot.set(i, composed.meal);
        continue;
      }
      // Rejected (bad data) or unusable (missing) — both demote this slot to a
      // live expand (D-WS9-037 graceful-degrade). Rejection is counted; the
      // per-meal structured warn was already logged in composeStoreMealDetails.
      if (composed.status === "rejected") storeMealsRejected++;
    }
    liveSlots.push({ slotIndex: i, title: mealTitles[i] });
  }

  // Block 4b-1 (D-WS9-075) — store-hit telemetry. ONE structured line per expand
  // so "how many slots bound to the catalog?" is answerable from logs without
  // guessing (a successful bind was previously silent). `bound` counts slots the
  // AI marked store-filled that read successfully; `rejected` were marked but had
  // bad data and demoted to live; `live` includes both unmarked and demoted slots.
  const storeMealsBound = storeComposedBySlot.size;
  logger.info(
    {
      event: "wizard_store_compose_summary",
      userId: opts.userId,
      candidateId: opts.request.candidate.id,
      totalSlots: mealTitles.length,
      storeMealsBound,
      liveMealsComposed: liveSlots.length,
      storeMealsRejected,
    },
    "Wizard expand store-compose summary",
  );

  // 1. AI-expand the LIVE slots only (store slots already carry full detail).
  const perMealResults = await Promise.all(
    liveSlots.map((s) =>
      expandOneMeal({
        runAICall,
        prisma: opts.prisma,
        userId: opts.userId,
        candidate: opts.request.candidate,
        candidateContext: serverCandidateContext,
        mealTitle: s.title,
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

  // WS9 3d Part 3c-2 (B5) — cost-vs-coverage on ONE line. Joins the coverage
  // counts (already on wizard_store_compose_summary, emitted pre-AI above) with
  // the actual expand AI output tokens, so "did the catalog pay off?" is a single
  // read instead of a timestamp join across the compose-summary and per-call
  // ai_call events. expandOutputTokens is 0 for an all-store plan (zero live
  // slots → zero expand calls). Measurement only — no behavior change.
  const expandOutputTokens = perMealResults.reduce(
    (sum, r) => sum + (r.ok ? r.outputTokens : 0),
    0,
  );
  logger.info(
    {
      event: "wizard_expand_ai_summary",
      userId: opts.userId,
      candidateId: opts.request.candidate.id,
      totalSlots: mealTitles.length,
      storeMealsBound,
      liveMealsComposed: liveSlots.length,
      expandCalls: liveSlots.length,
      expandOutputTokens,
    },
    "Wizard expand AI cost-vs-coverage",
  );

  // Live meals keyed by their REAL slot index (stepless; macros added next).
  const liveMealBySlot = new Map<number, WizardExpandMealDetails>();
  perMealResults.forEach((r, k) => {
    if (!r.ok) {
      throw new Error(`wizard_expand_assemble_invariant: ${r.mealTitle}`);
    }
    liveMealBySlot.set(liveSlots[k].slotIndex, r.meal);
  });

  // 2. Per-dish macros pass over the LIVE dishes only (store dishes carry their
  //    stored per-serving macros already). Flat (slotIndex, dishIdx) work list;
  //    same non-blocking failure semantics as before.
  type DishWork = {
    slotIndex: number;
    dishIdx: number;
    dish: WizardExpandEnrichedMealDetails["dishes"][number];
    servings: number;
  };
  const work: DishWork[] = [];
  for (const { slotIndex } of liveSlots) {
    const meal = liveMealBySlot.get(slotIndex);
    if (!meal) continue;
    for (let di = 0; di < meal.dishes.length; di++) {
      work.push({
        slotIndex,
        dishIdx: di,
        dish: { ...meal.dishes[di], macros: null },
        servings: meal.servings,
      });
    }
  }

  // D-WS9-050 P1.2 — ground the estimator: batch-look-up the persisted
  // Ingredient rows for every ingredient the live dishes mention (read-only,
  // ONE query for the whole expand) so the per-dish estimate can pass
  // nutritionRefPer100g + the conversion identity. Wizard ingredients are
  // AI-generated (unpersisted), so we key on the same canonical form
  // resolveIngredients uses; a brand-new ingredient with no row yet simply
  // isn't in the map and is sent ungrounded (still sent — never dropped).
  const wantedCanon = new Set<string>();
  for (const w of work) {
    for (const ing of w.dish.ingredients) wantedCanon.add(ingredientCanonicalKey(ing.name));
  }
  const ingredientRows =
    wantedCanon.size > 0
      ? await opts.prisma.ingredient.findMany({
          where: { canonicalName: { in: [...wantedCanon] } },
          select: { id: true, canonicalName: true, nutritionRefPerUnit: true, conversionRef: true },
        })
      : [];
  const rowByCanon = new Map(ingredientRows.map((r) => [r.canonicalName, r]));

  const macroResults = await Promise.all(
    work.map(async (w): Promise<WizardExpandEnrichedDishDetails> => {
      const result = await estimateImpl({
        prisma: opts.prisma,
        userId: opts.userId,
        dishTitle: w.dish.title,
        servings: w.servings,
        ingredients: w.dish.ingredients.map((ing) =>
          toEffectiveIngredient(ing, rowByCanon.get(ingredientCanonicalKey(ing.name))),
        ),
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
        return {
          ...w.dish,
          macros: {
            caloriesPerServing: 0,
            proteinGPerServing: 0,
            carbsGPerServing: 0,
            fatGPerServing: 0,
            failed: true,
          },
        };
      }

      return {
        ...w.dish,
        macros: {
          caloriesPerServing: result.perServing.calories,
          proteinGPerServing: result.perServing.proteinG,
          carbsGPerServing: result.perServing.carbsG,
          fatGPerServing: result.perServing.fatG,
          // D-WS9-050 Phase 2 — carry the write-time grounding to activation.
          groundedPct: Math.round(result.grounding.ratio * 100),
        },
      };
    }),
  );

  const macroBySlotDish = new Map<string, WizardExpandEnrichedDishDetails>();
  work.forEach((w, k) =>
    macroBySlotDish.set(`${w.slotIndex}:${w.dishIdx}`, macroResults[k]),
  );

  // 3. Assemble ALL slots in order — store-composed or live-enriched.
  const enrichedMeals: WizardExpandEnrichedMealDetails[] = [];
  for (let i = 0; i < mealTitles.length; i++) {
    const store = storeComposedBySlot.get(i);
    if (store) {
      enrichedMeals.push(store);
      continue;
    }
    const liveMeal = liveMealBySlot.get(i);
    if (!liveMeal) {
      // Unreachable: every non-store slot was expanded live above.
      throw new Error(`wizard_expand_slot_invariant:${i}`);
    }
    enrichedMeals.push({
      ...liveMeal,
      dishes: liveMeal.dishes.map(
        (_, di) =>
          macroBySlotDish.get(`${i}:${di}`) as WizardExpandEnrichedDishDetails,
      ),
    });
  }

  return {
    status: "success",
    storeMealsRejected,
    storeMealsBound,
    liveMealsComposed: liveSlots.length,
    expanded: {
      candidateId: opts.request.candidate.id,
      title: opts.request.candidate.title,
      tags: opts.request.candidate.tags,
      whyBullets: opts.request.candidate.whyBullets,
      // Servings unification (BUG-046 / D-WS9-070 Option 1) — stamp the PER-RUN
      // household onto the draft payload so it survives to materialize. This is
      // the ONLY carrier of the per-run value past expand: candidateContext is
      // discarded after this call, and neither WizardSavePlan nor the instance
      // row otherwise holds it. persistWizardDraft writes `expanded` verbatim
      // into wizardDraftPayload (Json), so this rides along with no migration.
      householdSize: opts.request.candidateContext.householdSize,
      meals: enrichedMeals,
    },
  };
}

// ── per-meal shard helper ────────────────────────────────────────────────

type PerMealResult =
  | {
      ok: true;
      mealTitle: string;
      meal: WizardExpandMealDetails;
      // WS9 3d Part 3c-2 (B5) — carry the model output tokens for this shard so
      // the caller can join AI cost with the live-slot count on one summary line.
      outputTokens: number;
    }
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
  return {
    ok: true,
    mealTitle: opts.mealTitle,
    meal: ai.data.meals[0],
    // WS9 3d Part 3c-2 (B5) — measurement only.
    outputTokens: ai.metadata.outputTokens,
  };
}

// ── persistence (the swappable seam) ──────────────────────────────────────

export interface PersistWizardDraftOptions {
  prisma: PrismaClient;
  userId: string;
  expanded: WizardExpandedPlanDetails;
  // Block 1 (BUG-030) — content-derived idempotency key (see
  // lib/wizardContentHash.ts). Written on the draft row so a later re-expand
  // (or re-activate) of the same candidate reuses this row instead of minting
  // a duplicate. Computed by the route from the candidate's title + meal
  // titles BEFORE the AI expand runs, so an idempotent hit skips the AI call.
  contentHash: string;
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
 *   - wizardDraftPayload: the entire WizardExpandedPlan JSON. Drafts read
 *     back from here in GET /wizard/drafts and the WS7-5b activation path.
 *     (D-WS9-034 moved this off optimizationNotes, which now only ever holds
 *     the prep-notes array on real plans.) No MealPlanItem rows are written at
 *     draft time — materialization is deferred to "Save and use" so the
 *     meal-graph stays clean on sweep.
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
      // Block 1 (BUG-030) — idempotency key; preserved when this row flips to
      // a real plan on activate/save.
      wizardContentHash: opts.contentHash,
      startDate: null,
      endDate: null,
      wizardDraftPayload: opts.expanded as unknown as Prisma.InputJsonValue,
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
// ── supersede-on-consume (Block 1, BUG-030 Part B) ────────────────────────

/**
 * Archive every remaining UNCONSUMED wizard draft for a user. Called right
 * after a successful save/activate (and after an idempotent early-return that
 * returned a pre-existing plan). Two jobs in one write:
 *
 *  1. Sibling supersede — the other candidates the user peeked/expanded in the
 *     same run become moot once they commit to one plan; archiving them clears
 *     the resume interstitial so it can't offer a plan the user already moved
 *     past. In the idempotent-return case it also clears the just-created
 *     orphan draft (the A/B seam flagged in Part A).
 *  2. clear-on-consume — drops the wizard JSON blob from wizardDraftPayload so
 *     no stale draft payload lingers on the row. (Also clears optimizationNotes
 *     for defense against legacy rows that persisted the blob there pre-D-WS9-034.)
 *
 * ARCHIVE, never flip isWizardDraft→false: every isWizardDraft reader treats
 * `true` as "hidden", so a superseded draft (isWizardDraft:true, isArchived:
 * true) is excluded from My Plans / home / this-week / grocery (all filter
 * isWizardDraft:false) AND from the resume list (filters isArchived:false).
 * Flipping to false would surface it as a real plan — the one thing we must
 * not do (Phase 0 constraint).
 *
 * Scope note: 4b-3 (D-WS9-072) moved this off consume onto the GENERATE routes —
 * generating a new batch clears the user's prior unconsumed drafts; committing
 * to a plan clears nothing. With no wizard-session id, "prior batch" resolves to
 * "created strictly before this generation began" via the createdBefore cutoff
 * (BUG-052) — enough to spare a draft the user made mid-stream from THIS batch,
 * while still archiving genuinely stale siblings from earlier runs. A tighter
 * per-session scope would need a session id (deferred).
 *
 * Best-effort: failures are logged and swallowed (the batch is already produced
 * and about to ship; a stray sibling self-heals on the next generation / TTL sweep).
 */
export async function supersedeUnconsumedWizardDrafts(opts: {
  prisma: PrismaClient;
  userId: string;
  // BUG-052 — archive only drafts created strictly BEFORE this generation
  // began. 3c moved expand to card-tap, which can fire mid-stream (the user
  // taps the first candidate as it lands), creating a draft from THIS batch.
  // The end-of-generation supersede must not eat that draft — else the user's
  // Save/Use lands on a draft whose payload it just nulled (→ finalize "root").
  // Omitted → no cutoff (archive all unconsumed — the legacy blanket behavior).
  createdBefore?: Date;
}): Promise<number> {
  try {
    const where: Prisma.MealPlanInstanceWhereInput = {
      userId: opts.userId,
      isWizardDraft: true,
      isArchived: false,
      ...(opts.createdBefore ? { createdAt: { lt: opts.createdBefore } } : {}),
    };
    // Read the ids first so the supersede log can name what it archived (Part D
    // telemetry) — updateMany returns only a count. Best-effort: a concurrent
    // draft created after this read carries createdAt > cutoff, so the same
    // WHERE can't pick it up in the updateMany either.
    const rows = await opts.prisma.mealPlanInstance.findMany({
      where,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    await opts.prisma.mealPlanInstance.updateMany({
      where,
      data: {
        isArchived: true,
        wizardDraftPayload: Prisma.DbNull,
        optimizationNotes: Prisma.DbNull,
      },
    });
    logger.info(
      {
        event: "wizard_draft_supersede",
        userId: opts.userId,
        superseded: ids.length,
        // Cap at 10, matching the unmatchedStoreMealIds telemetry pattern.
        supersededDraftIds: ids.slice(0, 10),
      },
      "Archived sibling wizard drafts on generation",
    );
    return ids.length;
  } catch (err) {
    logger.warn(
      { event: "wizard_draft_supersede_failed", userId: opts.userId, err },
      "Failed to supersede sibling wizard drafts",
    );
    return 0;
  }
}

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
