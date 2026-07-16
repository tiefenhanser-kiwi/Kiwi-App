// POST /api/wizard/build-plans — Set Preferences wizard plan generation.
// Per kiwi_ws6_plan.md §3 6a-3 + PRD §5.7 + §5.8.
//
// Auth: requireAuth (JWT). Rate-limit: per-user token-bucket (8 burst,
// ~1/7.5s) — same pattern as the legacy plans/generate route, keyed by
// userId so authenticated users don't collide on a shared IP.
//
// Request body shape: WizardInput minus hiddenContext (server injects).
// Response shape: WizardPlanCandidatesResultSchema (validated by tool_use).
//
// Factory pattern: createWizardRouter(deps?) lets tests inject stubs for
// runAICall / prisma / subscriptionService without standing up the full
// stack. Default export wires the production singletons.

import { Router, type IRouter, type Request } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";

import { runAICall as productionRunAICall } from "../lib/ai/runAICall";
import {
  WizardExpandRequestSchema,
  WizardExpandedPlanDetailsSchema,
  WizardInputSchema,
  WizardPlanCandidatesResultSchema,
  type WizardInput,
} from "../lib/ai/schemas/wizard";
import {
  DirectedInputSchema,
  ParsedIntentSchema,
  type ParsedIntent,
} from "../lib/ai/schemas/tellKiwi";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import {
  subscriptionService as productionSubscriptionService,
  type SubscriptionService,
} from "../lib/subscriptionService";
import { emitActivity as productionEmitActivity } from "../lib/userActivity";
import { markFirstPlanCreated } from "../lib/firstPlan";
import {
  materializeWizardDraft as productionMaterializeWizardDraft,
  WizardDraftMalformedError,
  WizardDraftNotFoundError,
} from "../lib/wizardActivation";
import {
  expandCandidate as productionExpandCandidate,
  persistWizardDraft as productionPersistWizardDraft,
  sweepStaleWizardDrafts as productionSweepStaleWizardDrafts,
  supersedeUnconsumedWizardDrafts as productionSupersedeUnconsumedWizardDrafts,
  WIZARD_DRAFT_TTL_DAYS,
} from "../lib/wizardExpansion";
import { readAndFinalizeWizardDraft as productionReadAndFinalizeWizardDraft } from "../lib/wizardFinalize";
import { computeWizardContentHash } from "../lib/wizardContentHash";
import { currentWeekRange } from "../lib/planDates";
import {
  buildPlanningContext,
  type PlanningContext,
} from "../lib/planningContext";
import {
  resolveEffectivePreferences,
  type ResolvedPreferences,
} from "../lib/wizardPreferences";
import { requireAuth } from "../middleware/auth";

// Cookbook Phase B Block 2 — the generation-shaping slice of the user's stored
// UserPreferences, attached to the generate input as `preferencesContext`
// (never to parseInput). Values mirror the schema.prisma column types;
// maxCookTimeMinutes is null when the user has set no cap.
//
// Block 4 (D-WS7-035) — the bag is now the RESOLVED (client-override ?? stored)
// value, computed by the shared resolveEffectivePreferences() so generate and
// expand agree. Type aliased to ResolvedPreferences (same shape).
type PreferencesContext = ResolvedPreferences;

export interface WizardRouterDeps {
  runAICall: typeof productionRunAICall;
  prisma: PrismaClient;
  subscriptionService: SubscriptionService;
  // Override the rate limiter for tests that want to exercise burst behavior
  // or skip throttling entirely.
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
  // WS7-5a test seams. expandCandidate fans out to runAICall + per-dish
  // estimateDishMacros; tests inject a stub so the route layer can be
  // exercised without a real AI call. persistWizardDraft is the swappable
  // persistence function; tests can capture writes without hitting Prisma.
  expandCandidate?: typeof productionExpandCandidate;
  persistWizardDraft?: typeof productionPersistWizardDraft;
  sweepStaleWizardDrafts?: typeof productionSweepStaleWizardDrafts;
  // Block 1 (BUG-030 Part B) — supersede seam. Archives sibling unconsumed
  // drafts after a save/activate. Swappable so route tests can assert it fires
  // with the right userId without exercising a real updateMany.
  supersedeUnconsumedWizardDrafts?: typeof productionSupersedeUnconsumedWizardDrafts;
  // WS7-5b-server seams. materializeWizardDraft lets tests assert the route
  // wiring (auth, ownership 404, transaction shape, activity emission)
  // without standing up the full meal-graph write path. emitActivity is
  // swappable so the activation route can be exercised with a recording
  // stub without needing the shared userActivity helper's real Prisma write.
  materializeWizardDraft?: typeof productionMaterializeWizardDraft;
  emitActivity?: typeof productionEmitActivity;
  // WS7-5c Block A — finalize-steps seam. The three-stage wizard's call #3
  // runs BEFORE the activate/save $transaction (kept off the tx because
  // its Sonnet call would blow the 60s tx budget). Tests stub this to
  // return a synthetic merged payload without needing a real AI call.
  readAndFinalizeWizardDraft?: typeof productionReadAndFinalizeWizardDraft;
}

export function createWizardRouter(
  deps: Partial<WizardRouterDeps> = {},
): IRouter {
  const runAICall = deps.runAICall ?? productionRunAICall;
  const prisma = deps.prisma ?? productionPrisma;
  const subscriptionService =
    deps.subscriptionService ?? productionSubscriptionService;
  const expandCandidate = deps.expandCandidate ?? productionExpandCandidate;
  const persistWizardDraft =
    deps.persistWizardDraft ?? productionPersistWizardDraft;
  const sweepStaleWizardDrafts =
    deps.sweepStaleWizardDrafts ?? productionSweepStaleWizardDrafts;
  const supersedeUnconsumedWizardDrafts =
    deps.supersedeUnconsumedWizardDrafts ??
    productionSupersedeUnconsumedWizardDrafts;
  const materializeWizardDraftImpl =
    deps.materializeWizardDraft ?? productionMaterializeWizardDraft;
  const emitSharedActivity = deps.emitActivity ?? productionEmitActivity;
  const readAndFinalizeWizardDraftImpl =
    deps.readAndFinalizeWizardDraft ?? productionReadAndFinalizeWizardDraft;
  const limiterOpts = deps.rateLimiterOpts ?? {
    capacity: 8,
    refillPerSec: 8 / 60,
  };

  // ── system settings cache (per-router instance) ──────────────────────

  interface CachedSetting<T> {
    value: T;
    expiresAt: number;
  }
  const settingsCacheMs = 60_000;
  let candidateCountCache: CachedSetting<number> | null = null;
  let maxRefreshesCache: CachedSetting<number> | null = null;

  async function readNumberSetting(
    key: string,
    fallback: number,
  ): Promise<number> {
    try {
      const row = await prisma.systemSetting.findUnique({ where: { key } });
      if (row && typeof row.value === "number" && Number.isFinite(row.value)) {
        return row.value;
      }
      if (row && typeof row.value === "string") {
        const n = Number(row.value);
        if (Number.isFinite(n)) return n;
      }
      return fallback;
    } catch (err) {
      logger.warn(
        { event: "system_setting_read", key, err },
        "Falling back to default",
      );
      return fallback;
    }
  }

  async function getCandidateCount(): Promise<number> {
    if (candidateCountCache && candidateCountCache.expiresAt > Date.now()) {
      return candidateCountCache.value;
    }
    const value = await readNumberSetting("wizard.candidate_count", 3);
    candidateCountCache = { value, expiresAt: Date.now() + settingsCacheMs };
    return value;
  }

  async function getMaxRefreshes(): Promise<number> {
    if (maxRefreshesCache && maxRefreshesCache.expiresAt > Date.now()) {
      return maxRefreshesCache.value;
    }
    const value = await readNumberSetting(
      "wizard.max_refreshes_per_session",
      3,
    );
    maxRefreshesCache = { value, expiresAt: Date.now() + settingsCacheMs };
    return value;
  }

  // ── activity events (PRD §5.10) ──────────────────────────────────────

  async function emitActivity(
    userId: string,
    eventType:
      | "wizard_complete"
      | "wizard_start"
      | "wizard_failure"
      | "wizard_candidate_expanded",
    entityId?: string,
  ): Promise<void> {
    try {
      await prisma.userActivity.create({
        data: {
          userId,
          eventType,
          entityId: entityId ?? null,
          platform: "api",
        },
      });
    } catch (err) {
      logger.warn(
        { event: "activity_emit", userId, eventType, err },
        "Failed to emit activity",
      );
    }
  }

  // ── server-injected hidden context ───────────────────────────────────

  async function buildHiddenContext(
    userId: string,
  ): Promise<WizardInput["hiddenContext"]> {
    const [preferences, pantryStaples, recentMeals] = await Promise.all([
      prisma.userPreferences.findUnique({
        where: { userId },
        select: {
          cookingEquipment: true,
          spiceTolerance: true,
          budgetLevel: true,
          pickyAvoidances: true,
          recurringGroceryItems: true,
        },
      }),
      prisma.pantryStaple.findMany({
        where: { userId, isActive: true },
        select: { ingredientName: true },
      }),
      prisma.userActivity.findMany({
        where: { userId, eventType: "cook_meal", entityType: "meal" },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { entityId: true },
      }),
    ]);

    // Boundary map: DB columns (cookingEquipment / recurringGroceryItems) ->
    // AI hidden-context keys (equipment / recurringItems). AI schema names are
    // preserved to avoid a prompt-version bump in Block A.
    return {
      equipment: preferences?.cookingEquipment ?? [],
      spiceTolerance: preferences?.spiceTolerance ?? undefined,
      budgetLevel: preferences?.budgetLevel ?? undefined,
      pickyAvoidances: preferences?.pickyAvoidances ?? [],
      recurringItems: preferences?.recurringGroceryItems ?? [],
      pantryStaples: pantryStaples.map((p) => p.ingredientName),
      recentMealIds: recentMeals
        .map((a) => a.entityId)
        .filter((id): id is string => !!id),
    };
  }

  // ── server-injected generation-preferences context (Cookbook Phase B) ─
  // The four stored UserPreferences that shape GENERATION — discovery novelty,
  // sauce sourcing, and the cook-time cap — ride alongside planningContext on
  // the generate input as `preferencesContext`. Attached to the GENERATE input
  // ONLY and deliberately withheld from the Haiku parse_intent classifier.
  //
  // Block 4 (D-WS7-035): the values are RESOLVED (per-run client override ??
  // stored) via the shared resolveEffectivePreferences() helper — see
  // lib/wizardPreferences.ts. The per-run overrides arrive on the request body
  // (validated as optional-no-default fields on the input schema) and are
  // resolved against stored UserPreferences here.

  // ── BUG-030 idempotency helper ───────────────────────────────────────
  // Given the draft being activated/saved, return the {id, revisionId} of a
  // pre-existing materialized (non-draft) plan carrying the SAME content hash
  // for this user — i.e. a prior activation/save of the same candidate.
  // Returns null on the first activation, or when the draft has no hash
  // (legacy row) or isn't owned. Scoped to isArchived:false so a user who
  // deleted their plan can re-create it.
  async function findExistingPlanForDraft(
    draftId: string,
    userId: string,
  ): Promise<{ id: string; revisionId: number } | null> {
    const draftMeta = await prisma.mealPlanInstance.findUnique({
      where: { id: draftId },
      select: { userId: true, wizardContentHash: true },
    });
    if (
      !draftMeta ||
      draftMeta.userId !== userId ||
      !draftMeta.wizardContentHash
    ) {
      return null;
    }
    return prisma.mealPlanInstance.findFirst({
      where: {
        userId,
        isWizardDraft: false,
        isArchived: false,
        wizardContentHash: draftMeta.wizardContentHash,
        id: { not: draftId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, revisionId: true },
    });
  }

  // ── route ────────────────────────────────────────────────────────────

  const router: IRouter = Router();

  const wizardLimiter = rateLimit({
    ...limiterOpts,
    keyFn: (req: Request) => req.userId ?? "anonymous",
  });

  router.post(
    "/wizard/build-plans",
    requireAuth,
    wizardLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      // 1. Validate the input.
      const parsed = WizardInputSchema.omit({ hiddenContext: true }).safeParse(
        req.body,
      );
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid request body",
          details: parsed.error.flatten(),
        });
      }

      // 2. Entitlement check.
      const ent = await subscriptionService.can(
        userId,
        "kitchen_wizard_set_preferences",
      );
      if (!ent.allowed) {
        return res.status(402).json({
          error: "upgrade required",
          reason: ent.reason ?? "Kitchen Wizard is a premium feature.",
        });
      }

      // 3. Read SystemSetting tunables.
      const candidateCount = await getCandidateCount();

      // 4. Inject hidden context from the user's profile.
      const hiddenContext = await buildHiddenContext(userId);
      // Cookbook Phase A — planning context (season / upcoming events / recent
      // history) rides alongside hiddenContext on the generate input. The prompt
      // body doesn't reference these keys yet (Block 2 does the wording), so the
      // extra JSON is inert until then. NOT added to buildHiddenContext because
      // that feed also powers the cheap Haiku parse_intent call.
      const planningContext = await buildPlanningContext(prisma, userId);
      // Cookbook Phase B Block 2/4 — generation-shaping prefs (discovery /
      // sauce / cook-time cap) ride alongside planningContext on the generate
      // input. The four per-run override fields are peeled OFF parsed.data (so
      // they don't leak into the AI input at top level — the prompt reads them
      // only via preferencesContext) and resolved against stored prefs.
      const {
        discoveryMealsPerWeek,
        saucePreference,
        maxCookTimeMinutes,
        maxCookTimeCoverage,
        ...aiInput
      } = parsed.data;
      const preferencesContext = await resolveEffectivePreferences(
        prisma,
        userId,
        {
          discoveryMealsPerWeek,
          saucePreference,
          maxCookTimeMinutes,
          maxCookTimeCoverage,
        },
      );
      const wizardInput: WizardInput & {
        planningContext: PlanningContext;
        preferencesContext: PreferencesContext;
      } = {
        ...aiInput,
        hiddenContext,
        planningContext,
        preferencesContext,
      };

      // 5. Run the AI call.
      const result = await runAICall(
        "wizard.set_preferences.generate",
        { wizardInput },
        WizardPlanCandidatesResultSchema,
        { prisma, userId },
      );

      if (!result.success) {
        logger.warn(
          {
            event: "wizard_build_plans_failed",
            userId,
            reason: result.reason,
            promptKey: "wizard.set_preferences.generate",
          },
          "Wizard plan generation failed",
        );
        // PRD §5.10 — record the failure so cost/observability and admin
        // funnels can see real failure rates. Same fire-and-forget pattern
        // as wizard_complete: never let activity-write failures bubble up.
        await emitActivity(userId, "wizard_failure");
        return res.status(502).json({
          error: result.userFacingMessage,
          reason: result.reason,
        });
      }

      // 6. Trim candidates defensively to the configured count.
      const candidates = result.data.candidates.slice(0, candidateCount);
      const response = {
        candidates,
        cannotGenerateMore: result.data.cannotGenerateMore,
        reason: result.data.reason,
        metadata: {
          promptVersion: result.metadata.promptVersion,
          latencyMs: result.metadata.latencyMs,
        },
      };

      // 7. Activity event.
      await emitActivity(userId, "wizard_complete");

      return res.json(response);
    },
  );

  // ── POST /wizard/build-from-text — Tell Kiwi two-step pipeline ───────
  // Per kiwi_ws6_plan.md §3 6a-4 + PRD §6.5/§6.8.
  //
  // 1. Parse intent (Haiku, text+Zod, cheap).
  // 2. Branch on parsedIntent.scenario:
  //    - 'unclear' → return { candidates: [], parsedIntent } — no step 2 call,
  //      saves ~$0.01 per request and a few seconds of latency. Mobile shows
  //      the clarification UI from parsedIntent.needsClarification.
  //    - else → call step 2 (Sonnet, tool_use, expensive).
  // 3. Step 2 call gets parsedIntent + userInput + hiddenContext + plan
  //    parameters. AI returns 1-3 candidates per the prompt's scenario rules.
  // 4. Forward needsClarification through to mobile if present.
  //
  // Both AI calls write their own LLMCallLog rows via runAICall.
  // wizard_complete fires once per successful Tell Kiwi request (with metadata
  // distinguishing flow=tellkiwi); wizard_failure fires if EITHER call fails.

  // Same per-user token-bucket pattern as build-plans, but a separate bucket.
  // Tell Kiwi may be used more often than the full Set-Prefs wizard, so we
  // don't want a shared bucket to starve either flow.
  const tellKiwiLimiter = rateLimit({
    ...limiterOpts,
    keyFn: (req: Request) => `tellkiwi:${req.userId ?? "anonymous"}`,
  });

  router.post(
    "/wizard/build-from-text",
    requireAuth,
    tellKiwiLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      // 1. Validate body. The DirectedInputSchema covers the user's
      //    free-text + soft prefs from the Tell Kiwi form. The route
      //    itself reads planDurationDays from the request body too,
      //    falling back to 5 (the wizard default) if not provided.
      const parsed = DirectedInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const directed = parsed.data;
      const planDurationDays =
        typeof req.body?.planDurationDays === "number" &&
        req.body.planDurationDays >= 1 &&
        req.body.planDurationDays <= 7
          ? (req.body.planDurationDays as number)
          : 5;

      // 2. Entitlement check (PRD §6.4 — Tell Kiwi is its own entitlement).
      const ent = await subscriptionService.can(
        userId,
        "kitchen_wizard_just_say",
      );
      if (!ent.allowed) {
        return res.status(402).json({
          error: "upgrade required",
          reason: ent.reason ?? "Tell Kiwi is a premium feature.",
        });
      }

      // 3. Read SystemSetting tunables (same dial as build-plans for
      //    candidate count; Tell Kiwi may return fewer per scenario).
      const candidateCount = await getCandidateCount();

      // 4. Inject hidden context from the user's profile.
      const hiddenContext = await buildHiddenContext(userId);

      // 5. Step 1 — parse intent.
      const parseInput = {
        userInput: directed.description,
        planDurationDays,
        householdSize: directed.householdSize,
        wantsLeftovers: directed.wantsLeftovers,
        eatingStyles: directed.eatingStyles,
        allergiesAndAvoidances: directed.allergiesAndAvoidances,
        dietaryNotes: directed.dietaryNotes ?? "",
        // Hidden context is informational at parse time too — helps the
        // parser apply unclear-clarifications that respect dietary state.
        hiddenContext,
      };

      const parseResult = await runAICall(
        "wizard.directed.parse_intent",
        { parseInput },
        ParsedIntentSchema,
        { prisma, userId },
      );

      if (!parseResult.success) {
        logger.warn(
          {
            event: "tellkiwi_parse_failed",
            userId,
            reason: parseResult.reason,
            promptKey: "wizard.directed.parse_intent",
          },
          "Tell Kiwi parse step failed",
        );
        await emitActivity(userId, "wizard_failure");
        return res.status(502).json({
          error: parseResult.userFacingMessage,
          reason: parseResult.reason,
        });
      }

      const parsedIntent: ParsedIntent = parseResult.data;

      // 6. Branch on scenario. `unclear` short-circuits without firing the
      //    expensive Sonnet call — mobile renders the clarification UI from
      //    parsedIntent.needsClarification.reason.
      if (parsedIntent.scenario === "unclear") {
        // wizard_complete still fires — the user got a useful response (a
        // clarifying question), even though no plan was generated. That keeps
        // the funnel metric consistent and matches the PRD §6.10 intent.
        await emitActivity(userId, "wizard_complete");
        return res.json({
          candidates: [],
          parsedIntent,
          needsClarification: parsedIntent.needsClarification,
          metadata: {
            promptVersion: parseResult.metadata.promptVersion,
            latencyMs: parseResult.metadata.latencyMs,
            flow: "tellkiwi",
          },
        });
      }

      // 7. Step 2 — generate plan(s). Reuses the wizard-shape result
      //    schema. The prompt is responsible for honoring scenario rules
      //    (1 candidate for fully_specified/overflow, 3 for vague/partial,
      //    explicitMeals locked into every candidate for partial).
      // Cookbook Phase A — planning context is added to the GENERATE input only.
      // parseInput above deliberately does NOT get it, keeping the Haiku
      // classifier's token count flat. Computed here (after the `unclear`
      // short-circuit) so the DB reads are skipped when no plan is generated.
      const planningContext = await buildPlanningContext(prisma, userId);
      // Cookbook Phase B Block 2/4 — generation-shaping prefs attached to the
      // GENERATE input only (parseInput above deliberately does not get it).
      // Per-run overrides on the directed body are resolved against stored.
      const preferencesContext = await resolveEffectivePreferences(
        prisma,
        userId,
        {
          discoveryMealsPerWeek: directed.discoveryMealsPerWeek,
          saucePreference: directed.saucePreference,
          maxCookTimeMinutes: directed.maxCookTimeMinutes,
          maxCookTimeCoverage: directed.maxCookTimeCoverage,
        },
      );
      const generateInput = {
        parsedIntent,
        userInput: directed.description,
        planDurationDays,
        householdSize: directed.householdSize,
        wantsLeftovers: directed.wantsLeftovers,
        // Block 4 (Ruling 3) — cuisines + weeklyPacing now flow to the directed
        // generate prompt (activates its "# Cuisine guidance" section).
        cuisines: directed.cuisines,
        weeklyPacing: directed.weeklyPacing,
        eatingStyles: directed.eatingStyles,
        allergiesAndAvoidances: directed.allergiesAndAvoidances,
        dietaryNotes: directed.dietaryNotes ?? "",
        hiddenContext,
        planningContext,
        preferencesContext,
      };

      const genResult = await runAICall(
        "wizard.directed.generate",
        { generateInput },
        WizardPlanCandidatesResultSchema,
        { prisma, userId },
      );

      if (!genResult.success) {
        logger.warn(
          {
            event: "tellkiwi_generate_failed",
            userId,
            reason: genResult.reason,
            promptKey: "wizard.directed.generate",
          },
          "Tell Kiwi generate step failed",
        );
        await emitActivity(userId, "wizard_failure");
        return res.status(502).json({
          error: genResult.userFacingMessage,
          reason: genResult.reason,
        });
      }

      // 8. Trim candidates defensively.
      //    fully_specified + overflow scenarios produce exactly 1 candidate
      //    by prompt design — but if the AI returns more, slice to 1 to
      //    keep the UI invariant clean. vague/partial honor candidateCount.
      const expected =
        parsedIntent.scenario === "fully_specified" ||
        parsedIntent.scenario === "overflow"
          ? 1
          : candidateCount;
      const candidates = genResult.data.candidates.slice(0, expected);

      // 9. Carry needsClarification through. For overflow the parser populates
      //    options with the dropped meals; mobile renders them as swap chips.
      const response = {
        candidates,
        parsedIntent,
        needsClarification:
          parsedIntent.needsClarification ?? undefined,
        cannotGenerateMore: genResult.data.cannotGenerateMore,
        reason: genResult.data.reason,
        metadata: {
          promptVersion: genResult.metadata.promptVersion,
          latencyMs:
            parseResult.metadata.latencyMs + genResult.metadata.latencyMs,
          flow: "tellkiwi",
        },
      };

      await emitActivity(userId, "wizard_complete");

      return res.json(response);
    },
  );

  // ── POST /wizard/surprise-me — WS9 3c §7.6 Surprise-me path ───────────
  // Zero-input generation: the user tapped "Surprise me" and typed nothing.
  // We read their stored preferences server-side and run a SINGLE generate
  // call (wizard.surprise.generate) that produces crowd-pleaser candidates
  // strictly inside their hard constraints. No parse step (nothing to parse),
  // so this is CHEAPER than Tell Kiwi. The response mirrors build-from-text's
  // shape (candidates + a synthetic `vague` parsedIntent) so wizard-results
  // renders it through the Tell Kiwi branch and R5's "Use this plan" applies.
  router.post(
    "/wizard/surprise-me",
    requireAuth,
    tellKiwiLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      // 1. Entitlement — Surprise-me rides the Tell Kiwi ("just say") lane.
      const ent = await subscriptionService.can(
        userId,
        "kitchen_wizard_just_say",
      );
      if (!ent.allowed) {
        return res.status(402).json({
          error: "upgrade required",
          reason: ent.reason ?? "Surprise me is a premium feature.",
        });
      }

      // 2. Load the stored preferences that shape the plan. Unlike Tell Kiwi /
      //    build-plans, there is no request body — stored prefs ARE the input.
      //    Allergies/eatingStyles/pickyAvoidances become the hard constraints
      //    the prompt must never violate.
      const storedPrefs = await prisma.userPreferences.findUnique({
        where: { userId },
        select: {
          planLengthDefault: true,
          householdSize: true,
          cuisines: true,
          eatingStyles: true,
          allergiesAndAvoidances: true,
          dietaryNotes: true,
          weeklyPacingDefault: true,
          wantsLeftovers: true,
        },
      });

      const planDurationDays = (() => {
        const n = storedPrefs?.planLengthDefault ?? 5;
        return n >= 1 && n <= 7 ? n : 5;
      })();

      // 3. Same server-injected context bags as the directed generate path.
      const candidateCount = await getCandidateCount();
      const hiddenContext = await buildHiddenContext(userId);
      const planningContext = await buildPlanningContext(prisma, userId);
      const preferencesContext = await resolveEffectivePreferences(
        prisma,
        userId,
      );

      const generateInput = {
        planDurationDays,
        householdSize: storedPrefs?.householdSize ?? 4,
        wantsLeftovers: storedPrefs?.wantsLeftovers ?? false,
        cuisines: storedPrefs?.cuisines ?? [],
        weeklyPacing: storedPrefs?.weeklyPacingDefault ?? "mostly_easy",
        eatingStyles: storedPrefs?.eatingStyles ?? [],
        allergiesAndAvoidances: storedPrefs?.allergiesAndAvoidances ?? [],
        dietaryNotes: storedPrefs?.dietaryNotes ?? "",
        hiddenContext,
        planningContext,
        preferencesContext,
      };

      const genResult = await runAICall(
        "wizard.surprise.generate",
        { generateInput },
        WizardPlanCandidatesResultSchema,
        { prisma, userId },
      );

      if (!genResult.success) {
        logger.warn(
          {
            event: "surprise_generate_failed",
            userId,
            reason: genResult.reason,
            promptKey: "wizard.surprise.generate",
          },
          "Surprise-me generate step failed",
        );
        await emitActivity(userId, "wizard_failure");
        return res.status(502).json({
          error: genResult.userFacingMessage,
          reason: genResult.reason,
        });
      }

      const candidates = genResult.data.candidates.slice(0, candidateCount);

      // Synthesize a `vague` parsedIntent so the mobile wizard-results screen
      // renders this through its existing Tell Kiwi branch without a new
      // render path. No explicit meals, no clarification.
      const parsedIntent: ParsedIntent = {
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: ["popular", "crowd-pleaser", "family-friendly"],
        mealCount: planDurationDays,
      };

      await emitActivity(userId, "wizard_complete");

      return res.json({
        candidates,
        parsedIntent,
        cannotGenerateMore: genResult.data.cannotGenerateMore,
        reason: genResult.data.reason,
        metadata: {
          promptVersion: genResult.metadata.promptVersion,
          latencyMs: genResult.metadata.latencyMs,
          flow: "surprise",
        },
      });
    },
  );

  // ── POST /wizard/expand — Branch B "View plan" (PRD §5.6 redline) ─────
  // Step 2 of the two-step wizard commit model. Takes ONE candidate from a
  // prior build-plans response and expands it into full per-meal recipe
  // detail (ingredients + steps + per-dish macros). Writes a hidden draft
  // MealPlanInstance (isWizardDraft=true) so an abandoned-but-liked plan
  // can be resumed via GET /wizard/drafts. "Save and use" (WS7-5b) flips
  // isWizardDraft=false.
  //
  // Entitlement: same key as build-plans (kitchen_wizard_set_preferences) —
  // expand is the same product surface, just a deeper step in the flow.
  // Rate limit: same per-user bucket as build-plans (a Sonnet tool_use call
  // plus the per-dish macro loop is the most expensive wizard action).
  const expandLimiter = rateLimit({
    ...limiterOpts,
    keyFn: (req: Request) => `expand:${req.userId ?? "anonymous"}`,
  });

  router.post(
    "/wizard/expand",
    requireAuth,
    expandLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      // 1. Validate body.
      const parsed = WizardExpandRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid request body",
          details: parsed.error.flatten(),
        });
      }

      // 2. Entitlement.
      const ent = await subscriptionService.can(
        userId,
        "kitchen_wizard_set_preferences",
      );
      if (!ent.allowed) {
        return res.status(402).json({
          error: "upgrade required",
          reason: ent.reason ?? "Kitchen Wizard is a premium feature.",
        });
      }

      // 3. BUG-030 idempotency (expand side). Compute the content-derived key
      //    from the candidate BEFORE the AI expand. If an unconsumed draft for
      //    this user already carries that key, reuse it — skip the Sonnet
      //    expand + per-dish macro pass AND the duplicate draft write, and
      //    return the cached expanded blob. candidate.id is NOT usable here
      //    (AI-minted, non-durable — Phase 0 finding); the hash is.
      const contentHash = computeWizardContentHash(
        parsed.data.candidate.title,
        parsed.data.candidate.mealTitles,
      );
      const existingDraft = await prisma.mealPlanInstance.findFirst({
        where: {
          userId,
          isWizardDraft: true,
          isArchived: false,
          wizardContentHash: contentHash,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true, optimizationNotes: true },
      });
      if (existingDraft) {
        const cached = WizardExpandedPlanDetailsSchema.safeParse(
          existingDraft.optimizationNotes,
        );
        if (cached.success) {
          return res.json({
            draft: {
              id: existingDraft.id,
              createdAt: existingDraft.createdAt.toISOString(),
            },
            expanded: cached.data,
          });
        }
        // Malformed cached blob on a matching draft — fall through and
        // regenerate (self-heal). The new draft carries the same hash; the
        // stale one is cleaned up by the Part B sibling sweep / TTL.
      }

      // 4. Run the AI expand + per-dish macro pass via the helper.
      const expanded = await expandCandidate({
        prisma,
        userId,
        request: parsed.data,
        runAICall,
      });

      if (expanded.status === "ai_failed") {
        logger.warn(
          {
            event: "wizard_expand_failed",
            userId,
            reason: expanded.reason,
            promptKey: "wizard.candidate.expand",
          },
          "Wizard candidate expand failed",
        );
        await emitActivity(userId, "wizard_failure");
        return res.status(502).json({
          error: expanded.userFacingMessage,
          reason: expanded.reason,
        });
      }

      // 5. Persist the hidden draft.
      let draftRef: { planId: string; createdAt: Date };
      try {
        draftRef = await persistWizardDraft({
          prisma,
          userId,
          expanded: expanded.expanded,
          contentHash,
        });
      } catch (err) {
        logger.error(
          { event: "wizard_draft_persist_failed", userId, err },
          "Failed to persist wizard draft",
        );
        return res.status(500).json({ error: "failed to persist draft" });
      }

      // 6. Activity event — new enum value wizard_candidate_expanded so
      //    funnel analytics can separate "candidates generated" from
      //    "candidate expanded into detail" (distinct user intents).
      await emitActivity(userId, "wizard_candidate_expanded", draftRef.planId);

      return res.json({
        draft: {
          id: draftRef.planId,
          createdAt: draftRef.createdAt.toISOString(),
        },
        expanded: expanded.expanded,
      });
    },
  );

  // ── GET /wizard/drafts — list resume-able wizard drafts ───────────────
  // The "Resume where you left off" mobile prompt (WS7-5b) reads here.
  // Only returns hidden drafts (isWizardDraft=true). Sweeps drafts older
  // than WIZARD_DRAFT_TTL_DAYS as a side-effect — lazy because the api-
  // server has no scheduler today (D-WS7-062). Response is intentionally
  // light: just enough for the prompt card (plan title + meal titles +
  // created-at timestamp). The full expanded detail lives on the draft's
  // optimizationNotes field and is loaded by the regular GET /plans/:id
  // path (which already returns optimizationNotes).
  router.get("/wizard/drafts", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }

    try {
      await sweepStaleWizardDrafts({ prisma, userId });

      const rows = await prisma.mealPlanInstance.findMany({
        where: { userId, isWizardDraft: true, isArchived: false },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          titleOverride: true,
          createdAt: true,
          optimizationNotes: true,
        },
      });

      const drafts = rows.map((r) => {
        const notes = (r.optimizationNotes ?? null) as
          | { meals?: Array<{ title?: string }> }
          | null;
        const mealTitles = Array.isArray(notes?.meals)
          ? notes!.meals
              .map((m) => (typeof m?.title === "string" ? m.title : null))
              .filter((t): t is string => !!t)
          : [];
        return {
          id: r.id,
          title: r.titleOverride ?? "",
          createdAt: r.createdAt.toISOString(),
          mealTitles,
        };
      });

      return res.json({
        drafts,
        ttlDays: WIZARD_DRAFT_TTL_DAYS,
      });
    } catch (err) {
      logger.error(
        { event: "wizard_drafts_list_failed", userId, err },
        "Failed to list wizard drafts",
      );
      return res.status(500).json({ error: "failed to list drafts" });
    }
  });

  // ── GET /wizard/drafts/:id — resume detail fetch (WS7-5b-server) ──────
  // Returns the full WizardExpandedPlan JSON for a single owned wizard
  // draft, parsed from optimizationNotes. Same expanded shape as the
  // POST /wizard/expand response, so mobile resume reuses the same render
  // path. 404 when not found, not owned, or not a wizard draft.
  router.get("/wizard/drafts/:id", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const draftId = req.params.id;
    if (
      typeof draftId !== "string" ||
      draftId.length === 0 ||
      draftId.length > 100
    ) {
      return res.status(400).json({ error: "invalid draft id" });
    }

    try {
      const row = await prisma.mealPlanInstance.findUnique({
        where: { id: draftId },
        select: {
          id: true,
          userId: true,
          isWizardDraft: true,
          createdAt: true,
          optimizationNotes: true,
        },
      });
      if (!row || row.userId !== userId || !row.isWizardDraft) {
        return res.status(404).json({ error: "draft not found" });
      }

      // WS7-5c Block A — switched from WizardExpandedPlanSchema (requires
      // steps) to the details-stage shape. Drafts no longer carry steps at
      // call #2 time — steps are generated by call #3 (finalize_steps) at
      // /activate or /save. Existing pre-WS7-5c drafts that DO carry steps
      // still parse cleanly (zod strips unknown fields on object schemas).
      const parsed = WizardExpandedPlanDetailsSchema.safeParse(
        row.optimizationNotes,
      );
      if (!parsed.success) {
        // Malformed JSON on a draft we own — surface as 422 (the activation
        // route uses the same code; matches PATCH /plans/:id conventions
        // around server-side schema mismatches). Logged so a recurring
        // pattern is visible without scraping prod errors.
        logger.warn(
          {
            event: "wizard_draft_detail_malformed",
            userId,
            draftId,
            issues: parsed.error.issues.slice(0, 3),
          },
          "Wizard draft optimizationNotes failed schema parse",
        );
        return res
          .status(422)
          .json({ error: "draft malformed", reason: "schema_mismatch" });
      }

      return res.json({
        draft: { id: row.id, createdAt: row.createdAt.toISOString() },
        expanded: parsed.data,
      });
    } catch (err) {
      logger.error(
        { event: "wizard_draft_detail_failed", userId, draftId, err },
        "Failed to read wizard draft detail",
      );
      return res.status(500).json({ error: "failed to read draft" });
    }
  });

  // ── POST /wizard/drafts/:id/dismiss — decline a resume draft (BUG-023) ─
  // The "Get new results" action on the resume interstitial. Pre-fix this was
  // client-only (AsyncStorage), so the server row survived and the draft
  // resurfaced on another device / after a cache clear. Now it ARCHIVES the
  // owned wizard draft server-side (isArchived:true + clears the blob), so the
  // GET /wizard/drafts list — which filters isArchived:false — never offers it
  // again. Undismissed unconsumed drafts are untouched and still resume.
  // Idempotent: dismissing an already-archived/consumed/missing draft is a
  // no-op 200 (updateMany count 0), so a double-tap or a stale id never 404s.
  router.post("/wizard/drafts/:id/dismiss", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const draftId = req.params.id;
    if (
      typeof draftId !== "string" ||
      draftId.length === 0 ||
      draftId.length > 100
    ) {
      return res.status(400).json({ error: "invalid draft id" });
    }

    try {
      // Scoped by id + userId + isWizardDraft so this can only ever archive
      // the caller's own unconsumed draft — never a real plan (isWizardDraft:
      // false) and never another user's row. Never flips isWizardDraft.
      const result = await prisma.mealPlanInstance.updateMany({
        where: { id: draftId, userId, isWizardDraft: true, isArchived: false },
        data: { isArchived: true, optimizationNotes: Prisma.DbNull },
      });
      return res.json({ dismissed: result.count > 0 });
    } catch (err) {
      logger.error(
        { event: "wizard_draft_dismiss_failed", userId, draftId, err },
        "Failed to dismiss wizard draft",
      );
      return res.status(500).json({ error: "failed to dismiss draft" });
    }
  });

  // ── POST /wizard/drafts/:id/activate — "Save and use" (WS7-5b-server) ─
  // Materializes the hidden draft into real Meal / Dish / DishIngredient /
  // RecipeInstructionStep / MealPlanItem rows, demotes any other active
  // plan for this user, flips the draft to active (isWizardDraft=false,
  // isActiveThisWeek=true, status stays "draft" matching the use-template
  // precedent), bumps revisionId, and emits plan_activated_this_week.
  //
  // Response mirrors POST /plans/use-template ({ instance: { id, revisionId } })
  // so the mobile post-activation navigation reuses the same Plan Review
  // entry point.
  router.post("/wizard/drafts/:id/activate", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const draftId = req.params.id;
    if (
      typeof draftId !== "string" ||
      draftId.length === 0 ||
      draftId.length > 100
    ) {
      return res.status(400).json({ error: "invalid draft id" });
    }

    // BUG-030 idempotency (activate side). If this candidate's content-hash
    // has ALREADY materialized into a real (non-draft) plan for this user,
    // return that plan instead of running finalize-steps + materializing a
    // second plan/template. The hash rides on the draft row being activated;
    // a prior activation kept the same hash on the row it flipped to a plan.
    // (The just-created orphan draft this activate targets is left for the
    // Part B sibling sweep — it is hidden from every isWizardDraft reader.)
    const activateIdempotent = await findExistingPlanForDraft(draftId, userId);
    if (activateIdempotent) {
      // Clear this orphan draft + any siblings so the resume list can't offer
      // a plan the user already has (the A/B seam).
      await supersedeUnconsumedWizardDrafts({ prisma, userId });
      return res.status(201).json({ instance: activateIdempotent });
    }

    // WS7-5c Block A — finalize-steps BEFORE the tx. Stepless details-stage
    // draft + wizard.candidate.finalize_steps merge → with-steps payload
    // ready for the materializer. Kept outside the $transaction because the
    // ~Sonnet latency would blow the 60s tx budget (see tx block below).
    const finalizeResult = await readAndFinalizeWizardDraftImpl({
      prisma,
      userId,
      draftId,
      runAICall,
    });
    if (finalizeResult.status === "not_found") {
      return res.status(404).json({ error: "draft not found" });
    }
    if (finalizeResult.status === "malformed") {
      logger.warn(
        {
          event: "wizard_draft_activate_malformed",
          userId,
          draftId,
          reason: finalizeResult.reason,
        },
        "Wizard draft malformed during activation (pre-finalize)",
      );
      return res
        .status(422)
        .json({ error: "draft malformed", reason: finalizeResult.reason });
    }
    if (finalizeResult.status === "ai_failed") {
      logger.warn(
        {
          event: "wizard_finalize_steps_failed",
          userId,
          draftId,
          reason: finalizeResult.reason,
          promptKey: "wizard.candidate.finalize_steps",
        },
        "Wizard finalize-steps AI call failed during activation",
      );
      return res
        .status(502)
        .json({
          error: finalizeResult.userFacingMessage,
          reason: finalizeResult.reason,
        });
    }
    if (finalizeResult.status === "merge_failed") {
      logger.warn(
        {
          event: "wizard_finalize_steps_merge_failed",
          userId,
          draftId,
          reason: finalizeResult.reason,
        },
        "Wizard finalize-steps merge failed during activation",
      );
      return res
        .status(422)
        .json({
          error: "draft malformed",
          reason: `merge_failed:${finalizeResult.reason}`,
        });
    }
    const payload = finalizeResult.payload;

    const __txStart = Date.now();
    let __txElapsedAtThrow = -1;
    try {
      const result = await prisma.$transaction(async (tx) => {
        const materialized = await materializeWizardDraftImpl({
          prisma,
          tx,
          userId,
          draftId,
          payload,
        });

        // WS7-6 (E) Block 1 REWORK seam C — stamp activatedAt in the
        // SAME write that sets the current-week dates. Plans MAY share
        // date ranges under Model 2 (no EXCLUDE constraint); single-
        // current is enforced at READ time by the resolver. The fresh
        // activatedAt timestamp guarantees this row wins the tiebreak
        // over any pre-existing covering plan with an older activatedAt
        // (or null) — that pre-existing plan stays in my_plans, undeleted,
        // simply no longer designated. The unconditional emit below is
        // preserved (Phase 1 ruling): every wizard activate is a fresh
        // user commitment, regardless of pre-state.
        const week = currentWeekRange();
        const activated = await tx.mealPlanInstance.update({
          where: { id: draftId },
          data: {
            isWizardDraft: false,
            revisionId: { increment: 1 },
            startDate: new Date(week.startDate),
            endDate: new Date(week.endDate),
            activatedAt: new Date(),
            // WS7-5b-mobile FIX (PRD §2.4): link the freshly-created
            // hidden Template, and clear the wizard-JSON blob that pre-fix
            // code wrote into optimizationNotes (Plan Review's mobile
            // PlanSchema requires [{type,text}]; the blob failed parse).
            mealPlanTemplateId: materialized.mealPlanTemplateId,
            optimizationNotes: Prisma.DbNull,
          },
          select: { id: true, revisionId: true },
        });

        // D-WS9-026 — stamp first-plan-created (write-if-null; first wins).
        await markFirstPlanCreated(tx, userId);

        await emitSharedActivity({
          tx,
          userId,
          eventType: "plan_activated_this_week",
          entityType: "MealPlanInstance",
          entityId: activated.id,
          metadata: {
            source: "wizard_draft_activate",
            mealsCreated: materialized.mealsCreated,
            itemsCreated: materialized.itemsCreated,
          },
        });

        return activated;
      }, {
        // WS7-5b activate fix: default 5000ms timeout proved tight under
        // real-Postgres load. Phase-1 smoke measured tx=5088ms (P2028 at
        // ~5034ms) with meals=5/dishes=14, but that figure was clamped by
        // Prisma's own cancellation — the CONFIRM run after hoisting Pass 1
        // (read + ingredient upserts) to the plain prisma client measured
        // the real un-clamped tx at ~17_063ms on a 17-dish input. A 30s
        // budget gave only ~1.76× headroom, so we hold at 60s (~3.5× over
        // the observed tail) to absorb AI dish-count variance on heavier
        // wizard outputs. The durable fix — batching recipeInstructionStep
        // and dishIngredient writes via createMany to cut Pass 2 RTTs — is
        // deferred to WS9 per D-WS7-067.
        timeout: 60_000,
        maxWait: 20_000,
      });
      console.log(
        `[WS7-5b-smoke] activate $transaction elapsed: ${Date.now() - __txStart}ms (ok)`,
      );

      // BUG-030 Part B — supersede sibling unconsumed drafts (post-tx, best-
      // effort). The just-activated row is now isWizardDraft:false, so it is
      // excluded from the archive; only the moot peeked siblings are cleared.
      await supersedeUnconsumedWizardDrafts({ prisma, userId });

      return res
        .status(201)
        .json({ instance: { id: result.id, revisionId: result.revisionId } });
    } catch (err) {
      __txElapsedAtThrow = Date.now() - __txStart;
      console.error(
        `[WS7-5b-smoke] activate $transaction elapsed: ${__txElapsedAtThrow}ms (throw: ${(err as Error)?.name ?? "unknown"})`,
      );
      if (err instanceof WizardDraftNotFoundError) {
        return res.status(404).json({ error: "draft not found" });
      }
      if (err instanceof WizardDraftMalformedError) {
        logger.warn(
          {
            event: "wizard_draft_activate_malformed",
            userId,
            draftId,
            reason: err.reason,
          },
          "Wizard draft malformed during activation",
        );
        return res
          .status(422)
          .json({ error: "draft malformed", reason: err.reason });
      }
      logger.error(
        { event: "wizard_draft_activate_failed", userId, draftId, err },
        "Failed to activate wizard draft",
      );
      return res.status(500).json({ error: "failed to activate draft" });
    }
  });

  // ── POST /wizard/drafts/:id/save — "Save for Later" (WS7-5b2-server) ──
  // Promotes the hidden draft into a real user-visible plan in My Plans —
  // but undated and NOT active this week. The two-step wizard's other CTA:
  // "I like this plan and I'm keeping it, but I'm not committing to cooking
  // it this week yet." Uses the SAME materializer as /activate (the draft
  // JSON must still become a real Meal / Dish / DishIngredient / Recipe-
  // InstructionStep / MealPlanItem graph regardless of active state); only
  // the post-materialize tail differs:
  //   - flip isWizardDraft → false (the draft becomes a visible plan)
  //   - LEAVE isActiveThisWeek=false (default)  — NOT active this week
  //   - LEAVE startDate/endDate null (default)  — undated
  //   - do NOT demote prior actives (nothing's becoming active)
  //   - do NOT bump revisionId (fresh promotion, mirrors POST /plans/
  //     use-template which creates rows at the default revisionId=1)
  //   - emit plan_created (already in ActivityEventType — no migration;
  //     mirrors how /activate reused plan_activated_this_week).
  //
  // Response shape mirrors /activate ({ instance: { id, revisionId } }) so
  // mobile can reuse the same post-save navigation entry point.
  router.post("/wizard/drafts/:id/save", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const draftId = req.params.id;
    if (
      typeof draftId !== "string" ||
      draftId.length === 0 ||
      draftId.length > 100
    ) {
      return res.status(400).json({ error: "invalid draft id" });
    }

    // BUG-030 idempotency (save side). Mirrors /activate: if this candidate's
    // content-hash already materialized into a real (non-draft) plan, return
    // it rather than materializing a second. Note the save→use flow does NOT
    // reach here twice (the mobile CTA decider switches to PATCH /plans after
    // a save), so this guards genuine re-save of the same candidate.
    const saveIdempotent = await findExistingPlanForDraft(draftId, userId);
    if (saveIdempotent) {
      await supersedeUnconsumedWizardDrafts({ prisma, userId });
      return res.status(201).json({ instance: saveIdempotent });
    }

    // WS7-5c Block A — finalize-steps BEFORE the tx. Mirrors /activate; see
    // the comment block there for the rationale (kept off the $transaction
    // because the ~Sonnet latency would blow the 60s tx budget).
    const finalizeResult = await readAndFinalizeWizardDraftImpl({
      prisma,
      userId,
      draftId,
      runAICall,
    });
    if (finalizeResult.status === "not_found") {
      return res.status(404).json({ error: "draft not found" });
    }
    if (finalizeResult.status === "malformed") {
      logger.warn(
        {
          event: "wizard_draft_save_malformed",
          userId,
          draftId,
          reason: finalizeResult.reason,
        },
        "Wizard draft malformed during save (pre-finalize)",
      );
      return res
        .status(422)
        .json({ error: "draft malformed", reason: finalizeResult.reason });
    }
    if (finalizeResult.status === "ai_failed") {
      logger.warn(
        {
          event: "wizard_finalize_steps_failed",
          userId,
          draftId,
          reason: finalizeResult.reason,
          promptKey: "wizard.candidate.finalize_steps",
        },
        "Wizard finalize-steps AI call failed during save",
      );
      return res
        .status(502)
        .json({
          error: finalizeResult.userFacingMessage,
          reason: finalizeResult.reason,
        });
    }
    if (finalizeResult.status === "merge_failed") {
      logger.warn(
        {
          event: "wizard_finalize_steps_merge_failed",
          userId,
          draftId,
          reason: finalizeResult.reason,
        },
        "Wizard finalize-steps merge failed during save",
      );
      return res
        .status(422)
        .json({
          error: "draft malformed",
          reason: `merge_failed:${finalizeResult.reason}`,
        });
    }
    const payload = finalizeResult.payload;

    const __txStart = Date.now();
    let __txElapsedAtThrow = -1;
    try {
      const result = await prisma.$transaction(async (tx) => {
        const materialized = await materializeWizardDraftImpl({
          prisma,
          tx,
          userId,
          draftId,
          payload,
        });

        // Save tail — flip ONLY isWizardDraft. The materializer is identical
        // to activate's, so the same 60s tx budget applies (same per-dish
        // write volume; D-WS7-067 createMany batching will improve both
        // paths). status stays "draft", dates stay null, isActiveThisWeek
        // stays false, revisionId stays at its default (1 from the expand
        // persist write). NOT demoting prior actives — this isn't becoming
        // active, so there's nothing to demote.
        const saved = await tx.mealPlanInstance.update({
          where: { id: draftId },
          data: {
            isWizardDraft: false,
            // WS7-5b-mobile FIX (PRD §2.4): same Template-pair link + JSON
            // clear as /activate. Save path doesn't flip active / set dates
            // / bump revisionId — only the template link + notes change.
            mealPlanTemplateId: materialized.mealPlanTemplateId,
            optimizationNotes: Prisma.DbNull,
          },
          select: { id: true, revisionId: true },
        });

        // D-WS9-026 — stamp first-plan-created (write-if-null; first wins).
        await markFirstPlanCreated(tx, userId);

        await emitSharedActivity({
          tx,
          userId,
          eventType: "plan_created",
          entityType: "MealPlanInstance",
          entityId: saved.id,
          metadata: {
            source: "wizard_draft_save",
            mealsCreated: materialized.mealsCreated,
            itemsCreated: materialized.itemsCreated,
          },
        });

        return saved;
      }, {
        // Same budget as /activate. Save runs the same Pass 2 write volume
        // (materializer is shared) so the timeout exposure is identical.
        timeout: 60_000,
        maxWait: 20_000,
      });
      console.log(
        `[WS7-5b2-smoke] save $transaction elapsed: ${Date.now() - __txStart}ms (ok)`,
      );

      // BUG-030 Part B — supersede sibling unconsumed drafts (post-tx, best-
      // effort). Mirrors /activate; the just-saved row is isWizardDraft:false.
      await supersedeUnconsumedWizardDrafts({ prisma, userId });

      return res
        .status(201)
        .json({ instance: { id: result.id, revisionId: result.revisionId } });
    } catch (err) {
      __txElapsedAtThrow = Date.now() - __txStart;
      console.error(
        `[WS7-5b2-smoke] save $transaction elapsed: ${__txElapsedAtThrow}ms (throw: ${(err as Error)?.name ?? "unknown"})`,
      );
      if (err instanceof WizardDraftNotFoundError) {
        return res.status(404).json({ error: "draft not found" });
      }
      if (err instanceof WizardDraftMalformedError) {
        logger.warn(
          {
            event: "wizard_draft_save_malformed",
            userId,
            draftId,
            reason: err.reason,
          },
          "Wizard draft malformed during save",
        );
        return res
          .status(422)
          .json({ error: "draft malformed", reason: err.reason });
      }
      logger.error(
        { event: "wizard_draft_save_failed", userId, draftId, err },
        "Failed to save wizard draft",
      );
      return res.status(500).json({ error: "failed to save draft" });
    }
  });

  router.get("/wizard/limits", requireAuth, async (_req, res) => {
    const [candidateCount, maxRefreshes] = await Promise.all([
      getCandidateCount(),
      getMaxRefreshes(),
    ]);
    return res.json({
      candidateCount,
      maxRefreshesPerSession: maxRefreshes,
    });
  });

  return router;
}

// Default export — production wiring with real deps.
const router = createWizardRouter();
export default router;
