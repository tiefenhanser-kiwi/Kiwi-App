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
import { resolveStoreComposeConfig } from "./storeComposeConfig";
import {
  buildStoreShortlist,
  emptyShortlist,
  type StoreShortlist,
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
