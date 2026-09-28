// /me/* — authenticated user-account routes.
//
// D-WS9-257 — DELETION REPLACES DEACTIVATION. WS7-2 Block A shipped
// POST /me/deactivate + POST /me/reactivate: an accountStatus flip to 'paused'
// with customerEndDate as the clock, a 6-month reactivation TTL, and permanent
// deletion left as "a future cron job". That cron was never built, so the
// half-feature anonymized nothing, deleted nothing, and offered no restore a
// user could reach — while the screen told them "All your saved meals, dishes,
// plans, and preferences will be removed". Apple 5.1.1(v) asks an app that
// creates accounts to DELETE them and says in terms that offering to
// "temporarily deactivate or disable an account is insufficient".
//
// The PRD's §14.9.4 reasons for a soft delete were billing reconciliation
// (a Stripe customer to retain) and an admin restore window (an admin panel to
// restore from). Neither exists today, so neither is an obstacle. Both routes
// are gone; DELETE /me below does the real thing in one transaction.
//
// `accountStatus` and `customerEndDate` STAY on the schema (additive-only
// branch rule, no migration in this lane) and are now WRITE-NEVER: the login
// and reset-confirm checks that read accountStatus are left in place, harmless
// with nothing able to pause an account.

import { Router, type IRouter } from "express";
import { type Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { hashPassword, signToken, verifyPassword, verifyToken } from "../lib/auth";
// Row 9 · OAuth Block 1 Part E — the revoke call App Review 5.1.1(v) requires
// on account deletion, and the config that governs whether it can be made.
import { readOAuthConfig, type OAuthConfig } from "../lib/oauth/config";
import { revokeAppleIdentitiesForUser as productionRevokeAppleIdentities } from "../lib/oauth/revokeOnDelete";
import { readBillingConfig, type BillingConfig } from "../lib/billing/config";
import { cancelStripeForUser as productionCancelStripeForUser } from "../lib/billing/cancelOnDelete";
import {
  effectiveStatus,
  readSubscriptionSnapshot,
  subscriptionRequiredBody,
  subscriptionService as productionSubscriptionService,
  type SubscriptionService,
} from "../lib/subscriptionService";
import { logger } from "../lib/logger";
import { phoneSchema } from "../lib/phoneValidation";
import {
  DiscoveryLevelInputSchema,
  PlaylistLevelInputSchema,
} from "../lib/ai/schemas/wizard";
import {
  collectDishMentions,
  collectMealMentions,
  collectRematerializeDishMentions,
  estimateZeroMacroDish,
  estimateZeroMacroDishes,
  materializeDish,
  materializeMeal,
  rematerializeDish,
  rematerializeMeal,
  type MaterializeMealDish,
} from "../lib/mealMaterialize";
import { estimateDishMacros as productionEstimateDishMacros } from "../lib/dishMacros";
import { resolveIngredients } from "../lib/ingredientResolve";
import { markPersonalizeNudgeDismissed } from "../lib/personalizeNudge";
import { bumpPlanRevision } from "../lib/planRevision";
import {
  buildAppLink,
  emailChangeMessage,
  sendEmail as productionSendEmail,
  type EmailSender,
} from "../lib/email/sendEmail";
import { prisma as productionPrisma } from "../lib/prisma";
import { createRequireAuth } from "../middleware/auth";
import { rateLimit } from "../lib/rateLimit";
import { isIssuedBeforeEpoch, redeemPurposeToken } from "../lib/tokenRevocation";
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
  // WS9 3f-4d Part 1c (D-WS9-123/124) — in MEAL_LIST_SELECT.
  displayTitle: string | null;
  description: string | null;
  cuisineType: string | null;
  estimatedTimeMinutes: number;
  // WS9 D-WS9-235 — in MEAL_LIST_SELECT; toListShape requires it.
  activeTimeMinutes: number | null;
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

// D-WS9-257 — DELETE /me. Built the same way row 8 built the Instacart link
// limiter (per-user key so the bucket survives IP rotation and is not shared
// behind a NAT; BUG-223's reasoning in lib/rateLimit.ts applies). 3/hour, the
// tightest bucket in the file, because unlike every other limiter here this
// one is not metering cost — a second call from the same user can only ever be
// a 401 (the row is gone) or a mistake, so 3 is generous for "the request
// timed out and I tapped again" and nothing legitimate needs a fourth.
const deleteAccountLimiter = rateLimit({
  capacity: 3,
  refillPerSec: 3 / 3600,
  keyFn: (req) => `deleteaccount:${req.userId ?? "anonymous"}`,
});

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
  // Row 5 Block 4 / D-WS9-247 amendment — the Home card's "Set up my
  // Playlist" CTA was tapped. The client sends the FACT (`true`), never a
  // timestamp; the server stamps `playlistCtaTappedAt = now()`. `false` is not
  // a value: the flag is one-way (the CTA is only ever visible while unset,
  // so there is nothing to un-tap).
  playlistCtaTapped: z.literal(true).optional(),
  // Row 13 · Block 1b / D-WS9-263 — the personalize nudge was dismissed for
  // good. Same shape and same reasoning as playlistCtaTapped above: the client
  // sends the FACT (`true`), the server stamps the time, and `false` is not a
  // value because the flag is one-way.
  //
  // ⚠️ This is the "dismiss for good" half only. The card's [Later] button is
  // per-DEVICE and never reaches this route — see lib/personalizeNudge.ts.
  personalizeNudgeDismissed: z.literal(true).optional(),
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
// Phone rule lives in lib/phoneValidation.ts (D-WS9-241 A) — shared with
// POST /auth/signup so the two routes cannot drift.
const profilePatchSchema = z
  .object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    phone: phoneSchema.nullable().optional(),
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

// D-WS9-257 — the confirm word. z.literal, so ANY other body (a bare {}, a
// boolean, the wrong word) is one 400 `confirm_required` and never a delete.
const deleteAccountSchema = z.object({
  confirm: z.literal("delete"),
});

// D-WS9-257 rule (d) — bucket objects are counted, not deleted. This is the
// prefix lib/images/imageStore.ts writes into imageUrl (publicUrlFor).
const GCS_PUBLIC_PREFIX = "https://storage.googleapis.com/";

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
    // WS9 D-WS9-206 — free-text allergy terms (the ALLERGY half of the split;
    // dietaryNotes is now the PREFERENCE half). ⚠️ This list is .strict() and
    // 400s on an unknown key, and the mobile edit buffer is built by spreading
    // the GET response (preferencesForm.toFormState) — so a column that ships
    // on the wire but not in this list silently 400s EVERY preferences save.
    // That is BUG-137 exactly. Added on both sides in one commit.
    // Bounds mirror recurringGroceryItems, the nearest free-text array.
    otherAllergies: z.array(z.string().max(80)).max(60).optional(),
    // Cookbook Phase B Block 1 — new preference fields. maxCookTimeMinutes
    // stays a permissive nullable int (the 30/45/60/null UI gate is Block 3);
    // the others are value-set-validated here since the DB stores plain int/String.
    // WS9 Redesign Arc Block 1 (D-WS9-245) — the stored discovery dial is the
    // DialLevel enum; enum key only (Block 2 removed the legacy
    // `discoveryMealsPerWeek` key + integer shim from this allow-list).
    discoveryLevel: DiscoveryLevelInputSchema.optional(),
    // WS9 Redesign Arc Block 2 — the Playlist dial's stored default (Hans:
    // "if we have discovery meals we should have playlist in there, too").
    // Enum key only — this dial never had an integer form. The resolver
    // neutralises any level to `none` for a user with no playlist meals.
    playlistLevel: PlaylistLevelInputSchema.optional(),
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
  // WS9 D-WS9-206 — otherAllergies is an allergy field by construction, so it
  // belongs in this set for the same reason allergiesAndAvoidances does: a plan
  // committed before the user added a term is dietarily stale. Adding it later
  // (when the mobile field turns on) would have been a silent gap — a guest
  // allergy typed in and no staleness note raised on the open plan.
  "otherAllergies",
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
  otherAllergies: string[];
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
      : field === "otherAllergies"
        ? stored.otherAllergies
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
  return {
    ...p,
    updatedAt: p.updatedAt.toISOString(),
  };
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
    isTimingSensitive: z.boolean().optional(),
    // WS9 D-WS9-239 (Phase 1a) — the intra-dish overlap token, accepted again on
    // the save-canonical contract now that the materializer carries it (BUG-018
    // B1 had dropped it from this .strict() shape precisely because it was
    // set-then-silently-discarded). Optional: omitted = keep the wiped step's
    // tag at this index (D-WS9-235 preservation); null = clear it; a string =
    // the tag. `.max(40)` is D-WS7-012, deferred since May 2026 for this pass.
    // No client sends it yet; the mobile builder shape is unchanged.
    parallelGroup: z.string().max(40).nullable().optional(),
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
    // WS9 3f-4d Part 1c (D-WS9-123) — short display name from Mode-A / builder.
    // Nullable + optional; persisted to Meal.displayTitle via materializeMeal.
    displayTitle: z.string().max(50).nullable().optional(),
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
// §10.5/§8.4.5 (Dish edit).
//
// BUG-297 / D-WS9-246 — `imageUrl` is NOT patchable on either shape. Every
// meal image is AI-generated by the image queue and server-owned from
// generation onward; no client-supplied URL ever becomes an image (Hans:
// "I don't want to go down the moderation and review path"). Both schemas
// are `.strict()`, so a body that carries `imageUrl` FAILS with 400 rather
// than being silently stripped — a client that starts sending it is caught in
// test, not ignored in production. The server's own writes are elsewhere and
// untouched: materializeMeal → imageStatus pending, the drain → url +
// provenance, forkMealForUser → inheritance.
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
  /** BUG-224 — injected so tests record instead of sending. See lib/email. */
  sendEmail: EmailSender;
  /**
   * WS9 BUG-274 — the per-dish macro estimator POST /me/meals runs for
   * zero-macro new dishes, on the routes/plans.ts computePlanMacros pattern:
   * production wiring defaults to the real implementation; every router test
   * that reaches POST /me/meals injects a stub, so the suite is hermetic by
   * construction (`pnpm test` loads .env — a default-on real call here would
   * otherwise reach the live SDK from a stub-prisma test).
   */
  estimateDishMacros: typeof productionEstimateDishMacros;
  /**
   * Row 9 · OAuth Block 1 Part E — App Review 5.1.1(v)'s revoke call, made
   * from DELETE /me before the account is removed. Injected for the same
   * reason every outbound call in this server is: `pnpm test` loads .env, and
   * a default that reached appleid.apple.com would put a live POST one
   * forgotten stub away from every deletion test.
   *
   * The seam is the WHOLE revocation (find the identities, decrypt, call), not
   * the fetch inside it, because that is the function this route calls.
   */
  revokeAppleIdentities: typeof productionRevokeAppleIdentities;
  /** Read once per router so a test can hand in a configured deploy. */
  oauthConfig: OAuthConfig;
  /**
   * Row 9 (1.1) · Stripe S1 Part C — POST /me/meals and POST /me/dishes run the
   * BUG-274 / BUG-278 macros-at-save pre-pass, which is a model call per
   * zero-macro dish, and neither asked. Also the service `GET /me/subscription`
   * reads.
   */
  subscriptionService: SubscriptionService;
  /**
   * Row 9 (1.1) · Stripe S1 — read once per router. Governs the 503 on the
   * billing routes and the `billingAvailable` / `enforced` fields on
   * GET /me/subscription.
   */
  billingConfig: BillingConfig;
  /**
   * Row 9 (1.1) · Stripe S1 Part E — DELETE /me cancels a live Stripe
   * subscription and deletes the customer before removing the account. Injected
   * for exactly the reason `revokeAppleIdentities` is, with higher stakes:
   * `pnpm test` loads .env, and a default that reached Stripe would put a REAL
   * CANCELLATION of a REAL subscription one forgotten stub away from every
   * deletion test.
   */
  cancelStripeForUser: typeof productionCancelStripeForUser;
  /** Injected so entitlement and the trial clock are testable. */
  now?: () => Date;
}

export function createMeRouter(deps: Partial<MeRouterDeps> = {}): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const estimateDishMacros = deps.estimateDishMacros ?? productionEstimateDishMacros;
  const subscriptionService =
    deps.subscriptionService ?? productionSubscriptionService;
  const billingConfig = deps.billingConfig ?? readBillingConfig();
  const cancelStripeForUser =
    deps.cancelStripeForUser ?? productionCancelStripeForUser;
  const nowFn = deps.now ?? (() => new Date());
  const revokeAppleIdentities =
    deps.revokeAppleIdentities ?? productionRevokeAppleIdentities;
  const oauthConfig = deps.oauthConfig ?? readOAuthConfig();
  // WS9A BUG-234 — the session guard now reads User.tokensValidFrom, so it
  // needs a Prisma client. Building it from the injected one (rather than
  // importing the singleton) is what keeps this router's tests hermetic.
  // Shadows the module import: every requireAuth call site below is unchanged.
  const requireAuth = createRequireAuth({ prisma });
  const sendEmail = deps.sendEmail ?? productionSendEmail;
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
    const { playlistCtaTapped, personalizeNudgeDismissed, ...filterUpdates } =
      parsed.data;
    if (Object.keys(parsed.data).length === 0) {
      return res.status(400).json({ error: "no fields to update" });
    }
    // The tapped FACT becomes a server-side stamp (never client time).
    const updates: Prisma.UserUpdateInput = {
      ...filterUpdates,
      ...(playlistCtaTapped ? { playlistCtaTappedAt: new Date() } : {}),
    };

    try {
      // 🔴 D-WS9-263 — the nudge dismissal is a SEPARATE, GUARDED write, not a
      // field on the update below, and the separation is the idempotency. A
      // `personalizeNudgeDismissedAt: new Date()` in `updates` would move the
      // timestamp on every call, so a client that retries would keep rewriting
      // WHEN the user stopped needing the nudge. markPersonalizeNudgeDismissed
      // carries the `: null` predicate (the lib/firstPlan.ts pattern), so the
      // first dismissal wins and later ones no-op.
      //
      // Ordered first so a body carrying ONLY this field still has its effect
      // even though `updates` is then empty — Prisma accepts an empty `data`
      // and writes nothing, which is the correct no-op.
      if (personalizeNudgeDismissed) {
        await markPersonalizeNudgeDismissed(prisma, req.userId!);
      }
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
      // BUG-267 — the SMS-consent invariant, judged against the ROW AFTER
      // the patch, never the body alone (a body carrying only one of the two
      // fields is exactly how this was missed). Two rules:
      //   1. the resulting row may not have marketingConsentSms without a
      //      phone — 400, the same shape POST /auth/signup gives (D-WS9-241 A);
      //   2. changing or clearing the phone CLEARS marketingConsentSms in the
      //      same write — consent is consent for a NUMBER, not for an account.
      //      A body that supplies the new phone AND `marketingConsentSms:
      //      true` together is a fresh consent for that number and stands.
      if (updates.phone !== undefined || updates.marketingConsentSms !== undefined) {
        const current = await prisma.user.findUnique({
          where: { id: req.userId },
          select: { phone: true, marketingConsentSms: true },
        });
        if (!current) {
          return res.status(404).json({ error: "user not found" });
        }
        const phoneAfter = updates.phone !== undefined ? updates.phone : current.phone;
        const phoneChanged = updates.phone !== undefined && updates.phone !== current.phone;
        if (phoneChanged && updates.marketingConsentSms !== true) {
          updates.marketingConsentSms = false;
        }
        const smsAfter =
          updates.marketingConsentSms !== undefined
            ? updates.marketingConsentSms
            : current.marketingConsentSms;
        if (smsAfter && !phoneAfter) {
          return res
            .status(400)
            .json({ error: "SMS consent requires a phone number" });
        }
      }

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
          // Row 13 · Block 1b B2 — this route is the SECOND user-shape builder
          // (it hand-rolls the projection rather than calling auth.ts's
          // toUserShape), so both new columns have to be added here too or the
          // shape drifts: a client that re-reads its user from a profile PATCH
          // would silently lose signupSource and the nudge stamp that
          // /auth/me and signup do send.
          signupSource: true,
          personalizeNudgeDismissedAt: true,
          createdAt: true,
        },
      });
      return res.json({
        user: {
          ...updated,
          personalizeNudgeDismissedAt:
            updated.personalizeNudgeDismissedAt?.toISOString() ?? null,
          createdAt: updated.createdAt.toISOString(),
        },
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
        const changedAt = new Date();
        await prisma.user.update({
          where: { id: user.id },
          data: {
            passwordHash: newHash,
            // BUG-234 — the same gap as the reset path, and this is the one
            // Hans actually exercised on device: changing your password while
            // signed in left every other 30-day session JWT authenticating.
            // Someone changing their password because they think another
            // person has it gets the eviction they were asking for.
            tokensValidFrom: changedAt,
          },
        });
        logger.info({ userId: user.id }, "Password changed via /me/password");
        // Deliberately evicts the CALLER's own session too. The alternative —
        // exempting the current token — cannot be done honestly with a
        // single per-user epoch, and the safe direction is the one where a
        // user who suspects compromise ends up with every session dead rather
        // than one quietly spared. The client re-authenticates with the
        // password it was just given, which it already has in hand.
        //
        // ⚠️ This IS a device-visible behaviour change: the app will get a 401
        // on its next call after a password change and must send the user to
        // login. No client work is in this block's scope (§1 fences BUG-235
        // and BUG-236 off), so it is called out rather than absorbed.
        //
        // The response body stays { success: true }: the client parses it with
        // a non-strict z.object({success}) that would strip any added field,
        // so announcing the eviction here would be an unconsumed contract
        // change, not an interface.
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
          // BUG-219 — same exposure as the password-reset line in auth.ts: the
          // live email-change token and its `kiwi://verify-email?token=…` deep
          // link used to be logged at `info`, which is a retained, indexed,
          // widely-readable sink the moment this runs on Cloud Run rather than
          // a laptop. `newEmail` goes too — an address is PII, and a retained
          // log is the wrong place for it even though it is not a credential.
          //
          // BUG-224 — the verification now goes to the NEW address, which is
          // the whole point: possession of that inbox is what proves the change.
          // With no RESEND_API_KEY the sender returns a typed no-op and the
          // response below is unchanged.
          //
          // As in auth.ts, the send result is NOT surfaced: this route answers
          // 200 on every branch so an attacker cannot tell "address is free"
          // from "address is taken".
          const link = buildAppLink("/verify-email", verifyTokenStr);
          const result = await sendEmail(emailChangeMessage(newEmail, link));
          logger.info(
            {
              event: "email_change_requested",
              userId: currentUser.id,
              sent: result.sent,
              ...(result.sent ? {} : { reason: result.reason }),
            },
            "Email change requested",
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
  // BUG-257 — metered like its reset-confirm sibling (auth.ts authLimiter,
  // the same 10/min posture passwordChangeLimiter carries); it was the one
  // token-spending POST with no limiter.
  router.post("/me/email/verify-change", passwordChangeLimiter, async (req, res) => {
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
      //
      // The acting user's revocation epoch is fetched alongside it rather than
      // after it: two independent primary-key reads in one round-trip pair, so
      // BUG-233's epoch clause costs no extra wall-clock here.
      const [conflict, actor] = await Promise.all([
        prisma.user.findUnique({
          where: { email: newEmail },
          select: { id: true },
        }),
        prisma.user.findUnique({
          where: { id: payload.userId },
          select: { tokensValidFrom: true },
        }),
      ]);
      if (conflict && conflict.id !== payload.userId) {
        return res.status(400).json({
          error: "email_taken",
          userFacingMessage: "That email is already registered to another account.",
        });
      }

      // BUG-233 — a verification link minted before the account's last password
      // change is stale. If someone reset this password because the account was
      // taken, an email-change link the attacker had already requested must not
      // still be able to move the address out from under them.
      if (actor && isIssuedBeforeEpoch(payload.iat, actor.tokensValidFrom)) {
        logger.warn(
          { userId: payload.userId, reason: "before_epoch" },
          "Email change token refused",
        );
        return res.status(400).json({
          error: "invalid_token",
          userFacingMessage: "This link is invalid or has expired.",
        });
      }

      // BUG-233 — THE measured defect. This exact token returned 200 three
      // times in a row against an op-counting probe, because nothing marked it
      // spent and "spent" was not a state the system could represent. The
      // ledger write below is that state, and it is atomic on the primary key,
      // so a double-submit cannot redeem twice.
      const redeemed = await redeemPurposeToken(prisma, payload, "email_change");
      if (!redeemed.ok) {
        logger.warn(
          { userId: payload.userId, reason: redeemed.reason },
          "Email change token refused",
        );
        return res.status(400).json({
          error: "invalid_token",
          userFacingMessage: "This link is invalid or has expired.",
        });
      }

      await prisma.user.update({
        where: { id: payload.userId },
        data: { email: newEmail },
      });
      // BUG-219 leftover — `fa1859c` took `newEmail` out of the REQUEST log
      // and left it here. Hans ruled the field out of logs outright; an address
      // is PII and a retained sink is the wrong place for it, whichever handler
      // writes it. The userId identifies the row for any audit that needs one.
      logger.info({ event: "email_change_verified", userId: payload.userId }, "Email change verified");
      return res.json({ success: true, email: newEmail });
    } catch (err) {
      logger.error({ err, userId: payload.userId }, "POST /me/email/verify-change failed");
      return res.status(500).json({ error: "failed to verify email change" });
    }
  });

  // ── Preferences ──────────────────────────────────────────────────────

  // ── GET /me/subscription — Row 9 (1.1) · Stripe S1 Part C ─────────────
  //
  // THE ONE SHAPE the paywall sheet, the trial banner and the Settings
  // "Subscription" row all read. Nothing is added to `GET /me`, deliberately:
  // that response is fetched on every cold start by clients in the stores right
  // now, and a subscription block on it would be a field those builds ignore
  // while every one of them pays for the extra query. This is its own endpoint
  // so the clients that need it can refetch it on foreground, after a checkout
  // return, and when the paywall is dismissed — which is exactly the access
  // pattern S2 has and `GET /me` does not.
  //
  // `firstChargeDateIfSubscribedNow` is computed HERE rather than in three
  // clients. It is `trialEndsAt + BILLING_EARLY_PAY_BONUS_DAYS` while the trial
  // is running and `null` otherwise, and it is what lets the upsell sheet say
  // "Subscribe now — your first charge is <date>" without any client doing date
  // arithmetic against a bonus it would have to be told about separately.
  router.get("/me/subscription", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    try {
      const snapshot = await readSubscriptionSnapshot(prisma, userId);
      const now = nowFn();

      // No row is corruption (it is written in the same transaction as the
      // User), but this endpoint must still answer something a client can
      // render. `none` is the honest answer and it shows a paywall rather than
      // a spinner — and `can()` logs the corruption loudly on the write paths.
      const status = snapshot === null ? "none" : effectiveStatus(snapshot, now);

      const trialEndsAt = snapshot?.trialEndsAt ?? null;
      const firstChargeDateIfSubscribedNow =
        status === "trialing" && trialEndsAt !== null
          ? new Date(
              trialEndsAt.getTime() +
                billingConfig.earlyPayBonusDays * 24 * 60 * 60 * 1000,
            ).toISOString()
          : null;

      return res.json({
        status,
        planCode: snapshot?.planCode ?? "free",
        trialEndsAt: trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: snapshot?.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: snapshot?.cancelAtPeriodEnd ?? false,
        // Both of these are about the DEPLOY, not the user, and the client needs
        // them to tell three states apart that otherwise look identical:
        // "subscribe" (enforced + available), "you're in the trial and nothing
        // is being enforced yet" (available, not enforced), and "we cannot take
        // your money right now" (not available) — which must never render a
        // button that leads to a 503.
        billingAvailable: billingConfig.available,
        enforced: billingConfig.enforced,
        earlyPayBonusDays: billingConfig.earlyPayBonusDays,
        firstChargeDateIfSubscribedNow,
        // 🔴 ROW 9 (1.1) · STRIPE S2 PART C — ADDED, because §2.8 rules that
        // "Manage subscription" appears "when a Stripe subscription exists" and
        // this body carried no field saying so. The client would have had to
        // infer it from the status, which is wrong in BOTH directions: a
        // `canceled` account still has a portal worth opening (invoices,
        // resubscribe — and `POST /billing/portal-session` needs only the
        // CUSTOMER, which is what it 409s `no_billing_account` on), while an
        // `active` one read before its first `customer.subscription.updated`
        // webhook has no customer id yet and would get a button that 409s.
        //
        // Keyed on `stripeCustomerId`, deliberately, NOT on
        // `stripeSubscriptionId`: the customer is what the Portal is scoped to,
        // and `routes/billing.ts` persists it before the checkout session is
        // created — so a user who started a checkout and abandoned it can still
        // reach their billing page.
        //
        // A widening, so every shipped client ignores it and the S2 schema takes
        // it as `.optional()`.
        hasBillingAccount: snapshot?.stripeCustomerId != null,
      });
    } catch (err) {
      logger.error({ err, userId }, "GET /me/subscription failed");
      return res.status(500).json({ error: "failed to fetch subscription" });
    }
  });

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
        otherAllergies: true,
        eatingStyles: true,
        pickyAvoidances: true,
        dietaryNotes: true,
      },
    });
    const storedDietary: StoredDietary = existing ?? {
      allergiesAndAvoidances: [],
      otherAllergies: [],
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
      // D-WS9-263 — PERSONALIZING IS DISMISSING. The nudge asks them to tell
      // Kiwi how they really cook; a successful preferences save is them doing
      // it, so the card has done its job and must not greet them again. Write-
      // if-null, so a user who saves preferences every week keeps the timestamp
      // of the save that retired the nudge, not of the latest one.
      //
      // AFTER the upsert, never before: the nudge is retired by a save that
      // LANDED. A throw above leaves the stamp null and the card shown, which is
      // the honest state — they tried to personalize and it did not take.
      //
      // Best-effort: a failed stamp must not fail a preferences save the user
      // has already made. The cost is one extra sighting of a dismissible card.
      await markPersonalizeNudgeDismissed(prisma, req.userId!).catch((err) => {
        logger.warn(
          { err, userId: req.userId, event: "personalize_nudge_stamp_failed" },
          "Preferences saved but the personalize-nudge stamp did not land",
        );
      });
      return res.json({ preferences: serializePreferences(prefs) });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "PATCH /me/preferences failed");
      return res.status(500).json({ error: "failed to update preferences" });
    }
  });

  // ── Account deletion (D-WS9-257) ─────────────────────────────────────
  //
  // DELETE /me — the real thing, in one transaction. Replaces the WS7-2
  // deactivate/reactivate pair (see the file header for why).
  //
  // Ordering is DERIVED FROM THE SCHEMA, not guessed. The FK graph (read out
  // of prisma/migrations, not out of the Prisma defaults, because the two
  // disagree) says a user's rows fall into four classes:
  //
  //   CASCADE from users — favorites, playlist_meals, user_preferences,
  //     wizard_last_batches, pantry_staples, subscriptions, user_activities.
  //     `user.delete` takes these. Nothing explicit needed.
  //
  //   RESTRICT on users — grocery_lists, meal_plan_instances,
  //     meal_plan_templates, retailer_connections, order_sessions. The delete
  //     FAILS unless these go first. Each has its own explicit deleteMany
  //     below, in child-before-parent order.
  //
  //   SET NULL on users — meals, dishes, llm_call_logs, plus the two admin
  //     tables (ai_prompt_versions.createdById, system_settings.updatedById).
  //     ⚠️ THIS IS THE DANGEROUS CLASS, because it does NOT fail: without an
  //     explicit delete, the user's meals and dishes would SURVIVE the
  //     deletion as `userId: null` rows — un-owned, un-listable, un-deletable
  //     residue of an account we just promised to erase. They are deleted
  //     explicitly. The admin tables are the opposite case and SET NULL is
  //     right there: the prompt version and the settings row are not the
  //     user's data, they are system rows that merely remember who touched
  //     them, so the row stays and the attribution drops. llm_call_logs is
  //     nulled explicitly (see below) rather than left to the FK, because
  //     de-identifying the cost ledger is an intention, not a side effect.
  //
  //   NO FOREIGN KEY AT ALL — notification_preferences, used_tokens, and
  //     recipe_instruction_steps (whose owner link is a (ownerType, ownerId)
  //     pair the schema says is "enforced at application layer, not DB",
  //     because Postgres cannot conditionally reference two tables). Nothing
  //     in the database will ever clean these up. They are deleted by query,
  //     and the step rows have to be collected BEFORE their meals and dishes
  //     are gone, because after that there is nothing left to match on.
  //
  // What is NOT deleted, deliberately:
  //   · llm_call_logs rows — kept with `userId: null`. This is the PRD's
  //     "activity history retained but de-identified": the spend ledger is
  //     accounting, it is what tells us a prompt version costs what it costs,
  //     and it carries no PII once the id is gone.
  //   · GCS image objects for the deleted meals — counted and logged, not
  //     deleted. Removing bucket objects is a different failure domain from a
  //     database transaction (it cannot be rolled back with one) and this lane
  //     does not build it. The count rides the log line so the carried item is
  //     measurable rather than theoretical.
  router.delete("/me", requireAuth, deleteAccountLimiter, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    // A typed word, not a boolean: the phone makes the user type it, and a
    // body that could be sent by accident is not a confirmation.
    const parsed = deleteAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "confirm_required" });
    }

    try {
      // ── Row 9 · OAuth Block 1 Part E — APPLE FIRST, AND BEFORE THE DELETE ─
      //
      // App Review guideline 5.1.1(v): an app offering Sign in with Apple must
      // revoke the Apple token when the account is deleted. It has to run
      // BEFORE, because the identity rows (and the refresh token on them)
      // cascade away with the user in the transaction below — after the delete
      // there is nothing left to revoke with.
      //
      // 🔴 IT CANNOT FAIL THE DELETION. Every failure inside — an
      // unconfigured deploy, a token that will not decrypt, an Apple outage, a
      // throw — is logged and swallowed there (lib/oauth/revokeOnDelete.ts).
      // A person asking to be deleted gets deleted; an account that cannot be
      // removed because a third party is down is worse for them and worse for
      // us under GDPR than an un-revoked token for an account that no longer
      // exists. This `catch` is the second belt to that brace.
      let appleRevoke = { found: 0, revoked: 0, skipped: [] as string[] };
      try {
        appleRevoke = await revokeAppleIdentities({ prisma, userId, config: oauthConfig });
      } catch (err) {
        logger.error(
          { event: "apple_revoke_failed", userId, err },
          "Apple revocation threw at the route — deletion proceeds regardless",
        );
      }

      // ── Row 9 (1.1) · Stripe S1 Part E — STRIPE, BEFORE THE DELETE TOO ──
      //
      // Same shape and same reason as the Apple block above: the customer and
      // subscription ids live on the `subscriptions` row, which cascades away
      // with the user in the transaction below, so afterwards there is nothing
      // left to cancel with.
      //
      // 🔴 IT CANNOT FAIL THE DELETION EITHER — every failure inside is logged
      // and swallowed there (lib/billing/cancelOnDelete.ts), and this `catch` is
      // the second belt to that brace.
      //
      // ⚠️ BUT THE FAILURE COSTS MORE THAN APPLE'S. An un-revoked Apple token is
      // a privacy loose end; an un-cancelled Stripe subscription KEEPS CHARGING A
      // CARD for an account that no longer exists, and the person has no way left
      // to stop it — they cannot log in to reach the Portal. That is why the
      // helper logs the customer and subscription ids on every skip, and why they
      // appear on the deletion's own log line below.
      let stripeCancel = {
        hadCustomer: false,
        cancelled: false,
        customerDeleted: false,
        skipped: [] as string[],
      };
      try {
        stripeCancel = await cancelStripeForUser({
          prisma,
          userId,
          config: billingConfig,
        });
      } catch (err) {
        logger.error(
          { event: "stripe_cancel_failed", userId, err },
          "Stripe cancellation threw at the route — deletion proceeds regardless. THE CARD MAY STILL BE CHARGED; check the Dashboard",
        );
      }

      // Collected before the transaction: the ids the application-layer
      // ownership link needs, and the bucket-object count for the log.
      const [mealRows, dishRows, templateRows] = await Promise.all([
        prisma.meal.findMany({ where: { userId }, select: { id: true, imageUrl: true } }),
        prisma.dish.findMany({ where: { userId }, select: { id: true, imageUrl: true } }),
        prisma.mealPlanTemplate.findMany({
          where: { userId },
          select: { imageUrl: true },
        }),
      ]);
      const ownerIds = [...mealRows.map((m) => m.id), ...dishRows.map((d) => d.id)];
      const gcsObjectCount = [...mealRows, ...dishRows, ...templateRows].filter(
        (r) => typeof r.imageUrl === "string" && r.imageUrl.startsWith(GCS_PUBLIC_PREFIX),
      ).length;

      await prisma.$transaction([
        // 1. Grocery lists first — items and item-sources cascade from them,
        //    and grocery_lists.mealPlanInstanceId is SET NULL, so doing this
        //    before the plans avoids a pointless UPDATE of rows about to die.
        prisma.groceryList.deleteMany({ where: { userId } }),
        // 2. Plan instances — meal_plan_items, prep_step_completions and
        //    prep_week_structures cascade. This is also what releases the
        //    RESTRICT that meal_plan_items holds on meals (step 5).
        prisma.mealPlanInstance.deleteMany({ where: { userId } }),
        // 3. Plan templates — meal_plan_template_items cascade, releasing the
        //    second RESTRICT on meals.
        prisma.mealPlanTemplate.deleteMany({ where: { userId } }),
        // 4. The orphan-by-design step rows, before their owners vanish.
        prisma.recipeInstructionStep.deleteMany({
          where: { ownerId: { in: ownerIds } },
        }),
        // 5. Meals — favorites, playlist_meals and meal_dish_links cascade.
        //    Explicit because the FK is SET NULL (see the note above).
        prisma.meal.deleteMany({ where: { userId } }),
        // 6. Dishes — dish_ingredients cascade; meal_dish_links (RESTRICT on
        //    dishId) died with the meals in step 5.
        prisma.dish.deleteMany({ where: { userId } }),
        // 7. The retailer pair. Order sessions first: both are RESTRICT on
        //    users and neither references the other, so this is only tidiness.
        prisma.orderSession.deleteMany({ where: { userId } }),
        prisma.retailerConnection.deleteMany({ where: { userId } }),
        // 8. The two FK-less tables. Nothing else would ever remove these.
        prisma.notificationPreference.deleteMany({ where: { userId } }),
        prisma.usedToken.deleteMany({ where: { userId } }),
        // 9. De-identify the cost ledger. The FK would do this anyway; saying
        //    it here is what makes it a decision rather than a coincidence.
        prisma.lLMCallLog.updateMany({ where: { userId }, data: { userId: null } }),
        // 10. The user. Everything in the CASCADE class goes with it, and the
        //     two admin tables keep their rows with a null attribution.
        prisma.user.delete({ where: { id: userId } }),
      ]);

      logger.info(
        {
          userId,
          gcsObjectCount,
          // Row 9 · Part E — on the same line as the deletion, so a 5.1.1(v)
          // obligation that went unmet is visible where the deletion is,
          // rather than only in a warning somewhere above it.
          appleIdentities: appleRevoke.found,
          appleRevoked: appleRevoke.revoked,
          appleRevokeSkipped: appleRevoke.skipped,
          // Row 9 (1.1) · Stripe S1 Part E — on the same line as the deletion,
          // for the same reason the Apple fields are: an obligation that went
          // unmet is visible where the deletion is, not only in a warning
          // somewhere above it. `stripeCancelSkipped` non-empty on a row that
          // `hadCustomer` is the line that means a card may still be charged.
          stripeHadCustomer: stripeCancel.hadCustomer,
          stripeCancelled: stripeCancel.cancelled,
          stripeCustomerDeleted: stripeCancel.customerDeleted,
          stripeCancelSkipped: stripeCancel.skipped,
        },
        "Account deleted",
      );
      return res.status(204).end();
    } catch (err) {
      logger.error({ err, userId }, "DELETE /me failed");
      return res.status(500).json({ error: "failed to delete account" });
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
        select: { id: true, isPublic: true, userId: true },
      });
      if (!meal) {
        return res.status(404).json({ error: "meal not found" });
      }
      // BUG-276 — ownership gate: a private meal can be favourited only by
      // its owner. Same gate as the playlist (routes/playlist.ts).
      if (!meal.isPublic && meal.userId !== req.userId) {
        return res.status(403).json({ error: "forbidden" });
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
        // WS9 BUG-274 — macros at save. The estimator pre-pass runs HERE, on
        // the plain client, BEFORE the tx opens: an AI round trip inside the
        // 15 s tx would hold a Neon connection through model latency and roll
        // back its LLMCallLog rows on a failed save. Fail-soft (a failed /
        // slow dish saves at zero with a warn); materializeMeal consumes the
        // result and stamps macros + macroGroundedPct + dish_macros_estimated.
        // Row 9 (1.1) · Stripe S1 Part C — the estimator is a model call per
        // zero-macro dish, so it asks first. The DENIAL IS GRACEFUL, not a 402:
        // saving a meal is not an AI feature, it is the user keeping their own
        // recipe, and the read-only ruling says that keeps working. What the
        // estimator adds is nutrition, and BUG-274 already made a failed or slow
        // estimate "save at zero with a warn" — so an unentitled account takes
        // the path that already exists for an estimator that did not answer.
        // The meal saves; the macros read zero until the account is entitled and
        // something recalculates.
        const macroEnt = await subscriptionService.can(userId, "meal_macro_estimate");
        const estimatedMacrosByIndex = macroEnt.allowed
          ? await estimateZeroMacroDishes({
              prisma,
              userId,
              payload,
              ingredientIdByCanonical,
              estimateImpl: estimateDishMacros,
            })
          : undefined;
        if (!macroEnt.allowed) {
          logger.info(
            { event: "macro_estimate_skipped_unentitled", userId, status: macroEnt.status },
            "Macros-at-save skipped — account is not entitled to AI; the meal still saves, with zero macros",
          );
        }
        //
        // 🔴 ROW 9 (1.1) · STRIPE S2 PART C — AND THE PART THE SCHEMA WILL NOT LET
        // US DO, REPORTED RATHER THAN FAKED.
        //
        // §2.6 asks that a new meal "saves with macros absent, never a fabricated
        // zero". IT IS NOT REPRESENTABLE. `Dish.caloriesPerServing` and
        // `proteinGPerServing` are `Float @default(0)` and NOT NULLABLE
        // (schema.prisma:921-922, and 1074-1075 for the Meal), so there is no
        // absent to save. What the write already does is the closest thing
        // available and is not a fabrication: mealMaterialize.ts omits the macro
        // KEYS entirely when there is neither an estimate nor a client-supplied
        // set, and the column default supplies the 0. No number is invented by
        // this route; the schema has one.
        //
        // Making it representable means a nullable column and a migration, which
        // this block may not do. So the honest half — telling the user WHY the
        // figure did not arrive — is done on the WIRE instead, and the client
        // renders §2.6's notice from it rather than guessing from a zero (a zero
        // is also what a genuinely zero-calorie edit stores, and the two must not
        // read the same).
        //
        // `macroGroundedPct` (nullable, schema.prisma:933) staying NULL is the
        // persisted trace of the same fact, for anything reading the row later.
        const macrosSkipped = macroEnt.allowed
          ? undefined
          : ("subscription_required" as const);
        const result = await prisma.$transaction(
          async (tx) =>
            materializeMeal(tx, userId, payload, ingredientIdByCanonical, undefined, {
              estimatedMacrosByIndex,
            }),
          { timeout: 15000 },
        );
        return res.status(201).json({
          meal: {
            id: result.mealId,
            dishIds: result.dishIds,
            linksCreated: result.linksCreated,
          },
          // Absent on the normal path — a client that has never heard of it sees
          // the body it saw before.
          ...(macrosSkipped !== undefined ? { macrosSkipped } : {}),
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
        // WS9 BUG-278 (server half) — macros at save for a standalone dish,
        // through the SAME seam as POST /me/meals (BUG-274 / F2): the
        // injected estimator, on the plain client, BEFORE the tx opens,
        // fail-soft (a failed / slow estimate saves at zero with a warn).
        // Row 9 (1.1) · Stripe S1 Part C — same key and the same graceful skip as
        // POST /me/meals above; see the comment there.
        const dishMacroEnt = await subscriptionService.can(
          userId,
          "meal_macro_estimate",
        );
        const estimatedMacros = dishMacroEnt.allowed
          ? await estimateZeroMacroDish({
              prisma,
              userId,
              payload: body,
              ingredientIdByCanonical,
              estimateImpl: estimateDishMacros,
            })
          : undefined;
        if (!dishMacroEnt.allowed) {
          logger.info(
            { event: "macro_estimate_skipped_unentitled", userId, status: dishMacroEnt.status },
            "Macros-at-save skipped for a standalone dish — not entitled to AI; the dish still saves, with zero macros",
          );
        }
        // S2 Part C — same wire flag as POST /me/meals, same reasoning; see the
        // long note there for why the "absent, never a zero" half of §2.6 is a
        // schema change this block may not make.
        const dishMacrosSkipped = dishMacroEnt.allowed
          ? undefined
          : ("subscription_required" as const);
        const result = await prisma.$transaction(
          async (tx) =>
            materializeDish(tx, userId, body, ingredientIdByCanonical, {
              estimatedMacros,
            }),
          { timeout: 15000 },
        );
        return res.status(201).json({
          dish: { id: result.dishId },
          ...(dishMacrosSkipped !== undefined
            ? { macrosSkipped: dishMacrosSkipped }
            : {}),
        });
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
        if (body.estimatedTimeMinutes !== undefined) {
          scalarUpdate.estimatedTimeMinutes = body.estimatedTimeMinutes;
          // D-WS9-235 follow-up — a user-typed time is a CLAIM, not a
          // derivation. `activeTimeMinutes` non-null is the "derived" marker
          // (D-WS7-166's capped shelves admit only marked rows), so a scalar
          // time patch must clear it or the meal keeps the marker over a
          // number the scheduler never produced. Same shape as the
          // macroGroundedPct clear on the dish PATCH below. The user's number
          // is kept as written; re-deriving here would silently drop the edit.
          scalarUpdate.activeTimeMinutes = null;
        }
        if (body.difficulty !== undefined)
          scalarUpdate.difficulty = body.difficulty;
        if (body.tags !== undefined) scalarUpdate.tags = body.tags;
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
          : // BUG-067 — the A–Z sort should key on the DISPLAYED string
            // COALESCE(displayTitle, title). Prisma orderBy cannot express
            // COALESCE, so this stays on `title` (correct while displayTitle is
            // null on every row — pre-backfill). Once the D-WS9-123 backfill
            // populates displayTitle this diverges from the rendered order; the
            // fix (denormalized indexed sortTitle column, or a raw ORDER BY
            // COALESCE) is gated behind that backfill. See the Part 1c report.
            [{ title: "asc" }, { id: "asc" }];

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
            : // BUG-067 — see the meal-sort note above; dishes carry displayTitle
              // too, so A–Z should key on COALESCE(displayTitle, title). Same
              // Prisma limitation → stays on `title` until the D-WS9-123 backfill.
              [{ title: "asc" }, { id: "asc" }];

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
