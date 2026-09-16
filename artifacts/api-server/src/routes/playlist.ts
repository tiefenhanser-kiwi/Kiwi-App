// WS9 Redesign Arc Block 1 — the Playlist (D-WS9-234 / D-WS9-244).
//
// A per-user DECLARED set of go-to meals — never derived from cook counts
// (cook tracking is dead, BUG-275). The fifth nav tab lists them; "Plan a week
// from these" is POST /wizard/shelf with playlistOnly:true. A sibling of
// Favorite, not a reuse of it: D-WS9-234 keeps affection (favorites) and
// planning signal (playlist) apart.
//
// Adding a PUBLIC catalog meal is an ACQUISITION (D-WS7-139 fork-on-acquire):
// the route forks it and stores the FORK's id, so PlaylistMeal.mealId is
// always a meal the user owns. Adding the same catalog meal again resolves to
// the existing fork by lineage (sourceStoreMealId) — no second fork. An owned
// meal is stored as-is; anyone else's private meal is 403. Bulk intake is
// post-launch; no "last cooked" at launch.

import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { forkMealForUser } from "../lib/mealFork";
import { MEAL_CARD_SELECT, toMealCard } from "../lib/store/mealCard";
import { createRequireAuth } from "../middleware/auth";

export interface PlaylistRouterDeps {
  prisma: PrismaClient;
}

const playlistAddSchema = z.object({
  mealId: z.string().min(1).max(100),
});

export function createPlaylistRouter(
  deps: Partial<PlaylistRouterDeps> = {},
): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  // WS9A BUG-234 — the session guard reads User.tokensValidFrom through the
  // injected client, keeping this router's tests hermetic.
  const requireAuth = createRequireAuth({ prisma });
  const router: IRouter = Router();

  // GET /me/playlist — the user's playlist meals as Pick-screen cards, newest
  // first, REAL ids (always the user's own meal ids).
  router.get("/me/playlist", requireAuth, async (req, res) => {
    const userId = req.userId!;
    try {
      const rows = await prisma.playlistMeal.findMany({
        where: { userId, meal: { isArchived: false } },
        orderBy: { createdAt: "desc" },
        select: {
          createdAt: true,
          meal: { select: MEAL_CARD_SELECT },
        },
      });
      const playlist = rows.map((r) => ({
        ...toMealCard(r.meal),
        isPlaylist: true as const,
        isNewToYou: false as const,
        source: "playlist" as const,
        addedAt: r.createdAt.toISOString(),
      }));
      return res.json({ playlist, count: playlist.length });
    } catch (err) {
      logger.error({ err, userId }, "GET /me/playlist failed");
      return res.status(500).json({ error: "failed to fetch playlist" });
    }
  });

  // POST /me/playlist { mealId } — add. Public catalog meal → fork-on-acquire
  // (idempotent by lineage); owned → store as-is (idempotent on the unique);
  // anyone else's private meal → 403; missing / archived → 404.
  router.post("/me/playlist", requireAuth, async (req, res) => {
    const userId = req.userId!;
    const parsed = playlistAddSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid body" });
    }
    const { mealId } = parsed.data;
    try {
      const meal = await prisma.meal.findUnique({
        where: { id: mealId },
        select: { id: true, userId: true, isPublic: true, isArchived: true },
      });
      if (!meal || meal.isArchived) {
        return res.status(404).json({ error: "meal not found" });
      }
      const owned = meal.userId === userId;
      if (!owned && !meal.isPublic) {
        return res.status(403).json({ error: "forbidden" });
      }

      const result = await prisma.$transaction(async (tx) => {
        let boundMealId = mealId;
        let forked = false;
        if (!owned) {
          // Already acquired onto the playlist? Resolve by lineage — a second
          // add of the same catalog meal must not mint a second fork.
          const existing = await tx.playlistMeal.findFirst({
            where: {
              userId,
              meal: { sourceStoreMealId: mealId, isArchived: false },
            },
            select: { id: true, mealId: true, createdAt: true },
          });
          if (existing) {
            return { row: existing, forked: false, sourceMealId: mealId };
          }
          boundMealId = (await forkMealForUser(tx, mealId, userId)).mealId;
          forked = true;
        }
        const row = await tx.playlistMeal.upsert({
          where: { userId_mealId: { userId, mealId: boundMealId } },
          update: {},
          create: { userId, mealId: boundMealId },
          select: { id: true, mealId: true, createdAt: true },
        });
        return { row, forked, sourceMealId: owned ? null : mealId };
      });

      return res.status(201).json({
        playlistMeal: {
          id: result.row.id,
          mealId: result.row.mealId,
          sourceMealId: result.sourceMealId,
          forked: result.forked,
          createdAt: result.row.createdAt.toISOString(),
        },
      });
    } catch (err) {
      logger.error({ err, userId, mealId }, "POST /me/playlist failed");
      return res.status(500).json({ error: "failed to add to playlist" });
    }
  });

  // DELETE /me/playlist/:mealId — remove the entry (the meal itself stays).
  // Idempotent: 204 whether or not it was there.
  router.delete("/me/playlist/:mealId", requireAuth, async (req, res) => {
    const userId = req.userId!;
    const mealId = req.params.mealId;
    if (!mealId || typeof mealId !== "string") {
      return res.status(400).json({ error: "mealId required" });
    }
    try {
      await prisma.playlistMeal.deleteMany({ where: { userId, mealId } });
      return res.status(204).end();
    } catch (err) {
      logger.error({ err, userId, mealId }, "DELETE /me/playlist failed");
      return res.status(500).json({ error: "failed to remove from playlist" });
    }
  });

  return router;
}

const playlistRouter: IRouter = createPlaylistRouter();
export default playlistRouter;
