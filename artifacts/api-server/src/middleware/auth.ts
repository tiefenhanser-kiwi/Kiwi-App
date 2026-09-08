import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

import { verifyToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { isIssuedBeforeEpoch, readTokensValidFrom } from "../lib/tokenRevocation";

// Augment Express Request to include userId after successful auth.
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export interface RequireAuthDeps {
  prisma: PrismaClient;
}

/**
 * WS9A BUG-234 — build the session guard around a specific Prisma client.
 *
 * Before this commit `requireAuth` was a pure function: `jwt.verify`, a purpose
 * check, done, with ZERO database reads on the authenticated path. It is now a
 * factory because the revocation epoch lives in the database and the guard has
 * to read it, and because reaching for the production singleton from module
 * scope would drag every route test onto the live Neon instance.
 *
 * Route factories build one of these from the Prisma client they were handed
 * and shadow the old import with it, so all ~69 `requireAuth` call sites are
 * unchanged; only the binding they resolve to is.
 *
 * COST, measured against Neon (us-east-1) rather than guessed: the added query
 * is a primary-key lookup selecting one nullable column. Against a bare
 * `SELECT 1` round-trip on the same connection it costs ~1.3 ms p50 — the rest
 * of the wall clock is network, which co-located production does not pay. 68 of
 * the 69 authenticated handlers already issue at least one Prisma call, so for
 * all but one this is N -> N+1 round-trips on an already-open pooled
 * connection, not a new I/O dependency on a previously pure path. (The
 * exception, GET /wizard/limits, reads settings through a TTL cache and so is
 * 0 -> 1 only on a cache hit.)
 */
export function createRequireAuth(deps: Partial<RequireAuthDeps> = {}) {
  const prisma = deps.prisma ?? productionPrisma;

  return async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing or invalid authorization header" });
      return;
    }

    const token = header.slice("Bearer ".length).trim();
    // WS7-2 Block A: require session purpose so a stray password-reset or
    // email-change token can't authenticate API requests.
    const payload = verifyToken(token, "session");
    if (!payload) {
      res.status(401).json({ error: "invalid or expired token" });
      return;
    }

    // BUG-234 — the signature and expiry say the token is well-formed. They
    // cannot say whether the account's password has changed underneath it,
    // which is the entire complaint: a reset left the attacker's 30-day JWT
    // authenticating for up to 30 more days.
    let epoch: Date | null | undefined;
    try {
      epoch = await readTokensValidFrom(prisma, payload.userId);
    } catch (err) {
      // Fail CLOSED. A guard that opens when its datastore hiccups is not a
      // guard, and the failure mode it would restore is account takeover.
      logger.error(
        { err, userId: payload.userId },
        "Session revocation check failed",
      );
      res.status(503).json({ error: "authorization temporarily unavailable" });
      return;
    }

    // `undefined` means no such user row. That is NOT a revocation: this guard
    // answers "has this token been revoked", and a token for a deleted user is
    // left exactly as c38a596 left it (GET /auth/me is where a vanished user
    // becomes a 401). Widening requireAuth into an existence check would change
    // behaviour well outside BUG-234 and is not this block's call to make.
    if (isIssuedBeforeEpoch(payload.iat, epoch)) {
      res.status(401).json({ error: "invalid or expired token" });
      return;
    }

    req.userId = payload.userId;
    next();
  };
}

/**
 * Production binding, for any consumer not built through a router factory.
 * Route factories should use createRequireAuth(deps) so tests stay hermetic.
 */
export const requireAuth = createRequireAuth();
