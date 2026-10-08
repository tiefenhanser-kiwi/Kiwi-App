// Row 13 "Test Kitchen" · Block 1 (D-WS9-259) — the guest guard.
//
// A SIBLING of middleware/auth.ts, never a second mode inside it: requireAuth
// guards ~69 handlers and every one of them assumes `req.userId` names a real
// User row (it now also 401s when that row has vanished — D-WS9-257). Teaching
// it a second identity kind would put that assumption at risk on 69 paths to
// serve the four this block opens.
//
// Order is deliberate: GUEST FIRST, then delegate. A guest token cannot pass
// requireAuth (wrong purpose, and no User row for the epoch read), so trying
// the cheap purpose-scoped verify first costs one jwt.verify and saves the
// guest path a 401-then-retry. A session token fails the guest verify on
// purpose and falls straight through to the real guard, unchanged.

import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

import { verifyToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { createRequireAuth } from "./auth";

// Augment Express Request beside `userId` (declared in middleware/auth.ts).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set ONLY by requireGuestOrAuth, and only for a real guest token. */
      guestSessionId?: string;
    }
  }
}

/** 24 h — the guest token's life and the GuestSession row's usable window. */
export const GUEST_TOKEN_EXPIRY = "24h";
export const GUEST_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface RequireGuestOrAuthDeps {
  prisma: PrismaClient;
}

/**
 * The shared limiter key. Guests and users share the same buckets and the same
 * budgets — a guest is just another principal — but the two namespaces can
 * never collide, which `req.userId ?? "anonymous"` alone could not promise once
 * a guest id started arriving in that slot.
 *
 * "anonymous" is preserved verbatim for the no-principal case so no existing
 * bucket key changes shape for traffic that was already reaching these routes.
 */
export function principalKey(req: Request): string {
  if (req.guestSessionId) return `guest:${req.guestSessionId}`;
  if (req.userId) return `user:${req.userId}`;
  return "anonymous";
}

/**
 * Guest-ONLY. A signed-in user hitting these has no business here. Mounted
 * after requireGuestOrAuth. Lives here, beside principalKey, so the one guest
 * route in the wizard router (POST /guest/plan-from-picks, Resubmission G1)
 * and the routes in routes/guest.ts share it.
 */
export function guestOnly(req: Request, res: Response, next: NextFunction): void {
  if (!req.guestSessionId) {
    res.status(403).json({ code: "guest_only" });
    return;
  }
  next();
}

export function createRequireGuestOrAuth(
  deps: Partial<RequireGuestOrAuthDeps> = {},
) {
  const prisma = deps.prisma ?? productionPrisma;
  const requireAuth = createRequireAuth({ prisma });

  return async function requireGuestOrAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const header = req.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : null;

    // Not a guest token (wrong purpose, malformed, expired signature) → this
    // is a session request or a bad one; requireAuth owns the verdict either
    // way, including the 401 wording.
    const payload = token ? verifyToken(token, "guest") : null;
    if (!payload) {
      await requireAuth(req, res, next);
      return;
    }

    // The signature says the session id is authentic. It cannot say the row is
    // still usable — expired, or already claimed by a sign-up (at which point
    // the visitor has a real session token and the guest token is spent).
    let row: {
      id: string;
      expiresAt: Date;
      claimedAt: Date | null;
    } | null;
    try {
      row = await prisma.guestSession.findUnique({
        where: { id: payload.userId },
        select: { id: true, expiresAt: true, claimedAt: true },
      });
    } catch (err) {
      // Fail CLOSED, same posture as requireAuth's epoch read: a guard that
      // opens when its datastore hiccups is not a guard.
      logger.error(
        { event: "guest_session_read_failed", err },
        "Guest session lookup failed",
      );
      res.status(503).json({ error: "authorization temporarily unavailable" });
      return;
    }

    if (!row || row.claimedAt !== null || row.expiresAt.getTime() <= Date.now()) {
      res.status(401).json({ error: "invalid or expired guest session" });
      return;
    }

    req.guestSessionId = row.id;
    next();
  };
}

/** Production binding, for any consumer not built through a router factory. */
export const requireGuestOrAuth = createRequireGuestOrAuth();
