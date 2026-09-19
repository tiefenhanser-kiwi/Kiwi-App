// WS9 Redesign Arc Block 1 — the shared shelf retrieval, relocated out of
// routes/wizard.ts so POST /wizard/shelf (the Pick screen) and the three
// compose routes (build-plans, build-from-text, surprise-me) retrieve the same
// way. Behaviour for the three existing callers is unchanged: same rotation
// salt, same config, same best-effort fallback.
//
// D-WS9-038 / BUG-039 — shared catalog-compose retrieval. All generate
// endpoints hand the AI the same shelf and reconcile the same way; this
// centralizes the retrieval + its best-effort fallback (a retrieval failure or
// thin catalog → empty shelf → the AI composes fully live, never a 500).

import type { PrismaClient } from "@prisma/client";

import { logger } from "../logger";
import { allergenTokensForUser, allergenWhereConditions } from "./allergenFilter";
import { resolveStoreComposeConfig } from "./storeComposeConfig";
import {
  allowedDifficultyLevels,
  buildStoreShortlist,
  emptyShortlist,
  type StoreShortlist,
  type StoreShortlistMeal,
} from "./storeShortlist";

export interface RetrieveShelfOptions {
  cuisines: string[];
  allergiesAndAvoidances: string[];
  difficulty: string;
  userId: string;
  excludeMealIds?: string[];
  // D-WS7-166 — the cook-time cap, from the D-WS7-198 RESOLVED bag (never the
  // raw client field: an explicit per-run null means "no limit this plan" and
  // must reach the shelf as no term, which only the resolver's presence check
  // preserves). The shelf is the ONLY place the cap can bite for a catalog
  // meal — catalog slots skip the expand AI (wizardExpansion.ts) and with it
  // wizard.candidate.expand's cap instruction.
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: string;
  /**
   * WS9 Redesign Arc Block 1 — the Pick screen asks for exactly the number of
   * cards it will show (the remainder after playlist + pinned meals), not the
   * compose shelf's 40. Absent → the compose config's shortlistSize (the three
   * compose callers never pass it).
   */
  shortlistSize?: number;
}

export async function retrieveShelf(
  prisma: PrismaClient,
  opts: RetrieveShelfOptions,
): Promise<StoreShortlist> {
  try {
    // Rotation salt (Block 4b-1) — the user's saved-plan count. Seeds shortlist
    // variety across a user's plans; deterministic within a request (build-plans
    // and expand of the same plan share one salt).
    const rotationSalt = await prisma.mealPlanInstance.count({
      where: { userId: opts.userId, isWizardDraft: false },
    });
    const config = resolveStoreComposeConfig();
    return await buildStoreShortlist(prisma, {
      cuisines: opts.cuisines,
      allergiesAndAvoidances: opts.allergiesAndAvoidances,
      difficulty: opts.difficulty,
      userId: opts.userId,
      rotationSalt,
      excludeMealIds: opts.excludeMealIds,
      maxCookTimeMinutes: opts.maxCookTimeMinutes,
      maxCookTimeCoverage: opts.maxCookTimeCoverage,
      config:
        opts.shortlistSize === undefined
          ? config
          : { ...config, shortlistSize: opts.shortlistSize },
    });
  } catch (err) {
    logger.warn(
      { event: "wizard_store_shortlist_failed", err },
      "Store shortlist retrieval failed — composing fully live",
    );
    return emptyShortlist();
  }
}

// ── WS9 Redesign Arc Block 2 (Part E) — the user's playlist ON the shelf ─────
//
// Block 1 gave the Playlist dial a count (preferencesContext.playlistMealsPerWeek)
// but the generate shelf never carried the user's playlist meals and neither
// generate body named them — a dial that visibly did nothing (D-WS7-202). The
// smallest honest fix: put the playlist's PUBLIC SOURCES on the shelf, marked,
// and let one instruction in each body place N of them.
//
// Why the public source and not the user's own fork (for an ACQUIRED go-to):
// the compose pipeline forks the source at save (D-WS7-139), so the source is
// the id that binds. Post-pass Part C (BUG-281) — a playlist meal the user
// BUILT themselves (imported, no public source) rides the shelf under its REAL
// id: the save predicate is now owner-OR-pool (wizardFinalize →
// filterBindableStoreMealIds) and an own id is placed DIRECT, no fork — the
// same branch POST /plans/from-meals has. Before this, the isPublic:true
// revalidation demoted such an id to a live rebuild, so an imported go-to was
// invisible to the "Complete plans" path.
//
// Allergen filter + the difficulty ceiling apply (as on the Pick screen's
// playlist rows); the cook-time cap does NOT (BUG-245's ruling: a declared
// favourite over the cap is offered with its honest time). Newest first,
// capped so a long playlist cannot bloat the prompt.

export const PLAYLIST_SHELF_CAP = 20;

export interface PlaylistShelfOptions {
  userId: string;
  allergiesAndAvoidances: string[];
  difficulty: string;
}

/**
 * Return the shelf with the user's playlist sources present and flagged:
 * a source already sampled onto the shelf is marked in place; the rest are
 * appended under `p<n>` aliases (the reconcile map translates any alias).
 * Best-effort: a read failure leaves the shelf as it was.
 */
export async function addPlaylistToShelf(
  prisma: PrismaClient,
  shortlist: StoreShortlist,
  opts: PlaylistShelfOptions,
): Promise<StoreShortlist> {
  try {
    const rows = await prisma.playlistMeal.findMany({
      where: {
        userId: opts.userId,
        meal: { isArchived: false },
      },
      orderBy: { createdAt: "desc" },
      select: { mealId: true, meal: { select: { sourceStoreMealId: true } } },
      take: PLAYLIST_SHELF_CAP,
    });
    // An acquired go-to rides as its public SOURCE (forked at save); a
    // user-built one (no source) rides as ITSELF (bound direct at save).
    const sourceIds = [
      ...new Set(
        rows
          .map((r) => r.meal.sourceStoreMealId ?? r.mealId)
          .filter((x): x is string => !!x),
      ),
    ];
    if (sourceIds.length === 0) return shortlist;

    const allergenConditions = allergenWhereConditions(
      allergenTokensForUser(opts.allergiesAndAvoidances),
    );
    const sources = await prisma.meal.findMany({
      where: {
        id: { in: sourceIds },
        // Owner-OR-pool — the same predicate the save path re-checks.
        OR: [{ isPublic: true }, { userId: opts.userId }],
        isArchived: false,
        difficulty: { in: allowedDifficultyLevels(opts.difficulty) },
        ...(allergenConditions.length > 0 ? { AND: allergenConditions } : {}),
      },
      select: {
        id: true,
        title: true,
        cuisineType: true,
        difficulty: true,
        estimatedTimeMinutes: true,
        tags: true,
        caloriesPerServing: true,
        proteinGPerServing: true,
        carbsGPerServing: true,
        fatGPerServing: true,
        // D-WS9-191 — the wire meals[] reads the row's own description.
        description: true,
        // Row 5 Block 4 — and its own image (the plan-option thumb).
        imageUrl: true,
      },
    });
    if (sources.length === 0) return shortlist;
    const byId = new Map(sources.map((m) => [m.id, m]));

    const idToAlias = new Map<string, string>();
    for (const [alias, id] of shortlist.aliasToId) idToAlias.set(id, alias);
    const forPrompt: StoreShortlistMeal[] = shortlist.forPrompt.map((m) => {
      const real = shortlist.aliasToId.get(m.id);
      return real && byId.has(real) ? { ...m, isPlaylist: true } : m;
    });
    const aliasToId = new Map(shortlist.aliasToId);
    const selectedIds = [...shortlist.selectedIds];
    // D-WS9-191 — the appended playlist rows carry their own description and
    // time into the pre-loaded maps (an in-place-marked row is already there).
    const descriptionById = new Map(shortlist.descriptionById);
    const timeById = new Map(shortlist.timeById);
    const imageUrlById = new Map(shortlist.imageUrlById);
    let n = 0;
    // Keep the playlist's own order (newest first) for the appended rows.
    for (const id of sourceIds) {
      const row = byId.get(id);
      if (!row || idToAlias.has(id)) continue;
      const alias = `p${++n}`;
      aliasToId.set(alias, row.id);
      selectedIds.push(row.id);
      descriptionById.set(row.id, row.description ?? null);
      timeById.set(row.id, row.estimatedTimeMinutes);
      imageUrlById.set(row.id, row.imageUrl ?? null);
      forPrompt.push({
        id: alias,
        title: row.title,
        cuisineType: row.cuisineType,
        difficulty: row.difficulty,
        estimatedTimeMinutes: row.estimatedTimeMinutes,
        tags: row.tags,
        macros: {
          caloriesPerServing: row.caloriesPerServing,
          proteinGPerServing: row.proteinGPerServing,
          carbsGPerServing: row.carbsGPerServing,
          fatGPerServing: row.fatGPerServing,
        },
        isPlaylist: true,
      });
    }
    return {
      ...shortlist,
      forPrompt,
      aliasToId,
      selectedIds,
      descriptionById,
      timeById,
      imageUrlById,
    };
  } catch (err) {
    logger.warn(
      { event: "wizard_playlist_shelf_failed", userId: opts.userId, err },
      "Playlist shelf read failed — shelf served without playlist rows",
    );
    return shortlist;
  }
}
