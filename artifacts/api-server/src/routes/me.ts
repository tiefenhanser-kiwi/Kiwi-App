// /me/* — authenticated user-account routes.
//
// Deactivation note: per WS7-2 Block A locked decision 2, deactivation reuses
// existing User columns rather than introducing a deactivatedAt field.
//   deactivate  = { accountStatus: 'paused', customerEndDate: new Date() }
//   reactivate  = { accountStatus: 'active', customerEndDate: null }  (within 6mo TTL)
// Permanent deletion is a future cron job (out of scope for Block A).

import { Router, type IRouter } from "express";
import { type Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { hashPassword, signToken, verifyPassword, verifyToken } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  collectDishMentions,
  collectMealMentions,
  collectRematerializeDishMentions,
  materializeDish,
  materializeMeal,
  rematerializeDish,
  rematerializeMeal,
  type MaterializeMealDish,
} from "../lib/mealMaterialize";
import { resolveIngredients } from "../lib/ingredientResolve";
import { bumpPlanRevision } from "../lib/planRevision";
import { prisma as productionPrisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../lib/rateLimit";
import { getTopRatedSettings } from "../lib/topRated";
import {
  clampLimit,
  decodeKeysetCursor,
  mergeById,
  paginateByKeyset,
  parseDishSortParam,
  parseFilterParam,
  parseMealSortParam,
} from "../lib/listQuery";
import { MEAL_LIST_SELECT, toListShape } from "./meals";

// WS7-6 G2 scope (iii) — /me/meals keyset sort needs `createdAt` (the
// date_created sort value) on each row; toListShape ignores it so the wire
// output is byte-unchanged. estimatedTimeMinutes (cook_time) + title (alpha)
// are already in MEAL_LIST_SELECT.
const MEAL_LIST_SELECT_SORTED = {
  ...MEAL_LIST_SELECT,
  createdAt: true,
} as const;
type MealListRow = {
  id: string;
  title: string;
  cuisineType: string | null;
  estimatedTimeMinutes: number;
  servingsDefault: number;
  // WS7-8 BUG-003 — authored-servings anchor (in MEAL_LIST_SELECT).
  authoredServingsDefault: number | null;
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  tags: string[];
  imageUrl: string | null;
  createdAt: Date;
};

// Brute-force protection on password change (matches /auth/login posture).
const passwordChangeLimiter = rateLimit({ capacity: 10, refillPerSec: 10 / 60 });

// Same posture as password-reset request: deters enumeration probing.
const emailRequestLimiter = rateLimit({ capacity: 5, refillPerSec: 5 / 300 });

// Brute-force protection on reactivate (matches /auth/login posture).
const reactivateLimiter = rateLimit({ capacity: 10, refillPerSec: 10 / 60 });

// Email-change verification token TTL (matches password-reset).
const EMAIL_CHANGE_EXPIRY = "1h";

const FILTER_KEYS = ["my_plans", "featured", "top_rated", "hosting_events"] as const;
// WS7-3 A2: widened from the two-key ["my_meals","all_meals"] set to the
// four-key mobile Meals-tab chip vocabulary. `all_meals` is dropped — it is
// superseded by passing all four discovery filter keys. `GET /me/meals`
// validates its ?filter= param against this same constant.
const MEALS_FILTER_KEYS = [
  "my_meals",
  "featured",
  "top_rated",
  "hosting",
] as const;
// WS7-3 A2: `GET /me/dishes` ?filter= accept-list. No `hosting` — dishes have
// no hosting concept per PRD. Not persisted (dish filters aren't a ui-state
// field at MVP), so no uiStateSchema entry.
const DISHES_FILTER_KEYS = ["my_dishes", "featured", "top_rated"] as const;

const uiStateSchema = z.object({
  lastPlanDiscoveryFilters: z.array(z.enum(FILTER_KEYS)).optional(),
  lastPlansFilters: z.array(z.enum(FILTER_KEYS)).optional(),
  lastMealsFilters: z.array(z.enum(MEALS_FILTER_KEYS)).optional(),
  // At-least-one-field requirement is enforced below by the runtime
  // Object.keys length check, so Zod's .optional() on every field is
  // intentional.
});

const favoriteCreateSchema = z.object({
  mealId: z.string().min(1).max(100),
});

// PATCH /me/preferences accept list. Explicit (no .passthrough()) so server-
// only columns (difficultyDefault, weeklyPacingDefault, breakfastDefaults,
// lunchDefaults, macroPref, notificationsEnabled, lastUsedRetailerId) cannot
// be set by clients. Marketing consents stay on User per D-WS6-002.
// Permissive phone validator: at least 7 digits anywhere in the string.
// Mobile-side formatting (dashes, parens, country code) is up to the client.
const PHONE_REGEX = /(?:\D*\d){7,}/;

const profilePatchSchema = z
  .object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    phone: z
      .string()
      .max(40)
      .regex(PHONE_REGEX, "phone must contain at least 7 digits")
      .nullable()
      .optional(),
    // WS7-2 Block C: marketing consent (D-WS7-025) lives on User and is
    // editable from preferences.tsx. Routing flags onboardingComplete /
    // firstRunChoiceMade are written here by onboarding-step-3 +
    // first-run-destination — User columns, all pass straight to update().
    marketingConsentEmail: z.boolean().optional(),
    marketingConsentSms: z.boolean().optional(),
    onboardingComplete: z.boolean().optional(),
    firstRunChoiceMade: z.boolean().optional(),
  })
  .strict();

const passwordPatchSchema = z.object({
  currentPassword: z.string().min(1).max(100),
  newPassword: z.string().min(8).max(100),
});

const emailRequestChangeSchema = z.object({
  newEmail: z.string().email().max(255),
});

const emailVerifyChangeSchema = z.object({
  token: z.string().min(10).max(500),
});

const reactivateSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(100),
});

// WS7-2 Block A locked decision 5: reactivation TTL is 6 months from
// customerEndDate. After that the account is past its window and the user
// must contact support (permanent-deletion cron is post-MVP).
const REACTIVATION_TTL_MS = 6 * 30 * 24 * 60 * 60 * 1000;

// MealPlanInstance.status values that represent active or scheduled plans
// (per PlanStatus enum). On deactivation these flip to 'past'.
const ACTIVE_PLAN_STATUSES = ["this_week", "next_week", "upcoming"] as const;

const preferencesPatchSchema = z
  .object({
    householdSize: z.number().int().min(1).max(30).optional(),
    wantsLeftovers: z.boolean().optional(),
    cuisines: z.array(z.string().max(60)).max(60).optional(),
    eatingStyles: z.array(z.string().max(60)).max(30).optional(),
    allergiesAndAvoidances: z.array(z.string().max(60)).max(60).optional(),
    cookingSkill: z.enum(["beginner", "intermediate", "advanced"]).nullable().optional(),
    stovetopType: z.enum(["gas", "induction", "electric"]).nullable().optional(),
    kidsCount: z.number().int().min(0).max(30).optional(),
    pickyEaterCount: z.number().int().min(0).max(30).optional(),
    pickyAvoidances: z.array(z.string().max(60)).max(60).optional(),
    spiceTolerance: z.enum(["mild", "medium", "hot", "very_hot"]).optional(),
    healthGoals: z.array(z.string().max(60)).max(30).optional(),
    budgetLevel: z.enum(["economy", "mid_range", "premium"]).optional(),
    cookingEquipment: z.array(z.string().max(60)).max(60).optional(),
    recurringGroceryItems: z.array(z.string().max(80)).max(60).optional(),
    planLengthDefault: z.number().int().min(1).max(7).optional(),
    defaultRetailer: z.string().max(120).nullable().optional(),
    dietaryNotes: z.string().max(500).nullable().optional(),
    // Cookbook Phase B Block 1 — new preference fields. maxCookTimeMinutes
    // stays a permissive nullable int (the 30/45/60/null UI gate is Block 3);
    // the others are value-set-validated here since the DB stores plain int/String.
    discoveryMealsPerWeek: z.number().int().min(0).max(2).optional(),
    saucePreference: z.enum(["store_bought", "balanced", "homemade"]).optional(),
    maxCookTimeMinutes: z.number().int().nullable().optional(),
    maxCookTimeCoverage: z.enum(["all", "most"]).optional(),
  })
  .strict();

// WS9 3d Part 2c (D-WS9-013) — the ALLERGY/DIETARY subset of the preferences
// accept list. A PATCH touching ANY of these stamps UserPreferences.
// dietaryUpdatedAt (the staleness-note anchor); a PATCH touching only other
// fields must NOT (household size / retailer / cook-time edits are not
// allergy-relevant, and the note is allergy/restriction-worded). Deliberately
// EXCLUDES healthGoals and spiceTolerance: a spice-tolerance change must not
// raise an allergy warning (chat-Claude's ratified Phase-0 recommendation —
// if Hans amends the set, it is a one-line change here + its boundary tests).
const DIETARY_STAMP_FIELDS = [
  "allergiesAndAvoidances",
  "dietaryNotes",
  "eatingStyles",
  "pickyAvoidances",
] as const;

// WS9 3d Part 3c-2 (BUG-055) — the mobile preferences screen AUTO-SAVES the
// WHOLE form on every edit (preferences.tsx sends every field), so the four
// DIETARY_STAMP_FIELDS keys are present in essentially every PATCH regardless
// of what the user actually touched. A presence-only stamp therefore re-stamped
// dietaryUpdatedAt on a spice-tolerance / household / equipment edit, marking
// every plan dietarily stale. The stamp must fire on a VALUE change, not mere
// key presence; the server owns this judgment (the client keeps sending the
// full form). Array fields compare order-insensitively — reordering an allergy
// list is not a dietary change.
type StoredDietary = {
  allergiesAndAvoidances: string[];
  eatingStyles: string[];
  pickyAvoidances: string[];
  dietaryNotes: string | null;
};

function arraysEqualUnordered(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function dietaryFieldChanged(
  field: (typeof DIETARY_STAMP_FIELDS)[number],
  updates: Record<string, unknown>,
  stored: StoredDietary,
): boolean {
  if (!(field in updates)) return false;
  const next = updates[field];
  if (field === "dietaryNotes") {
    // Nullable string; normalize undefined→null so a `dietaryNotes: null` clear
    // against a stored null is a no-op, while clearing a real note is a change.
    return (next ?? null) !== stored.dietaryNotes;
  }
  const storedArr =
    field === "allergiesAndAvoidances"
      ? stored.allergiesAndAvoidances
      : field === "eatingStyles"
        ? stored.eatingStyles
        : stored.pickyAvoidances;
  const nextArr = Array.isArray(next) ? (next as string[]) : [];
  return !arraysEqualUnordered(nextArr, storedArr);
}

function serializePreferences(p: {
  id: string;
  userId: string;
  updatedAt: Date;
  [k: string]: unknown;
}) {
  return { ...p, updatedAt: p.updatedAt.toISOString() };
}

// ── WS7-3 A2: catalog-read helpers (GET /me/meals, GET /me/dishes) ──────────
// parseFilterParam / clampLimit / mergeById / paginateById are shared with
// GET /plans — see ../lib/listQuery.

// GET /me/dishes list shape. Mirrors the GET /meals renamed-flat convention
// (minutes / servings / bare macros / image). Dish has no cuisineType, so no
// `cuisine`; `difficulty` is surfaced since it is intrinsic to a Dish.
export interface DishListItem {
  id: string;
  title: string;
  minutes: number;
  servings: number;
  difficulty: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  tags: string[];
  image: string | null;
  // WS7-6 B-fix Block 2: number of MealDishLink rows referencing this dish —
  // the source for the DishChooserSheet "Used in N meals" label and the
  // `sort=times_cooked` ranking. WS7-6 B-fix Block 3 (Hans's June 9 ruling):
  // counts links to LIVE meals only (`meal.isArchived: false`). Archived
  // meals keep their MealDishLink rows (Phase 0.3, Block 2), but a stale
  // draft would read as "used in a meal I can't find", so it's excluded.
  mealUseCount: number;
}

// WS7-6 B-fix Block 1: `createdAt` is selected (not emitted on wire) so the
// keyset cursor for `sort=date_created` can encode the row's createdAt value.
// WS7-6 B-fix Block 2: `_count.mealLinks` is selected for both the wire field
// and the `sort=times_cooked` keyset value. `toDishListShape` ignores the
// extra `createdAt` field.
// WS7-6 B-fix Block 3: the count is FILTERED to live meals only
// (`meal.isArchived: false`) per Hans's June 9 ruling. Prisma 6.19.3 supports
// a filtered relation count in `select` (probe 0.2a) — but NOT in `orderBy`
// (probe 0.2b), so `sort=times_cooked` ranks in memory off this same value.
const DISH_LIST_SELECT = {
  id: true,
  title: true,
  estimatedTimeMinutes: true,
  servingsDefault: true,
  difficulty: true,
  caloriesPerServing: true,
  proteinGPerServing: true,
  carbsGPerServing: true,
  fatGPerServing: true,
  tags: true,
  imageUrl: true,
  createdAt: true,
  _count: { select: { mealLinks: { where: { meal: { isArchived: false } } } } },
} as const;

interface DishListRow {
  id: string;
  title: string;
  estimatedTimeMinutes: number;
  servingsDefault: number;
  difficulty: string;
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  tags: string[];
  imageUrl: string | null;
  createdAt: Date;
  _count: { mealLinks: number };
}

function toDishListShape(d: DishListRow): DishListItem {
  return {
    id: d.id,
    title: d.title,
    minutes: d.estimatedTimeMinutes,
    servings: d.servingsDefault,
    difficulty: d.difficulty,
    calories: d.caloriesPerServing,
    protein: d.proteinGPerServing,
    carbs: d.carbsGPerServing,
    fat: d.fatGPerServing,
    tags: d.tags,
    image: d.imageUrl,
    mealUseCount: d._count.mealLinks,
  };
}

// ── WS7-6 Block 2: save-canonical input schemas ────────────────────────
// Mode A ParsedMeal, manual Mode B, and Mode C combined builds all coerce
// to this shape on the client before posting. The materializeMeal /
// materializeDish helpers (../lib/mealMaterialize.ts) consume the parsed
// output and write the row graph.

const macrosPerServingSchema = z
  .object({
    caloriesPerServing: z.number().nonnegative().max(10000).optional(),
    proteinGPerServing: z.number().nonnegative().max(1000).optional(),
    carbsGPerServing: z.number().nonnegative().max(1000).optional(),
    fatGPerServing: z.number().nonnegative().max(1000).optional(),
  })
  .strict();

const ingredientItemSchema = z
  .object({
    name: z.string().min(1).max(120),
    quantity: z.number().positive().max(10000),
    unit: z.string().min(1).max(40),
    preparationNote: z.string().max(200).nullable().optional(),
    isOptional: z.boolean().optional(),
  })
  .strict();

const stepItemSchema = z
  .object({
    text: z.string().min(1).max(500),
    estimatedMinutes: z.number().int().positive().max(600).optional(),
    phaseType: z
      .enum(["prep", "preheat", "cook", "rest", "assemble", "hold"])
      .optional(),
    // BUG-018 (WS7-8b B1) — parallelGroup retired from the write side. Dropped
    // from this .strict() save-canonical contract so it can't be set-then-
    // silently-discarded at the materialize boundary (BUG-029 class). The
    // mobile save payload never sent it; the DB column stays, unwritten.
    isTimingSensitive: z.boolean().optional(),
  })
  .strict();

const dishRoleEnum = z.enum([
  "main",
  "side",
  "sauce",
  "topping",
  "base",
  "optional",
]);

const newDishSchema = z
  .object({
    kind: z.literal("new"),
    title: z.string().min(1).max(200),
    role: dishRoleEnum,
    positionIndex: z.number().int().nonnegative().max(20),
    estimatedTimeMinutes: z.number().int().positive().max(600).optional(),
    difficulty: z.enum(["easy", "medium", "fancy"]).optional(),
    servingsDefault: z.number().int().positive().max(99).optional(),
    ingredients: z.array(ingredientItemSchema).min(1).max(40),
    steps: z.array(stepItemSchema).max(30),
    macros: macrosPerServingSchema.optional(),
  })
  .strict();

const linkDishSchema = z
  .object({
    kind: z.literal("link"),
    dishId: z.string().min(1).max(100),
    role: dishRoleEnum,
    positionIndex: z.number().int().nonnegative().max(20),
  })
  .strict();

const dishEntrySchema = z.discriminatedUnion("kind", [
  newDishSchema,
  linkDishSchema,
]);

const postMeMealSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    cuisineType: z.string().max(60).nullable().optional(),
    // Q2: omitted → "dinner" (Mode A has no mealType). Honored when supplied.
    mealType: z
      .enum(["breakfast", "lunch", "dinner", "snack", "mixed"])
      .optional(),
    servingsDefault: z.number().int().positive().max(99).optional(),
    estimatedTimeMinutes: z.number().int().positive().max(600).optional(),
    difficulty: z.enum(["easy", "medium", "fancy"]).optional(),
    tags: z.array(z.string().min(1).max(40)).max(10).optional(),
    sourceType: z.enum(["manual", "wizard", "directed", "curated"]).optional(),
    macros: macrosPerServingSchema.optional(),
    dishes: z.array(dishEntrySchema).min(1).max(5),
  })
  .strict();

const postMeDishSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    estimatedTimeMinutes: z.number().int().positive().max(600).optional(),
    difficulty: z.enum(["easy", "medium", "fancy"]).optional(),
    servingsDefault: z.number().int().positive().max(99).optional(),
    tags: z.array(z.string().min(1).max(40)).max(10).optional(),
    sourceType: z.enum(["manual", "wizard", "directed", "curated"]).optional(),
    macros: macrosPerServingSchema.optional(),
    ingredients: z.array(ingredientItemSchema).min(1).max(40),
    steps: z.array(stepItemSchema).max(30),
  })
  .strict();

// ── WS7-6 1A: PATCH schemas (edit surface) ─────────────────────────────
// Every field optional + at-least-one-field refinement so an empty patch
// fails with 400 instead of being a silent no-op.
//
// Patchable fields mirror PRD §8.4.4 (Meal Detail edit accept list) and
// §10.5/§8.4.5 (Dish edit). imageUrl is patchable: meal/dish image lives
// on the row, not behind a separate upload endpoint.
//
// dishes[] on the meal PATCH and ingredients[] / steps[] on the dish
// PATCH trigger the wipe-and-recreate path (see rematerializeMeal /
// rematerializeDish). Their absence keeps the sub-graph intact and the
// route falls back to a scalar-only update.

const patchMeMealSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    cuisineType: z.string().max(60).nullable().optional(),
    mealType: z
      .enum(["breakfast", "lunch", "dinner", "snack", "mixed"])
      .optional(),
    servingsDefault: z.number().int().positive().max(99).optional(),
    estimatedTimeMinutes: z.number().int().positive().max(600).optional(),
    difficulty: z.enum(["easy", "medium", "fancy"]).optional(),
    tags: z.array(z.string().min(1).max(40)).max(10).optional(),
    imageUrl: z.string().max(2048).nullable().optional(),
    macros: macrosPerServingSchema.optional(),
    dishes: z.array(dishEntrySchema).min(1).max(5).optional(),
    // WS7-7-A Block 5 (D2) — "apply every time" from inside a plan. When set,
    // bump THIS plan instance's revisionId in the same transaction as the meal
    // edit so the current plan's grocery list reconciles to the edited global
    // meal (which the plan reads live). Absent → a plain library edit, no plan
    // touched (preserves D-WS7-136 forward-only behavior for incidental edits).
    // Only the current plan is bumped — other plans keep their snapshot.
    bumpPlanId: z.string().min(1).max(100).optional(),
  })
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "patch must include at least one field",
  });

const patchMeDishSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    estimatedTimeMinutes: z.number().int().positive().max(600).optional(),
    difficulty: z.enum(["easy", "medium", "fancy"]).optional(),
    servingsDefault: z.number().int().positive().max(99).optional(),
    tags: z.array(z.string().min(1).max(40)).max(10).optional(),
    imageUrl: z.string().max(2048).nullable().optional(),
    macros: macrosPerServingSchema.optional(),
    ingredients: z.array(ingredientItemSchema).min(1).max(40).optional(),
    steps: z.array(stepItemSchema).max(30).optional(),
  })
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "patch must include at least one field",
  });

// WS7-7-A Block 5 (D2) — ownership-checked plan-revision bump for the
// "apply every time" path. bumpPlanRevision is id-only, so we gate on
// ownership here: a missing or foreign-owned bumpPlanId is silently skipped
// (the global meal edit still succeeds and no other user's plan is touched).
// Runs inside the meal-edit transaction so the bump is atomic with the edit.
async function bumpCurrentPlanRevision(
  tx: Prisma.TransactionClient,
  planId: string,
  userId: string,
): Promise<void> {
  const owned = await tx.mealPlanInstance.findFirst({
    where: { id: planId, userId },
    select: { id: true },
  });
  if (owned) {
    await bumpPlanRevision(planId, tx);
  }
}

// Per-user mutation token bucket — same posture as POST /plans
// (mutationLimiter at 12/min from plans.ts). Save-canonical is editing
// cadence, not a discovery read.
const saveMutationLimiter = rateLimit({
  capacity: 12,
  refillPerSec: 12 / 60,
});

export interface MeRouterDeps {
  prisma: PrismaClient;
}

export function createMeRouter(deps: Partial<MeRouterDeps> = {}): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const router: IRouter = Router();

  // PATCH /me/ui-state
  router.patch("/me/ui-state", requireAuth, async (req, res) => {
    const parsed = uiStateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid body",
        details: parsed.error.flatten(),
      });
    }
    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "no fields to update" });
    }

    try {
      await prisma.user.update({
        where: { id: req.userId },
        data: updates,
      });
      return res.json({ ok: true });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "PATCH /me/ui-state failed");
      return res.status(500).json({ error: "failed to update ui state" });
    }
  });

  // ── Profile + password ───────────────────────────────────────────────

  // PATCH /me/profile — firstName / lastName / phone. At-least-one-field.
  router.patch("/me/profile", requireAuth, async (req, res) => {
    const parsed = profilePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid body",
        details: parsed.error.flatten(),
      });
    }
    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "no fields to update" });
    }

    try {
      const updated = await prisma.user.update({
        where: { id: req.userId },
        data: updates,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          zipCode: true,
          timezone: true,
          accountStatus: true,
          subscriptionStatus: true,
          defaultHouseholdSize: true,
          lastPlanDiscoveryFilters: true,
          lastPlansFilters: true,
          lastMealsFilters: true,
          marketingConsentEmail: true,
          marketingConsentSms: true,
          onboardingComplete: true,
          firstRunChoiceMade: true,
          createdAt: true,
        },
      });
      return res.json({
        user: { ...updated, createdAt: updated.createdAt.toISOString() },
      });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "PATCH /me/profile failed");
      return res.status(500).json({ error: "failed to update profile" });
    }
  });

  // PATCH /me/password — bcrypt-compare currentPassword, then update.
  router.patch(
    "/me/password",
    requireAuth,
    passwordChangeLimiter,
    async (req, res) => {
      const parsed = passwordPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid body",
          details: parsed.error.flatten(),
        });
      }
      const { currentPassword, newPassword } = parsed.data;

      try {
        const user = await prisma.user.findUnique({
          where: { id: req.userId },
          select: { id: true, passwordHash: true },
        });
        if (!user || !user.passwordHash) {
          return res.status(401).json({ error: "user not found" });
        }

        const ok = await verifyPassword(currentPassword, user.passwordHash);
        if (!ok) {
          return res.status(400).json({
            error: "invalid_current_password",
            userFacingMessage: "Current password is incorrect",
          });
        }

        const newHash = await hashPassword(newPassword);
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordHash: newHash },
        });
        logger.info({ userId: user.id }, "Password changed via /me/password");
        return res.json({ success: true });
      } catch (err) {
        logger.error({ err, userId: req.userId }, "PATCH /me/password failed");
        return res.status(500).json({ error: "failed to change password" });
      }
    },
  );

  // ── Email change (two-step, JWT-mediated) ───────────────────────────
  // D-WS7-022: real email delivery infra deferred to WS9A polish.
  // For now the verification URL is logged to the server console (same
  // pattern as password-reset).

  // POST /me/email/request-change — mints a purpose='email_change' token
  // with { newEmail } and logs the verification URL. Always returns
  // success (after Zod body validation) to deter enumeration via timing
  // or status differences.
  router.post(
    "/me/email/request-change",
    requireAuth,
    emailRequestLimiter,
    async (req, res) => {
      const parsed = emailRequestChangeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid request body" });
      }
      const newEmail = parsed.data.newEmail.toLowerCase().trim();

      try {
        const [currentUser, existing] = await Promise.all([
          prisma.user.findUnique({
            where: { id: req.userId },
            select: { id: true, email: true },
          }),
          prisma.user.findUnique({
            where: { email: newEmail },
            select: { id: true },
          }),
        ]);

        // Only mint a token when the change is meaningful AND the address
        // is free. Both branches still return 200 so an attacker can't
        // tell which case applies.
        if (
          currentUser &&
          currentUser.email !== newEmail &&
          (!existing || existing.id === currentUser.id)
        ) {
          const verifyTokenStr = signToken(currentUser.id, {
            purpose: "email_change",
            expiresIn: EMAIL_CHANGE_EXPIRY,
            extra: { newEmail },
          });
          logger.info(
            {
              userId: currentUser.id,
              newEmail,
              verifyToken: verifyTokenStr,
              verifyUrl: `kiwi://verify-email?token=${verifyTokenStr}`,
            },
            "Email change requested — would email this URL to newEmail",
          );
        }
        return res.json({ success: true });
      } catch (err) {
        logger.error({ err, userId: req.userId }, "POST /me/email/request-change failed");
        // Match the auth.ts reset pattern: still 200 to avoid leaking
        // failure timing.
        return res.json({ success: true });
      }
    },
  );

  // POST /me/email/verify-change — auth NOT required; the JWT IS the auth.
  router.post("/me/email/verify-change", async (req, res) => {
    const parsed = emailVerifyChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid_request",
        userFacingMessage: "This link is invalid or has expired.",
      });
    }
    const payload = verifyToken(parsed.data.token, "email_change");
    if (!payload || typeof payload.newEmail !== "string") {
      return res.status(400).json({
        error: "invalid_token",
        userFacingMessage: "This link is invalid or has expired.",
      });
    }
    const newEmail = payload.newEmail.toLowerCase().trim();

    try {
      // Race: another account may have grabbed this address between
      // request and verify. The unique constraint on User.email also
      // protects us; we check first for a clearer error.
      const conflict = await prisma.user.findUnique({
        where: { email: newEmail },
        select: { id: true },
      });
      if (conflict && conflict.id !== payload.userId) {
        return res.status(400).json({
          error: "email_taken",
          userFacingMessage: "That email is already registered to another account.",
        });
      }

      await prisma.user.update({
        where: { id: payload.userId },
        data: { email: newEmail },
      });
      logger.info({ userId: payload.userId, newEmail }, "Email change verified");
      return res.json({ success: true, email: newEmail });
    } catch (err) {
      logger.error({ err, userId: payload.userId }, "POST /me/email/verify-change failed");
      return res.status(500).json({ error: "failed to verify email change" });
    }
  });

  // ── Preferences ──────────────────────────────────────────────────────

  // GET /me/preferences — returns the user's prefs row. Creates one with
  // defaults on first fetch (idempotent), so mobile never sees a 404 here.
  router.get("/me/preferences", requireAuth, async (req, res) => {
    try {
      let prefs = await prisma.userPreferences.findUnique({
        where: { userId: req.userId },
      });
      if (!prefs) {
        prefs = await prisma.userPreferences.create({
          data: { userId: req.userId! },
        });
      }
      return res.json({ preferences: serializePreferences(prefs) });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "GET /me/preferences failed");
      return res.status(500).json({ error: "failed to fetch preferences" });
    }
  });

  // PATCH /me/preferences — upsert with explicit Zod accept list.
  router.patch("/me/preferences", requireAuth, async (req, res) => {
    const parsed = preferencesPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      // Log the Zod rejection so a `.strict()` allow-list mismatch (e.g. a
      // client PATCHing a server-only column like weeklyPacingDefault) is a
      // one-line read instead of a silent device-side 400. `fieldErrors` keys
      // are the offending paths; `errors` carries top-level issues like
      // unrecognized_keys from `.strict()`.
      const flat = parsed.error.flatten();
      logger.warn(
        {
          event: "me_preferences_patch_invalid",
          userId: req.userId,
          fieldErrors: Object.keys(flat.fieldErrors),
          formErrors: flat.formErrors,
          issues: parsed.error.issues
            .slice(0, 5)
            .map((i) => ({ code: i.code, path: i.path, message: i.message })),
        },
        "PATCH /me/preferences rejected at validation",
      );
      return res.status(400).json({
        error: "invalid body",
        details: flat,
      });
    }
    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "no fields to update" });
    }

    // WS9 3d Part 3c-2 (BUG-055, was D-WS9-013) — stamp dietaryUpdatedAt only
    // when a present allergy/dietary field's VALUE differs from the stored row,
    // not on mere key presence (the mobile screen auto-saves the full form, so
    // the dietary keys ride along on EVERY edit). Read the current dietary values
    // first; a missing row (first save) compares against the schema defaults
    // (empty arrays / null notes) so an initial dietary entry still stamps. Not
    // derived from `updatedAt`, which @updatedAt bumps on every write.
    const existing = await prisma.userPreferences.findUnique({
      where: { userId: req.userId! },
      select: {
        allergiesAndAvoidances: true,
        eatingStyles: true,
        pickyAvoidances: true,
        dietaryNotes: true,
      },
    });
    const storedDietary: StoredDietary = existing ?? {
      allergiesAndAvoidances: [],
      eatingStyles: [],
      pickyAvoidances: [],
      dietaryNotes: null,
    };
    const touchesDietary = DIETARY_STAMP_FIELDS.some((f) =>
      dietaryFieldChanged(f, updates, storedDietary),
    );
    const data = touchesDietary
      ? { ...updates, dietaryUpdatedAt: new Date() }
      : updates;

    try {
      const prefs = await prisma.userPreferences.upsert({
        where: { userId: req.userId! },
        update: data,
        create: { userId: req.userId!, ...data },
      });
      return res.json({ preferences: serializePreferences(prefs) });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "PATCH /me/preferences failed");
      return res.status(500).json({ error: "failed to update preferences" });
    }
  });

  // ── Deactivate / reactivate ─────────────────────────────────────────
  // Per WS7-2 Block A locked decision 2, deactivation reuses User columns:
  //   { accountStatus: 'paused', customerEndDate: now() }
  // Reactivation flips back within the 6-month TTL; past that the account is
  // out of reach until the future permanent-deletion cron + support flow.

  // POST /me/deactivate — auth required, idempotent.
  router.post("/me/deactivate", requireAuth, async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { id: true, accountStatus: true },
      });
      if (!user) {
        return res.status(401).json({ error: "user not found" });
      }
      if (user.accountStatus === "deleted" || user.accountStatus === "blocked") {
        return res.status(400).json({
          error: "cannot_deactivate",
          userFacingMessage: "This account cannot be deactivated.",
        });
      }
      if (user.accountStatus === "paused") {
        // Idempotent — already paused, nothing to do.
        return res.json({ success: true });
      }

      await prisma.$transaction([
        prisma.user.update({
          where: { id: user.id },
          data: {
            accountStatus: "paused",
            customerEndDate: new Date(),
          },
        }),
        prisma.mealPlanInstance.updateMany({
          where: {
            userId: user.id,
            status: { in: [...ACTIVE_PLAN_STATUSES] },
          },
          data: { status: "past" },
        }),
      ]);

      logger.info({ userId: user.id }, "Account deactivated");
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "POST /me/deactivate failed");
      return res.status(500).json({ error: "failed to deactivate account" });
    }
  });

  // POST /me/reactivate — public; takes credentials and flips the status.
  router.post("/me/reactivate", reactivateLimiter, async (req, res) => {
    const parsed = reactivateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const { email, password } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    try {
      const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: { subscription: true },
      });
      // Same generic 401 for unknown user vs wrong password — no enumeration.
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: "invalid credentials" });
      }
      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "invalid credentials" });
      }

      if (user.accountStatus !== "paused") {
        return res.status(400).json({
          error: "not_paused",
          userFacingMessage: "This account cannot be reactivated.",
        });
      }
      const endedAt = user.customerEndDate;
      if (!endedAt || Date.now() - endedAt.getTime() > REACTIVATION_TTL_MS) {
        return res.status(400).json({
          error: "reactivation_window_expired",
          userFacingMessage:
            "The reactivation window has expired. Please contact support.",
        });
      }

      const reactivated = await prisma.user.update({
        where: { id: user.id },
        data: {
          accountStatus: "active",
          customerEndDate: null,
        },
        include: { subscription: true },
      });
      const authToken = signToken(reactivated.id);
      logger.info({ userId: reactivated.id }, "Account reactivated");
      return res.json({
        user: {
          id: reactivated.id,
          email: reactivated.email,
          firstName: reactivated.firstName,
          lastName: reactivated.lastName,
          phone: reactivated.phone,
          zipCode: reactivated.zipCode,
          timezone: reactivated.timezone,
          accountStatus: reactivated.accountStatus,
          subscriptionStatus: reactivated.subscriptionStatus,
          defaultHouseholdSize: reactivated.defaultHouseholdSize,
          lastPlanDiscoveryFilters: reactivated.lastPlanDiscoveryFilters,
          lastPlansFilters: reactivated.lastPlansFilters,
          lastMealsFilters: reactivated.lastMealsFilters,
          onboardingComplete: reactivated.onboardingComplete,
          firstRunChoiceMade: reactivated.firstRunChoiceMade,
          createdAt: reactivated.createdAt.toISOString(),
          subscription: reactivated.subscription
            ? {
                status: reactivated.subscription.status,
                planCode: reactivated.subscription.planCode,
                trialEndsAt: reactivated.subscription.trialEndsAt
                  ? reactivated.subscription.trialEndsAt.toISOString()
                  : null,
                currentPeriodEnd: reactivated.subscription.currentPeriodEnd
                  ? reactivated.subscription.currentPeriodEnd.toISOString()
                  : null,
              }
            : null,
        },
        authToken,
      });
    } catch (err) {
      logger.error({ err }, "POST /me/reactivate failed");
      return res.status(500).json({ error: "failed to reactivate account" });
    }
  });

  // ── Favorites ────────────────────────────────────────────────────────
  // WS7-2 Block A. Mobile AsyncStorage cache discarded on first launch
  // post-Block-B (Phase 1 locked decision 7) — server is source of truth.

  // POST /me/favorites
  router.post("/me/favorites", requireAuth, async (req, res) => {
    const parsed = favoriteCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid body" });
    }
    const { mealId } = parsed.data;

    try {
      const meal = await prisma.meal.findUnique({
        where: { id: mealId },
        select: { id: true },
      });
      if (!meal) {
        return res.status(404).json({ error: "meal not found" });
      }

      // Idempotent: unique (userId, mealId) — upsert returns the existing row
      // on conflict instead of failing.
      const favorite = await prisma.favorite.upsert({
        where: {
          userId_mealId: { userId: req.userId!, mealId },
        },
        update: {},
        create: { userId: req.userId!, mealId },
        select: { id: true, mealId: true, createdAt: true },
      });

      return res.status(201).json({
        favorite: {
          id: favorite.id,
          mealId: favorite.mealId,
          createdAt: favorite.createdAt.toISOString(),
        },
      });
    } catch (err) {
      logger.error({ err, userId: req.userId, mealId }, "POST /me/favorites failed");
      return res.status(500).json({ error: "failed to add favorite" });
    }
  });

  // DELETE /me/favorites/:mealId — idempotent (no 404 when absent).
  router.delete("/me/favorites/:mealId", requireAuth, async (req, res) => {
    const mealId = req.params.mealId;
    if (!mealId || typeof mealId !== "string") {
      return res.status(400).json({ error: "mealId required" });
    }

    try {
      await prisma.favorite.deleteMany({
        where: { userId: req.userId!, mealId },
      });
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err, userId: req.userId, mealId }, "DELETE /me/favorites failed");
      return res.status(500).json({ error: "failed to remove favorite" });
    }
  });

  // GET /me/favorites — newest first.
  router.get("/me/favorites", requireAuth, async (req, res) => {
    try {
      const rows = await prisma.favorite.findMany({
        where: { userId: req.userId },
        orderBy: { createdAt: "desc" },
        select: { mealId: true },
      });
      return res.json({ favorites: rows.map((r) => r.mealId) });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "GET /me/favorites failed");
      return res.status(500).json({ error: "failed to fetch favorites" });
    }
  });

  // ── Save-canonical (WS7-6 Block 2) ───────────────────────────────────
  // POST /me/meals + POST /me/dishes — write the row graph for a meal
  // built / parsed in the mobile builder. Both routes are FREE tier; the
  // premium gate lives only on Mode A *parsing* (POST /builder/parse-meal
  // — see routes/builder.ts:194-208), not on save.

  // POST /me/meals — manual-built meal or Mode-C combined meal (Q1 link
  // path uses dishes[].kind === "link" with an existing dishId).
  router.post(
    "/me/meals",
    requireAuth,
    saveMutationLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      const parsed = postMeMealSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid body",
          details: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      // For "link" dishes (Q1 Mode-C), verify each referenced dish exists
      // and is either owned by the user or has no owner (curated /
      // featured catalog dishes). A 404 on a missing link target is
      // clearer than letting the tx hit an FK violation.
      const linkDishIds = body.dishes
        .filter((d): d is Extract<typeof d, { kind: "link" }> =>
          d.kind === "link",
        )
        .map((d) => d.dishId);

      if (linkDishIds.length > 0) {
        const found = await prisma.dish.findMany({
          where: { id: { in: linkDishIds }, isArchived: false },
          select: { id: true, userId: true },
        });
        const foundIds = new Set(found.map((d) => d.id));
        const missing = linkDishIds.filter((id) => !foundIds.has(id));
        if (missing.length > 0) {
          return res.status(404).json({
            error: "linked dish(es) not found",
            missing,
          });
        }
        // Ownership: a dish is linkable when it is the user's own dish OR
        // an unowned catalog dish (userId === null). Anyone else's dish
        // is not linkable.
        const forbidden = found
          .filter((d) => d.userId !== null && d.userId !== userId)
          .map((d) => d.id);
        if (forbidden.length > 0) {
          return res.status(403).json({
            error: "linked dish(es) not owned by user",
            forbidden,
          });
        }
      }

      try {
        // WS7-6 Fix-Block 1A (P2028): resolve ingredients BEFORE opening the
        // tx. Each upsert is its own DB roundtrip; awaiting them inside
        // $transaction counted them against the 5000ms budget. See module-
        // header comment in mealMaterialize.ts.
        const payload = {
          ...body,
          dishes: body.dishes as MaterializeMealDish[],
        };
        const mentions = collectMealMentions(payload);
        const ingredientIdByCanonical = await resolveIngredients(
          prisma,
          mentions,
        );
        const result = await prisma.$transaction(
          async (tx) =>
            materializeMeal(tx, userId, payload, ingredientIdByCanonical),
          { timeout: 15000 },
        );
        return res.status(201).json({
          meal: {
            id: result.mealId,
            dishIds: result.dishIds,
            linksCreated: result.linksCreated,
          },
        });
      } catch (err) {
        logger.error({ err, userId }, "POST /me/meals failed");
        return res.status(500).json({ error: "failed to create meal" });
      }
    },
  );

  // POST /me/dishes — standalone Dish (no Meal wrapper). Same resolver
  // path as POST /me/meals for ingredients; steps use polymorphic
  // ownerType="dish".
  router.post(
    "/me/dishes",
    requireAuth,
    saveMutationLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      const parsed = postMeDishSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid body",
          details: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      try {
        // WS7-6 Fix-Block 1A (P2028): hoist Pass 1 out of $transaction.
        const mentions = collectDishMentions(body);
        const ingredientIdByCanonical = await resolveIngredients(
          prisma,
          mentions,
        );
        const result = await prisma.$transaction(
          async (tx) =>
            materializeDish(tx, userId, body, ingredientIdByCanonical),
          { timeout: 15000 },
        );
        return res.status(201).json({ dish: { id: result.dishId } });
      } catch (err) {
        logger.error({ err, userId }, "POST /me/dishes failed");
        return res.status(500).json({ error: "failed to create dish" });
      }
    },
  );

  // ── PATCH /me/meals/:id — WS7-6 1A ──────────────────────────────────
  // Library-context global edit (PRD §8.4.4) AND the §2.5 "Apply always"
  // branch from a plan-context Meal Builder edit. Owner-gated; archived
  // and curated/null-owner meals are not patchable by a user.
  //
  // dishes[] in the body triggers wipe-and-recreate via rematerializeMeal;
  // its absence keeps the sub-graph intact and the route does a scalar-
  // only meal.update.
  router.patch(
    "/me/meals/:id",
    requireAuth,
    saveMutationLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const mealId = req.params.id;
      if (typeof mealId !== "string" || mealId.length === 0 || mealId.length > 100) {
        return res.status(400).json({ error: "invalid meal id" });
      }

      const parsed = patchMeMealSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid body",
          details: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      // Owner gate — 404 for missing/archived, 403 for foreign-owned or
      // curated (userId: null) meals. Mirrors the link-dish ownership
      // gate at POST /me/meals.
      const meal = await prisma.meal.findUnique({
        where: { id: mealId },
        select: { id: true, userId: true, isArchived: true },
      });
      if (!meal || meal.isArchived) {
        return res.status(404).json({ error: "meal not found" });
      }
      if (meal.userId === null || meal.userId !== userId) {
        return res.status(403).json({ error: "meal not owned by user" });
      }

      // For "link" dishes in the new payload — verify each exists and is
      // owned-or-catalog. Same gate as POST /me/meals.
      if (body.dishes) {
        const linkDishIds = body.dishes
          .filter((d): d is Extract<typeof d, { kind: "link" }> =>
            d.kind === "link",
          )
          .map((d) => d.dishId);

        if (linkDishIds.length > 0) {
          const found = await prisma.dish.findMany({
            where: { id: { in: linkDishIds }, isArchived: false },
            select: { id: true, userId: true },
          });
          const foundIds = new Set(found.map((d) => d.id));
          const missing = linkDishIds.filter((id) => !foundIds.has(id));
          if (missing.length > 0) {
            return res.status(404).json({
              error: "linked dish(es) not found",
              missing,
            });
          }
          const forbidden = found
            .filter((d) => d.userId !== null && d.userId !== userId)
            .map((d) => d.id);
          if (forbidden.length > 0) {
            return res.status(403).json({
              error: "linked dish(es) not owned by user",
              forbidden,
            });
          }
        }
      }

      try {
        if (body.dishes) {
          // Full wipe-and-recreate path.
          // WS7-6 Fix-Block 1A (P2028): the device-test cluster surfaced a
          // 5045ms / 5000ms tx timeout here on cold paths because the N
          // ingredient upserts ran inside $transaction. Resolve them first.
          const payload = {
            ...body,
            dishes: body.dishes as MaterializeMealDish[],
          };
          const mentions = collectMealMentions(payload);
          const ingredientIdByCanonical = await resolveIngredients(
            prisma,
            mentions,
          );
          const result = await prisma.$transaction(
            async (tx) => {
              const materialized = await rematerializeMeal(
                tx,
                userId,
                mealId,
                payload,
                ingredientIdByCanonical,
              );
              // WS7-7-A Block 5 — "apply every time" current-plan bump, atomic
              // with the meal edit so there's no window where the meal updated
              // but the plan's grocery list didn't reconcile.
              if (body.bumpPlanId) {
                await bumpCurrentPlanRevision(tx, body.bumpPlanId, userId);
              }
              return materialized;
            },
            { timeout: 15000 },
          );
          return res.json({
            meal: {
              id: result.mealId,
              dishIds: result.dishIds,
              linksCreated: result.linksCreated,
            },
          });
        }

        // Scalar-only patch — no wipe, no tx (single update).
        const scalarUpdate: Record<string, unknown> = {};
        if (body.title !== undefined) scalarUpdate.title = body.title;
        if (body.description !== undefined)
          scalarUpdate.description = body.description;
        if (body.cuisineType !== undefined)
          scalarUpdate.cuisineType = body.cuisineType;
        if (body.mealType !== undefined) scalarUpdate.mealType = body.mealType;
        if (body.servingsDefault !== undefined)
          scalarUpdate.servingsDefault = body.servingsDefault;
        if (body.estimatedTimeMinutes !== undefined)
          scalarUpdate.estimatedTimeMinutes = body.estimatedTimeMinutes;
        if (body.difficulty !== undefined)
          scalarUpdate.difficulty = body.difficulty;
        if (body.tags !== undefined) scalarUpdate.tags = body.tags;
        if (body.imageUrl !== undefined) scalarUpdate.imageUrl = body.imageUrl;
        if (body.macros) {
          if (body.macros.caloriesPerServing !== undefined)
            scalarUpdate.caloriesPerServing = body.macros.caloriesPerServing;
          if (body.macros.proteinGPerServing !== undefined)
            scalarUpdate.proteinGPerServing = body.macros.proteinGPerServing;
          if (body.macros.carbsGPerServing !== undefined)
            scalarUpdate.carbsGPerServing = body.macros.carbsGPerServing;
          if (body.macros.fatGPerServing !== undefined)
            scalarUpdate.fatGPerServing = body.macros.fatGPerServing;
        }
        // WS7-7-A Block 5 — a scalar-only "apply every time" (e.g. servings
        // default) still bumps the current plan; wrap update + bump in one tx.
        if (body.bumpPlanId) {
          const bumpPlanId = body.bumpPlanId;
          await prisma.$transaction(async (tx) => {
            await tx.meal.update({ where: { id: mealId }, data: scalarUpdate });
            await bumpCurrentPlanRevision(tx, bumpPlanId, userId);
          });
        } else {
          await prisma.meal.update({
            where: { id: mealId },
            data: scalarUpdate,
          });
        }
        return res.json({ meal: { id: mealId } });
      } catch (err) {
        logger.error({ err, userId, mealId }, "PATCH /me/meals/:id failed");
        return res.status(500).json({ error: "failed to update meal" });
      }
    },
  );

  // ── PATCH /me/dishes/:id — WS7-6 1A (closes D-WS7-086) ──────────────
  router.patch(
    "/me/dishes/:id",
    requireAuth,
    saveMutationLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const dishId = req.params.id;
      if (typeof dishId !== "string" || dishId.length === 0 || dishId.length > 100) {
        return res.status(400).json({ error: "invalid dish id" });
      }

      const parsed = patchMeDishSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid body",
          details: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      const dish = await prisma.dish.findUnique({
        where: { id: dishId },
        select: { id: true, userId: true, isArchived: true },
      });
      if (!dish || dish.isArchived) {
        return res.status(404).json({ error: "dish not found" });
      }
      if (dish.userId === null || dish.userId !== userId) {
        return res.status(403).json({ error: "dish not owned by user" });
      }

      const subgraphTouched =
        body.ingredients !== undefined || body.steps !== undefined;

      try {
        if (subgraphTouched) {
          // WS7-6 Fix-Block 1A (P2028): hoist Pass 1 out of $transaction.
          // Skip the upsert roundtrip entirely when the patch doesn't touch
          // ingredients (matches the previous in-helper short-circuit).
          const mentions = collectRematerializeDishMentions(body);
          const ingredientIdByCanonical =
            mentions.length > 0
              ? await resolveIngredients(prisma, mentions)
              : new Map<string, string>();
          await prisma.$transaction(
            async (tx) =>
              rematerializeDish(
                tx,
                userId,
                dishId,
                body,
                ingredientIdByCanonical,
              ),
            { timeout: 15000 },
          );
          return res.json({ dish: { id: dishId } });
        }

        // Scalar-only patch.
        const scalarUpdate: Record<string, unknown> = {};
        if (body.title !== undefined) scalarUpdate.title = body.title;
        if (body.description !== undefined)
          scalarUpdate.description = body.description;
        if (body.estimatedTimeMinutes !== undefined)
          scalarUpdate.estimatedTimeMinutes = body.estimatedTimeMinutes;
        if (body.difficulty !== undefined)
          scalarUpdate.difficulty = body.difficulty;
        if (body.servingsDefault !== undefined)
          scalarUpdate.servingsDefault = body.servingsDefault;
        if (body.tags !== undefined) scalarUpdate.tags = body.tags;
        if (body.imageUrl !== undefined) scalarUpdate.imageUrl = body.imageUrl;
        if (body.macros) {
          if (body.macros.caloriesPerServing !== undefined)
            scalarUpdate.caloriesPerServing = body.macros.caloriesPerServing;
          if (body.macros.proteinGPerServing !== undefined)
            scalarUpdate.proteinGPerServing = body.macros.proteinGPerServing;
          if (body.macros.carbsGPerServing !== undefined)
            scalarUpdate.carbsGPerServing = body.macros.carbsGPerServing;
          if (body.macros.fatGPerServing !== undefined)
            scalarUpdate.fatGPerServing = body.macros.fatGPerServing;
          // D-WS9-050 Phase 2 — a user-typed macro is not a grounded estimate;
          // clear any stale grounding stamp so it isn't mistaken for grounded.
          scalarUpdate.macroGroundedPct = null;
        }
        await prisma.dish.update({
          where: { id: dishId },
          data: scalarUpdate,
        });
        return res.json({ dish: { id: dishId } });
      } catch (err) {
        logger.error({ err, userId, dishId }, "PATCH /me/dishes/:id failed");
        return res.status(500).json({ error: "failed to update dish" });
      }
    },
  );

  // ── Catalog reads — WS7-3 A2 ──────────────────────────────────────────
  // Multi-select OR filters. Each requested filter contributes a result
  // block; blocks concatenate in MEALS_FILTER_KEYS order and dedupe by id.
  // Cursor pagination matches GET /meals (opaque id cursor; see paginateById).

  // GET /me/meals?filter=my_meals,featured,top_rated,hosting&sort=<alpha|date_created|cook_time>
  //
  // WS7-6 G2 scope (iii): sort param + keyset cursor, transplanted from the
  // GET /me/dishes precedent (B-fix Block 1). Migrated OFF paginateById so a
  // newly-saved meal lands in the server-sorted page chain instead of being
  // hidden by a client-side re-sort of a stale first page. Sort options:
  // alpha (default), date_created, cook_time (meals minus the dish-only
  // times_cooked/last_cooked keys). id:asc tiebreaker on every sort;
  // unknown/malformed sort or cursor falls back to the first page. The
  // default-order (alpha) `meals` array is byte-identical to the
  // pre-migration output; only the opaque nextCursor changes shape (raw id
  // to base64url keyset cursor — an old raw-id cursor decodes to null and
  // yields the first page, so the round-trip stays safe). /plans keeps
  // paginateById (its envelope-merge shape differs).
  router.get("/me/meals", requireAuth, async (req, res) => {
    const parsed = parseFilterParam(req.query.filter, MEALS_FILTER_KEYS, [
      "my_meals",
    ]);
    if ("unknownValues" in parsed) {
      return res.status(400).json({
        error: "invalid filter value(s)",
        unknown: parsed.unknownValues,
        allowed: MEALS_FILTER_KEYS,
      });
    }
    const limit = clampLimit(req.query.limit);
    const sort = parseMealSortParam(req.query.sort);
    const cursor = decodeKeysetCursor(req.query.cursor);

    // id:asc is the stable tiebreaker for every sort. All three meal sorts
    // are expressible directly in a Prisma orderBy (no in-memory re-rank like
    // dishes' filtered times_cooked count needs).
    const orderBy: Prisma.MealOrderByWithRelationInput[] =
      sort === "date_created"
        ? [{ createdAt: "desc" }, { id: "asc" }]
        : sort === "cook_time"
          ? [{ estimatedTimeMinutes: "asc" }, { id: "asc" }]
          : [{ title: "asc" }, { id: "asc" }];

    try {
      const blocks: MealListRow[][] = [];
      for (const key of parsed.keys) {
        if (key === "my_meals") {
          const rows = await prisma.meal.findMany({
            where: { userId: req.userId, isArchived: false },
            select: MEAL_LIST_SELECT_SORTED,
            orderBy,
          });
          blocks.push(rows);
        } else if (key === "top_rated") {
          // No cached score on Meal — rank public meals by the un-decayed
          // weighted counter sum, capped at top_rated.display_count.
          const settings = await getTopRatedSettings(prisma);
          const rows = await prisma.meal.findMany({
            where: { isPublic: true, isArchived: false },
            select: {
              ...MEAL_LIST_SELECT_SORTED,
              saveCount: true,
              useCount: true,
            },
          });
          const ranked = rows
            .map((m) => ({
              m,
              score:
                m.saveCount * settings.saveWeight +
                m.useCount * settings.useWeight,
            }))
            .sort(
              (a, b) =>
                b.score - a.score || a.m.title.localeCompare(b.m.title),
            )
            .slice(0, settings.displayCount)
            .map((r) => r.m);
          blocks.push(ranked);
        } else {
          // key === "featured" | "hosting".
          // TODO(D-WS7-039): Meal carries no featuring flags — isFeatured /
          // featured*Date / isHostingFeatured live on MealPlanTemplate, not
          // Meal. Until a Meal-level curation flag exists these facets
          // resolve empty. See WS7-3 A2 Phase 3 report §8.
          blocks.push([]);
        }
      }
      const merged = mergeById(blocks);
      const getSortValue = (r: MealListRow): string | number => {
        switch (sort) {
          case "date_created":
            return r.createdAt.toISOString();
          case "cook_time":
            return r.estimatedTimeMinutes;
          case "alpha":
            return r.title;
        }
      };
      const { page, nextCursor } = paginateByKeyset(
        merged,
        cursor,
        limit,
        sort,
        getSortValue,
      );
      return res.json({ meals: page.map(toListShape), nextCursor });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "GET /me/meals failed");
      return res.status(500).json({ error: "failed to list meals" });
    }
  });

  // GET /me/dishes?filter=my_dishes,featured,top_rated&sort=<alpha|date_created|cook_time|times_cooked>
  //
  // WS7-6 B-fix Block 1: sort param + keyset cursor.
  //   - sort defaults to alpha; unknown values silently fall back to alpha
  //     (don't 400 — the wire is forgiving so a UI mid-rollout doesn't error).
  //   - Cursor is opaque base64url JSON encoding (sortKey, sortValue, id);
  //     a cursor minted under a different sort is treated as no-cursor.
  //
  // WS7-6 B-fix Block 2: `times_cooked` ranks by MealDishLink count desc —
  // the live link table, not the dead `Dish.timesCooked` column. Mobile
  // relabels this key "Most used" in dish contexts. `last_cooked` remains
  // unaccepted (still backed by the writeless `Dish.lastUsedAt`, D-WS7-111).
  //
  // WS7-6 B-fix Block 3: the displayed count is now FILTERED to live meals
  // (`meal.isArchived: false`). Prisma can't ORDER BY a filtered relation
  // count (probe 0.2b), so for `times_cooked` we fetch in a stable DB order
  // (id asc) and rank in memory by the same filtered `_count.mealLinks` the
  // wire shows — keeping the sort and the label consistent.
  router.get("/me/dishes", requireAuth, async (req, res) => {
    const parsed = parseFilterParam(req.query.filter, DISHES_FILTER_KEYS, [
      "my_dishes",
    ]);
    if ("unknownValues" in parsed) {
      return res.status(400).json({
        error: "invalid filter value(s)",
        unknown: parsed.unknownValues,
        allowed: DISHES_FILTER_KEYS,
      });
    }
    const limit = clampLimit(req.query.limit);
    const sort = parseDishSortParam(req.query.sort);
    const cursor = decodeKeysetCursor(req.query.cursor);

    // `id: "asc"` is the tiebreaker for every sort so pages are stable when
    // multiple rows share the primary sort value. `times_cooked` fetches in a
    // stable id order and is re-ranked in memory below (filtered count can't
    // be expressed in a Prisma orderBy — probe 0.2b).
    const orderBy: Prisma.DishOrderByWithRelationInput[] =
      sort === "date_created"
        ? [{ createdAt: "desc" }, { id: "asc" }]
        : sort === "cook_time"
          ? [{ estimatedTimeMinutes: "asc" }, { id: "asc" }]
          : sort === "times_cooked"
            ? [{ id: "asc" }]
            : [{ title: "asc" }, { id: "asc" }];

    try {
      const blocks: DishListRow[][] = [];
      for (const key of parsed.keys) {
        if (key === "my_dishes") {
          const rows = await prisma.dish.findMany({
            where: { userId: req.userId, isArchived: false },
            select: DISH_LIST_SELECT,
            orderBy,
          });
          blocks.push(rows);
        } else {
          // key === "featured" | "top_rated".
          // TODO(D-WS7-039): Dish carries no featuring flags, no isPublic,
          // and no saveCount/useCount counters — neither facet can be
          // resolved or ranked. Both resolve empty until a Dish-level
          // catalog/curation model exists. See WS7-3 A2 Phase 3 report §8.
          blocks.push([]);
        }
      }
      const merged = mergeById(blocks);
      // WS7-6 B-fix Block 3: rank `times_cooked` in memory by the filtered
      // (live-meal-only) link count desc, id asc — the same value the wire
      // emits and the keyset cursor encodes. Prisma can't ORDER BY a filtered
      // relation count (probe 0.2b); the route already holds all rows in
      // memory so this is cheap. Other sorts keep their Prisma order.
      if (sort === "times_cooked") {
        merged.sort(
          (a, b) =>
            b._count.mealLinks - a._count.mealLinks || a.id.localeCompare(b.id),
        );
      }
      const getSortValue = (r: DishListRow): string | number => {
        switch (sort) {
          case "date_created":
            return r.createdAt.toISOString();
          case "cook_time":
            return r.estimatedTimeMinutes;
          case "times_cooked":
            return r._count.mealLinks;
          case "alpha":
            return r.title;
        }
      };
      const { page, nextCursor } = paginateByKeyset(
        merged,
        cursor,
        limit,
        sort,
        getSortValue,
      );
      return res.json({ dishes: page.map(toDishListShape), nextCursor });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "GET /me/dishes failed");
      return res.status(500).json({ error: "failed to list dishes" });
    }
  });

  return router;
}

// Default export — production singleton, mounted by routes/index.ts.
const router: IRouter = createMeRouter();
export default router;
