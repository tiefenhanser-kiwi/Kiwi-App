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

// Brute-force protection on password change (matches /auth/login posture).
const passwordChangeLimiter = rateLimit({ capacity: 10, refillPerSec: 10 / 60 });

// Same posture as password-reset request: deters enumeration probing.
const emailRequestLimiter = rateLimit({ capacity: 5, refillPerSec: 5 / 300 });

// Brute-force protection on reactivate (matches /auth/login posture).
const reactivateLimiter = rateLimit({ capacity: 10, refillPerSec: 10 / 60 });

// Email-change verification token TTL (matches password-reset).
const EMAIL_CHANGE_EXPIRY = "1h";

const FILTER_KEYS = ["my_plans", "featured", "top_rated", "hosting_events"] as const;
const MEALS_FILTER_KEYS = ["my_meals", "all_meals"] as const;

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

  return router;
}

// Default export — production singleton, mounted by routes/index.ts.
const router: IRouter = createMeRouter();
export default router;
