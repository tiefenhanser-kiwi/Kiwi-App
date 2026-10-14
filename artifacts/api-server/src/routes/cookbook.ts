// BOOK-1S (D-WS9-312) — the Kiwi Cookbook inside the app.
//
// GET /cookbook/meals — browse and search the public catalog (lib/cookbook/
// search.ts holds the contract). Members only: requireAuth refuses a guest
// token (purpose "guest"), and the Test Kitchen keeps its own path.
//
// No entitlement check, deliberately: D-WS9-270 lists "cookbook … catalog
// search" among what keeps working without AI after the trial, so a lapsed
// account browses. The writes a card leads to — add to a plan, swap, save to
// the Playlist — keep exactly the gates they already have.

import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";

import { CookbookQuerySchema } from "../lib/cookbook/query";
import { InvalidCursorError, searchCookbook } from "../lib/cookbook/search";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { createRequireAuth } from "../middleware/auth";

export interface CookbookRouterDeps {
  prisma: PrismaClient;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
}

export function createCookbookRouter(deps: Partial<CookbookRouterDeps> = {}): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const requireAuth = createRequireAuth({ prisma });
  // Every request reads the whole eligible catalog's light columns, so a
  // per-user bucket: a burst of 60 covers a typing user's debounced queries
  // with room to spare, and the refill is one search a second.
  const searchLimiter = rateLimit({
    ...(deps.rateLimiterOpts ?? { capacity: 60, refillPerSec: 1 }),
    keyFn: (req) => `cookbook:${req.userId ?? "anonymous"}`,
  });
  const router: IRouter = Router();

  router.get("/cookbook/meals", requireAuth, searchLimiter, async (req, res) => {
    const userId = req.userId!;
    const parsed = CookbookQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid query", details: parsed.error.flatten() });
    }
    try {
      return res.json(await searchCookbook(prisma, userId, parsed.data));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return res.status(400).json({ error: "invalid cursor" });
      }
      logger.error({ err, userId }, "GET /cookbook/meals failed");
      return res.status(500).json({ error: "failed to search the cookbook" });
    }
  });

  return router;
}

const cookbookRouter: IRouter = createCookbookRouter();
export default cookbookRouter;
