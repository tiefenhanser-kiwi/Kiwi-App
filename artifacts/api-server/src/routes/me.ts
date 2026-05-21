// /me/* — authenticated user-account routes.
//
// Deactivation note: per WS7-2 Block A locked decision 2, deactivation reuses
// existing User columns rather than introducing a deactivatedAt field.
//   deactivate  = { accountStatus: 'paused', customerEndDate: new Date() }
//   reactivate  = { accountStatus: 'active', customerEndDate: null }  (within 6mo TTL)
// Permanent deletion is a future cron job (out of scope for Block A).

import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { hashPassword, signToken, verifyPassword, verifyToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../lib/rateLimit";
import { getTopRatedSettings } from "../lib/topRated";
import { MEAL_LIST_SELECT, toListShape, type MealListItem } from "./meals";

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
  })
  .strict();

function serializePreferences(p: {
  id: string;
  userId: string;
  updatedAt: Date;
  [k: string]: unknown;
}) {
  return { ...p, updatedAt: p.updatedAt.toISOString() };
}

// ── WS7-3 A2: catalog-read helpers (GET /me/meals, GET /me/dishes) ──────────

// Parse a comma-separated ?filter= param into a validated, de-duplicated list
// of keys, canonically ordered by the `allowed` list. An absent/empty param
// falls back to `fallback`. Unknown values are reported for a 400.
function parseFilterParam<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: readonly T[],
): { keys: T[] } | { unknownValues: string[] } {
  if (raw === undefined || raw === null || raw === "") {
    return { keys: [...fallback] };
  }
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return { keys: [...fallback] };
  const unknownValues = parts.filter(
    (p) => !(allowed as readonly string[]).includes(p),
  );
  if (unknownValues.length > 0) return { unknownValues };
  const set = new Set(parts);
  return { keys: allowed.filter((k) => set.has(k)) };
}

// limit clamp — identical contract to GET /meals: missing/non-numeric → 20,
// otherwise clamped to [1, 100] (0 and negatives clamp up to 1).
function clampLimit(raw: unknown): number {
  const parsed = raw === undefined ? 20 : parseInt(String(raw), 10);
  return Math.min(100, Math.max(1, Number.isNaN(parsed) ? 20 : parsed));
}

// Concatenate per-filter result blocks, de-duping by id (first occurrence
// wins). Preserves block order so each filter keeps its natural ordering.
function mergeById<T extends { id: string }>(blocks: T[][]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const block of blocks) {
    for (const item of block) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
  }
  return merged;
}

// In-memory cursor pagination over a pre-merged list. The OR-union across
// heterogeneous filters can't ride a single Prisma keyset cursor, so the
// cursor is the id of the previous page's last row and the slice is computed
// in memory. The wire contract (opaque id cursor + nextCursor) matches
// GET /meals. An unknown cursor yields an empty page.
function paginateById<T extends { id: string }>(
  rows: T[],
  cursor: string | undefined,
  limit: number,
): { page: T[]; nextCursor: string | null } {
  let start = 0;
  if (cursor) {
    const idx = rows.findIndex((r) => r.id === cursor);
    start = idx >= 0 ? idx + 1 : rows.length;
  }
  const page = rows.slice(start, start + limit);
  const nextCursor =
    start + limit < rows.length && page.length > 0
      ? page[page.length - 1].id
      : null;
  return { page, nextCursor };
}

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
}

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
} as const;

function toDishListShape(d: {
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
}): DishListItem {
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
  };
}

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
      const prefs = await prisma.userPreferences.upsert({
        where: { userId: req.userId! },
        update: updates,
        create: { userId: req.userId!, ...updates },
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

  // ── Catalog reads — WS7-3 A2 ──────────────────────────────────────────
  // Multi-select OR filters. Each requested filter contributes a result
  // block; blocks concatenate in MEALS_FILTER_KEYS order and dedupe by id.
  // Cursor pagination matches GET /meals (opaque id cursor; see paginateById).

  // GET /me/meals?filter=my_meals,featured,top_rated,hosting
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
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor.length > 0
        ? req.query.cursor
        : undefined;

    try {
      const blocks: MealListItem[][] = [];
      for (const key of parsed.keys) {
        if (key === "my_meals") {
          const rows = await prisma.meal.findMany({
            where: { userId: req.userId, isArchived: false },
            select: MEAL_LIST_SELECT,
            orderBy: { title: "asc" },
          });
          blocks.push(rows.map(toListShape));
        } else if (key === "top_rated") {
          // No cached score on Meal — rank public meals by the un-decayed
          // weighted counter sum, capped at top_rated.display_count.
          const settings = await getTopRatedSettings(prisma);
          const rows = await prisma.meal.findMany({
            where: { isPublic: true, isArchived: false },
            select: { ...MEAL_LIST_SELECT, saveCount: true, useCount: true },
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
            .map((r) => toListShape(r.m));
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
      const { page, nextCursor } = paginateById(merged, cursor, limit);
      return res.json({ meals: page, nextCursor });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "GET /me/meals failed");
      return res.status(500).json({ error: "failed to list meals" });
    }
  });

  // GET /me/dishes?filter=my_dishes,featured,top_rated
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
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor.length > 0
        ? req.query.cursor
        : undefined;

    try {
      const blocks: DishListItem[][] = [];
      for (const key of parsed.keys) {
        if (key === "my_dishes") {
          const rows = await prisma.dish.findMany({
            where: { userId: req.userId, isArchived: false },
            select: DISH_LIST_SELECT,
            orderBy: { title: "asc" },
          });
          blocks.push(rows.map(toDishListShape));
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
      const { page, nextCursor } = paginateById(merged, cursor, limit);
      return res.json({ dishes: page, nextCursor });
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
