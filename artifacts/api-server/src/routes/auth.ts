import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { hashPassword, signToken, verifyPassword, verifyToken } from "../lib/auth";
import { requireAuth } from "../middleware/auth";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";

// Tight limiter for signup/login to slow brute-force attempts
const authLimiter = rateLimit({ capacity: 10, refillPerSec: 10 / 60 }); // 10 burst, ~1/6s
// Looser limiter for /me (read-only, auth'd)
const meLimiter = rateLimit({ capacity: 30, refillPerSec: 30 / 60 });
// Even tighter for password reset request (prevents email enumeration via rate patterns)
const resetLimiter = rateLimit({ capacity: 5, refillPerSec: 5 / 300 }); // 5 burst, ~1/60s

// Password-reset tokens are short-lived per WS7-2 Block A. Reuses the
// session signing helper with purpose='password_reset' so a leaked reset
// token can't be replayed as a session.
const PASSWORD_RESET_EXPIRY = "1h";

const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(100),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  zipCode: z.string().max(20).optional(),
  timezone: z.string().max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(100),
});

const resetRequestSchema = z.object({
  email: z.string().email().max(255),
});

const resetConfirmSchema = z.object({
  token: z.string().min(10).max(500),
  newPassword: z.string().min(8).max(100),
});

function toUserShape(u: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  zipCode: string | null;
  timezone: string;
  accountStatus: string;
  subscriptionStatus: string;
  defaultHouseholdSize: number;
  lastPlanDiscoveryFilters: string[];
  lastPlansFilters: string[];
  lastMealsFilters: string[];
  marketingConsentEmail: boolean;
  marketingConsentSms: boolean;
  onboardingComplete: boolean;
  firstRunChoiceMade: boolean;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    phone: u.phone,
    zipCode: u.zipCode,
    timezone: u.timezone,
    accountStatus: u.accountStatus,
    subscriptionStatus: u.subscriptionStatus,
    defaultHouseholdSize: u.defaultHouseholdSize,
    lastPlanDiscoveryFilters: u.lastPlanDiscoveryFilters,
    lastPlansFilters: u.lastPlansFilters,
    lastMealsFilters: u.lastMealsFilters,
    marketingConsentEmail: u.marketingConsentEmail,
    marketingConsentSms: u.marketingConsentSms,
    onboardingComplete: u.onboardingComplete,
    firstRunChoiceMade: u.firstRunChoiceMade,
    createdAt: u.createdAt.toISOString(),
  };
}

function toSubscriptionShape(s: {
  status: string;
  planCode: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}) {
  return {
    status: s.status,
    planCode: s.planCode,
    trialEndsAt: s.trialEndsAt ? s.trialEndsAt.toISOString() : null,
    currentPeriodEnd: s.currentPeriodEnd ? s.currentPeriodEnd.toISOString() : null,
  };
}

export interface AuthRouterDeps {
  prisma: PrismaClient;
}

export function createAuthRouter(deps: Partial<AuthRouterDeps> = {}): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const router: IRouter = Router();

  // POST /auth/signup
  router.post("/auth/signup", authLimiter, async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const { email, password, firstName, lastName, zipCode, timezone } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    try {
      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing) {
        return res.status(400).json({ error: "email already registered" });
      }

      const passwordHash = await hashPassword(password);
      const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      // Create user and subscription in a transaction — every user has a Subscription row.
      const user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email: normalizedEmail,
            passwordHash,
            firstName,
            lastName,
            zipCode: zipCode ?? null,
            timezone: timezone ?? "America/New_York",
          },
        });
        const subscription = await tx.subscription.create({
          data: {
            userId: newUser.id,
            planCode: "free",
            status: "trialing",
            trialEndsAt,
          },
        });
        return { ...newUser, subscription };
      });

      const token = signToken(user.id);
      logger.info({ userId: user.id }, "User signed up");
      return res.status(201).json({
        user: {
          ...toUserShape(user),
          subscription: toSubscriptionShape(user.subscription),
        },
        authToken: token,
        onboardingRequired: true,
      });
    } catch (err) {
      logger.error({ err }, "Signup failed");
      return res.status(500).json({ error: "signup failed" });
    }
  });

  // POST /auth/login
  router.post("/auth/login", authLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
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
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: "invalid credentials" });
      }
      if (user.accountStatus !== "active") {
        return res.status(403).json({ error: "account not active" });
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "invalid credentials" });
      }

      // Update last-login tracking. Non-critical if this fails — don't block login.
      await prisma.user
        .update({
          where: { id: user.id },
          data: {
            lastLoginAt: new Date(),
            loginCountTotal: { increment: 1 },
          },
        })
        .catch((err) => {
          logger.warn({ err, userId: user.id }, "Failed to update login tracking");
        });

      const token = signToken(user.id);
      logger.info({ userId: user.id }, "User logged in");
      return res.json({
        user: {
          ...toUserShape(user),
          subscription: user.subscription
            ? toSubscriptionShape(user.subscription)
            : null,
        },
        authToken: token,
      });
    } catch (err) {
      logger.error({ err }, "Login failed");
      return res.status(500).json({ error: "login failed" });
    }
  });

  // POST /auth/logout
  // Client-side logout — server just acknowledges.
  // TODO(future): add jti blocklist for real server-side revocation.
  router.post("/auth/logout", async (_req, res) => {
    return res.json({ success: true });
  });

  // POST /auth/password-reset/request
  // Always returns success to prevent email enumeration.
  // Reset tokens carry purpose='password_reset' and expire after 1h (WS7-2
  // Block A — tighter than the 30d session default).
  // D-WS7-022 (deferred): real email delivery infra lands in WS9A polish.
  router.post("/auth/password-reset/request", resetLimiter, async (req, res) => {
    const parsed = resetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const normalizedEmail = parsed.data.email.toLowerCase().trim();

    try {
      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (user) {
        const resetToken = signToken(user.id, {
          purpose: "password_reset",
          expiresIn: PASSWORD_RESET_EXPIRY,
        });
        logger.info(
          { userId: user.id, resetToken },
          "Password reset requested — would email this token to the user",
        );
      }
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Password reset request failed");
      // Still return success to avoid enumeration via timing/status differences.
      return res.json({ success: true });
    }
  });

  // POST /auth/password-reset/confirm
  router.post("/auth/password-reset/confirm", authLimiter, async (req, res) => {
    const parsed = resetConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request body" });
    }
    const { token, newPassword } = parsed.data;

    const payload = verifyToken(token, "password_reset");
    if (!payload) {
      return res.status(400).json({ error: "invalid or expired reset token" });
    }

    try {
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (!user || user.accountStatus !== "active") {
        return res.status(400).json({ error: "invalid or expired reset token" });
      }

      const passwordHash = await hashPassword(newPassword);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });

      logger.info({ userId: user.id }, "Password reset completed");
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Password reset confirm failed");
      return res.status(500).json({ error: "password reset failed" });
    }
  });

  // GET /auth/me
  router.get("/auth/me", requireAuth, meLimiter, async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        include: { subscription: true },
      });
      if (!user) {
        // Token valid but user deleted — client should treat as logout.
        return res.status(401).json({ error: "user not found" });
      }
      return res.json({
        user: {
          ...toUserShape(user),
          subscription: user.subscription
            ? toSubscriptionShape(user.subscription)
            : null,
        },
      });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "Fetch /auth/me failed");
      return res.status(500).json({ error: "failed to fetch user" });
    }
  });

  return router;
}

// Default export — uses the production Prisma singleton, mounted by routes/index.ts.
const router: IRouter = createAuthRouter();
export default router;
