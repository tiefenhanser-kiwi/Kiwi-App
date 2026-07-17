// WS7-5b-server — wizard draft activation ("Save and use" materializer).
//
// Reads the hidden draft (isWizardDraft=true) written by WS7-5a expand and
// materializes it into real Meal / Dish / MealDishLink / DishIngredient /
// RecipeInstructionStep / MealPlanItem rows so the existing plan-view UX
// renders it as a real plan.
//
// Why not createMealWithDishes? mealCreate.ts:121-131 enforces strict
// canonicalName resolution and throws on any miss. Wizard-AI ingredient
// names mostly will not pre-exist (chicken thighs, harissa, etc.) so the
// strict resolver fires on nearly every activation. Activation needs an
// upsert path with deterministic category inference instead.
//
// Category inference is a deterministic keyword map (NO AI call, no latency).
// Approximate for uncommon names; D-WS7-065 acknowledges a future master-
// data reconciliation pass (analogous to WS6 6c-4 purchaseUnit writeback)
// would refine categories without touching this file.

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  WizardExpandEnrichedMealSchema,
  type WizardExpandEnrichedMeal,
} from "./ai/schemas/wizard";
import { inferCategory, resolveIngredients } from "./ingredientResolve";
import { recomputeAndPersistMealMacros } from "./mealMacros";
import { deriveAmountRefs, type MatcherIngredient } from "./stepAmountRefs";
import { forkMealForUser, publishMealToStore } from "./mealFork";
import type { WizardSavePlan } from "./wizardSavePlan";

// WS7-6 Block 2: inferCategory now lives in ingredientResolve.ts so the new
// save-canonical materializeMeal can reuse it. Re-exported here so existing
// importers (wizardActivation.test.ts, anything else referencing the wizard
// module) don't have to change paths.
export { inferCategory };

export class WizardDraftNotFoundError extends Error {
  constructor(public readonly draftId: string) {
    super(`Wizard draft not found: ${draftId}`);
    this.name = "WizardDraftNotFoundError";
  }
}

export class WizardDraftMalformedError extends Error {
  constructor(
    public readonly draftId: string,
    public readonly reason: string,
  ) {
    super(`Wizard draft malformed: ${draftId} (${reason})`);
    this.name = "WizardDraftMalformedError";
  }
}

// ── materializeWizardDraft ──────────────────────────────────────────────

export interface MaterializeWizardDraftOptions {
  // Plain Prisma client — used for the non-transactional preamble (read of
  // the draft row, Zod parse, ingredient upserts). Pass 1 commits as it
  // goes; orphaned ingredient rows from a later-aborted plan-graph tx are
  // harmless (no plan references them; the next activation reuses them).
  prisma: PrismaClient;
  // Transactional client — used for Pass 2 (meal-graph writes that must
  // be all-or-nothing).
  tx: Prisma.TransactionClient;
  userId: string;
  draftId: string;
  // D-WS9-038 — the partitioned save plan produced by readAndFinalizeWizardDraft
  // (run BEFORE the tx). Slots are in order; each is either a store fork or a
  // built live meal. Build slots carry finalized steps; store slots carry only
  // a (revalidated) sourceStoreMealId. Replaces the old flat WizardExpandedPlan
  // payload so the materializer can mix forked + built meals per slot.
  savePlan: WizardSavePlan;
}

export interface MaterializeWizardDraftResult {
  savePlan: WizardSavePlan;
  mealsCreated: number;
  dishesCreated: number;
  itemsCreated: number;
  ingredientsTouched: number;
  // WS7-5b-mobile FIX — PRD §2.4: every wizard plan persists as a
  // MealPlanTemplate (auto-saved, hidden) + a linked MealPlanInstance. The
  // route handler reads this and writes it into the Instance's
  // mealPlanTemplateId in the same transaction.
  mealPlanTemplateId: string;
}

/**
 * Read the hidden draft row, parse its stored WizardExpandedPlan JSON, and
 * materialize the meal graph (Meal + Dish + MealDishLink + DishIngredient +
 * RecipeInstructionStep + MealPlanItem) so the activated plan reads back
 * through the existing plan-view paths.
 *
 * Split across two clients to keep the atomic critical section small:
 * - Pass 1 (draft read, Zod parse, ingredient upserts) runs on the plain
 *   `prisma` client. Ingredient rows are write-once reference content;
 *   committing them independently is safe — a later rollback of Pass 2
 *   leaves them as harmless orphans that the next activation reuses.
 * - Pass 2 (meal-graph writes) runs on the caller's `tx`. The caller is
 *   responsible for the active-flip + activity emit + flipping
 *   isWizardDraft → false within the same transaction.
 *
 * @throws WizardDraftNotFoundError if the draft isn't owned by userId or
 *   isn't a wizard draft.
 * @throws WizardDraftMalformedError if wizardDraftPayload doesn't parse as
 *   a WizardExpandedPlan, or if a dish ingredient name fails to resolve in
 *   the upserted map (Pass 1 covers every non-empty name).
 */
export async function materializeWizardDraft(
  opts: MaterializeWizardDraftOptions,
): Promise<MaterializeWizardDraftResult> {
  const { prisma, tx, userId, draftId, savePlan } = opts;

  // ── Pass 1 (non-transactional): read draft, validate BUILD slots, upsert ─
  // The caller (readAndFinalizeWizardDraft) already read the draft, partitioned
  // slots, and finalized the build subset. We re-read the row only for the
  // ownership + isWizardDraft invariant (kept in one place).
  const draft = await prisma.mealPlanInstance.findUnique({
    where: { id: draftId },
    select: { userId: true, isWizardDraft: true },
  });
  if (!draft || draft.userId !== userId || !draft.isWizardDraft) {
    throw new WizardDraftNotFoundError(draftId);
  }

  // D-WS9-038 partition-then-validate: ONLY build slots are validated against
  // the with-steps schema. Store slots are forked from the (already isPublic-
  // revalidated) source row and are never built from this payload, so they are
  // deliberately excluded from the steps-required check.
  const buildMeals: WizardExpandEnrichedMeal[] = [];
  for (const slot of savePlan.slots) {
    if (slot.kind !== "build") continue;
    const parsed = WizardExpandEnrichedMealSchema.safeParse(slot.meal);
    if (!parsed.success) {
      const reason =
        parsed.error.issues
          .slice(0, 3)
          .map((i) => i.path.join(".") || "root")
          .join(",") || "shape_mismatch";
      throw new WizardDraftMalformedError(draftId, reason);
    }
    buildMeals.push(parsed.data);
  }

  // Ingredient upsert covers build meals only (store forks re-use the source
  // meal's DishIngredient rows, ingredientId preserved — no resolution needed).
  const mentions = buildMeals.flatMap((m) =>
    m.dishes.flatMap((d) =>
      d.ingredients.map((ing) => ({ name: ing.name, unit: ing.unit })),
    ),
  );
  const ingredientIdByCanonical = await resolveIngredients(prisma, mentions);

  // ── Pass 2 (transactional): materialize the mixed graph, in slot order. ──
  let mealsCreated = 0;
  let dishesCreated = 0;
  let itemsCreated = 0;
  // Dedup store forks: a store meal used in two slots forks ONCE (mirrors the
  // use-template boundBySource pattern, plans.ts:1291-1310).
  const boundBySource = new Map<string, string>();

  for (let si = 0; si < savePlan.slots.length; si++) {
    const slot = savePlan.slots[si];
    let mealId: string;

    if (slot.kind === "store") {
      // Store slot — fork the (already isPublic-revalidated) pool meal. Steps +
      // dishes come from the source row, so there is no build and no finalize.
      let bound = boundBySource.get(slot.sourceStoreMealId);
      if (!bound) {
        bound = (await forkMealForUser(tx, slot.sourceStoreMealId, userId))
          .mealId;
        boundBySource.set(slot.sourceStoreMealId, bound);
        mealsCreated++;
      }
      mealId = bound;
    } else {
      const m = slot.meal;

      const meal = await tx.meal.create({
        data: {
          userId,
          title: m.title,
          sourceType: "wizard",
          cuisineType: m.cuisineType,
          mealType: "dinner",
          difficulty: m.difficulty,
          estimatedTimeMinutes: m.estimatedTimeMinutes,
          servingsDefault: m.servings,
          // WS7-8 BUG-003 — anchor frozen == servingsDefault at create.
          authoredServingsDefault: m.servings,
          isPublic: false,
          isArchived: false,
        },
        select: { id: true },
      });
      mealsCreated++;

      for (let di = 0; di < m.dishes.length; di++) {
        const d = m.dishes[di];

        // Per-dish macros: if the wizard expand pass produced numbers and the
        // estimate didn't fail, write them into the *PerServing cache so the
        // activated plan's macros tile renders immediately. Failed/null
        // macros leave the cache at the schema default (0), and the existing
        // planNeedsMacroEstimation predicate (planMacros.ts:142-184) will
        // surface a stale flag for a follow-up recalc.
        const macros =
          d.macros && !d.macros.failed
            ? {
                caloriesPerServing: d.macros.caloriesPerServing,
                proteinGPerServing: d.macros.proteinGPerServing,
                carbsGPerServing: d.macros.carbsGPerServing,
                fatGPerServing: d.macros.fatGPerServing,
              }
            : {};

        const dish = await tx.dish.create({
          data: {
            userId,
            title: d.title,
            sourceType: "wizard",
            estimatedTimeMinutes: m.estimatedTimeMinutes,
            difficulty: m.difficulty,
            servingsDefault: m.servings,
            // WS7-8 BUG-003 — anchor frozen == servingsDefault at create.
            authoredServingsDefault: m.servings,
            isArchived: false,
            ...macros,
          },
          select: { id: true },
        });
        dishesCreated++;

        await tx.mealDishLink.create({
          data: {
            mealId: meal.id,
            dishId: dish.id,
            positionIndex: d.positionIndex,
            roleLabel: d.role,
          },
        });

        for (let ii = 0; ii < d.ingredients.length; ii++) {
          const ing = d.ingredients[ii];
          const canonical = ing.name.toLowerCase().trim();
          const ingredientId = ingredientIdByCanonical.get(canonical);
          if (!ingredientId) {
            // Pass 1 upserted every non-empty name. Hitting this branch means
            // an empty-or-whitespace ingredient name made it past the Zod
            // schema's .min(1) — surface as a malformed-draft error rather
            // than 500ing on a Prisma FK violation.
            throw new WizardDraftMalformedError(
              draftId,
              `ingredient_missing:${ing.name}`,
            );
          }
          await tx.dishIngredient.create({
            data: {
              dishId: dish.id,
              ingredientId,
              quantity: ing.quantity,
              unit: ing.unit,
              preparationNote: ing.preparationNote ?? null,
              isOptional: ing.isOptional ?? false,
              positionIndex: ii,
            },
          });
        }

        // WS7-8b BUG-003 Block 1 — the dish's ingredient rows for server-side
        // ref derivation. Every id is present (the loop above threw otherwise).
        const matcherIngredients: MatcherIngredient[] = d.ingredients.map(
          (ing) => ({
            ingredientId:
              ingredientIdByCanonical.get(ing.name.toLowerCase().trim()) ?? "",
            name: ing.name,
            quantity: ing.quantity,
            unit: ing.unit,
          }),
        );

        for (let si = 0; si < d.steps.length; si++) {
          const step = d.steps[si];
          // WS7-8b BUG-003 Block 1 — derive step→ingredient refs from the dish's
          // own ingredients. Always stored (even []) so the read side can tell a
          // derived step from a legacy (null) one; see D-WS7-171 notes.
          const { amountRefs } = deriveAmountRefs(
            step.text,
            matcherIngredients,
          );
          // BUG #3 (D-WS7-165) — persist phaseType + estimatedMinutes from the
          // widened step object instead of letting them fall to the DB column
          // defaults (cook / 1 min). BUG-018 (WS7-8b B1) — isTimingSensitive
          // joins them for the same reason: wizard steps were stuck at the DB
          // false default, starving the Cooking Sequencer of the signal that
          // stops it stacking prep onto a sear. Set unconditionally: the widened
          // WizardStepSchema makes all three fields required, so no optional-
          // spread guard is needed (intentional divergence from mealMaterialize.ts,
          // whose builder step fields are optional).
          await tx.recipeInstructionStep.create({
            data: {
              ownerType: "dish",
              ownerId: dish.id,
              stepIndex: si,
              stepTextRaw: step.text,
              stepTextTranslated: step.text,
              phaseType: step.phaseType,
              estimatedMinutes: step.estimatedMinutes,
              isTimingSensitive: step.isTimingSensitive,
              amountRefs: amountRefs as unknown as Prisma.InputJsonValue,
            },
          });
        }
      }

      // WS7-6 Fix-Block 3 (Bug 3): roll the per-dish per-serving macros up to
      // the meal row as a simple sum (Hans's ruling — see mealMacros.ts).
      await recomputeAndPersistMealMacros(tx, meal.id);
      mealId = meal.id;

      // Write-back (D-WS7-201): publish a pool copy stamped live_writeback so a
      // future compose can reuse this live gen. Demoted store slots build but do
      // NOT write back (writeBack:false) — never re-publish an unpublished meal.
      if (slot.writeBack) {
        await publishMealToStore(tx, mealId);
      }
    }

    await tx.mealPlanItem.create({
      data: {
        mealPlanInstanceId: draftId,
        mealId,
        positionIndex: si,
        isBreakfast: false,
        isLunch: false,
        isDinner: true,
      },
    });
    itemsCreated++;
  }

  // WS7-5b-mobile FIX — PRD §2.4. Wizard plans must persist as a
  // MealPlanTemplate (auto-saved, hidden) + a linked MealPlanInstance.
  // Pre-fix: the draft → activate/save path left mealPlanTemplateId null
  // and stuffed the WizardExpandedPlan JSON into the draft blob (now
  // wizardDraftPayload, D-WS9-034; formerly optimizationNotes); that
  // broke Plan Review's mobile PlanSchema parse (couldn't-load-this-plan)
  // and rendered blank My Plans cards. Description carries whyBullets
  // (PRD §5.6 candidate copy) as bullet copy so the card subtext renders.
  // imageUrl stays null — WS7-10 owns stock-image integration. Dedup-by-
  // meal-set (PRD §2.4 line 258) is deferred to D-WS7-071; this path
  // creates a fresh Template per wizard plan and accepts dupes for now.
  const description = savePlan.whyBullets.map((b) => `• ${b}`).join("\n");
  // Block 1 (D-WS7-071 MINIMAL reconcile) — dedup-on-write guard. Re-
  // activating the same candidate must not mint a second private wizard
  // Template. The route's content-hash idempotency already short-circuits a
  // same-candidate re-activate before it reaches the materializer; this guard
  // is the belt-and-suspenders inside the tx. Match on the fields available on
  // the Template row (no meal-set is persisted on MealPlanTemplate, so we key
  // on userId + wizard source + title + day-count). Full "one template per
  // meal-set" canonicalization (a stable key column + backfill of historical
  // dupes) stays deferred to Phase C — historical dupes are harmless (private,
  // isPublic:false, read by id).
  const existingTemplate = await tx.mealPlanTemplate.findFirst({
    where: {
      userId,
      sourceType: "wizard",
      isArchived: false,
      title: savePlan.title,
      defaultDaysCount: savePlan.slots.length,
    },
    select: { id: true },
  });
  const template =
    existingTemplate ??
    (await tx.mealPlanTemplate.create({
      data: {
        userId,
        title: savePlan.title,
        description,
        tags: savePlan.tags,
        sourceType: "wizard",
        defaultDaysCount: savePlan.slots.length,
        imageUrl: null,
        isPublic: false,
        isArchived: false,
      },
      select: { id: true },
    }));

  return {
    savePlan,
    mealsCreated,
    dishesCreated,
    itemsCreated,
    ingredientsTouched: ingredientIdByCanonical.size,
    mealPlanTemplateId: template.id,
  };
}
