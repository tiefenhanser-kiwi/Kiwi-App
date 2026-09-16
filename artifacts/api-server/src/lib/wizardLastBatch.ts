// Plan-Gen Arc Block 4b-3 (D-WS9-072) — "last generated plan-options batch"
// persistence.
//
// The generate routes (build-plans, build-from-text; Surprise-me until Block 2
// retired it) return candidate cards but persist nothing — the batch dies with the client screen
// (Phase 0 finding). This module gives that batch a durable, server-authoritative
// home so the "See Previous Options" surface can re-show the last run without
// regenerating.
//
// Model: EXACTLY ONE row per user (WizardLastBatch.userId @unique). Each
// successful generation UPSERTS the row; that overwrite IS "generation clears"
// (Hans's single-rule refinement). Nothing else clears it — not activation, not
// preference changes. The batch is a SNAPSHOT by design; there is deliberately
// no preference-hash invalidation or allergen re-check here (D-WS9-085 ruling).
//
// Persistence is isolated behind two swappable functions so route tests can
// inject recording stubs, and a future ephemeral swap is mechanical.

import { Prisma, type PrismaClient } from "@prisma/client";

import { logger } from "./logger";
import type { WizardPlanCandidate } from "./ai/schemas/wizard";

// Which generate surface produced the batch. Rehydrate (Part 1b) branches on
// this to rebuild candidateContext: "wizard"/"tellkiwi" replay `input`.
// WS9 Redesign Arc Block 2 (Part C) — "surprise" is retired from the WRITE
// union (the route is deleted, D-WS9-237). Rows written before Block 2 still
// carry it; the READ type below keeps a legacy branch so those rows parse —
// forward-only, no data migration (D-WS9-230).
// WS9 Redesign Arc post-pass (Part A, [WS9-arc-PS-A]) — "shelf" joins the
// write union: the slot holds whatever chunk of suggestions was LAST presented,
// plan candidates OR the Pick screen's meal cards, last one wins. The `source`
// column is a plain String so this needs no migration; a shelf batch carries
// its ordered meal refs in the Json payload (`shelf`), candidates [].
export type WizardBatchSource = "wizard" | "tellkiwi" | "shelf";
/** What a stored row may still say: the write union plus the retired value. */
export type WizardBatchSourceOnRead = WizardBatchSource | "surprise";

// A shelf batch's per-card presentation, minus the card body: the ORDERED ids
// that were on screen plus the flags the Pick screen rendered them with. The
// read side re-resolves the ids to CURRENT cards (a meal deleted or archived
// since simply drops out) and re-applies these flags — the card body is never
// snapshotted, so "previous options" never shows stale titles or macros.
export interface WizardLastBatchShelfMealRef {
  id: string;
  isNewToYou: boolean;
  isPlaylist: boolean;
  isPinned: boolean;
  matchesCuisine: boolean | null;
  source: "playlist" | "shelf";
}

export interface WizardLastBatchShelf {
  meals: WizardLastBatchShelfMealRef[];
  totalEligible: number;
  hasMore: boolean;
  unmatchedNames: string[];
  metadata: unknown;
}

// The stored blob. `input` is the request slice a later expand needs to rebuild
// candidateContext (see the route write sites); null on legacy surprise rows. Kept as
// `unknown` here — its shape is the write↔rehydrate contract, not this module's
// concern, and it rides in a Json column so it never needs a migration to evolve.
export interface WizardLastBatchPayload {
  source: WizardBatchSourceOnRead;
  candidates: WizardPlanCandidate[];
  input: unknown | null;
  /** Non-null only on a `source: "shelf"` batch; absent on rows written before Part A. */
  shelf?: WizardLastBatchShelf | null;
}

export interface PersistWizardLastBatchOptions {
  prisma: PrismaClient;
  userId: string;
  source: WizardBatchSource;
  candidates: WizardPlanCandidate[];
  input: unknown | null;
  shelf?: WizardLastBatchShelf | null;
}

/**
 * Upsert the user's single last-batch row. The upsert IS the clear: a prior
 * batch is overwritten, never appended. Bumps createdAt on overwrite because an
 * overwrite is a brand-new batch (a new generation), so createdAt reads as the
 * batch's generation time.
 *
 * Best-effort by design: the caller has ALREADY produced the candidates and is
 * about to return them, so a persistence failure must NOT sink a successful
 * generation. Failures are logged and swallowed; the worst case is that "See
 * Previous Options" misses this one run.
 */
export async function persistWizardLastBatch(
  opts: PersistWizardLastBatchOptions,
): Promise<void> {
  const payload: WizardLastBatchPayload = {
    source: opts.source,
    candidates: opts.candidates,
    input: opts.input ?? null,
    shelf: opts.shelf ?? null,
  };
  try {
    await opts.prisma.wizardLastBatch.upsert({
      where: { userId: opts.userId },
      create: {
        userId: opts.userId,
        source: opts.source,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
      update: {
        source: opts.source,
        payload: payload as unknown as Prisma.InputJsonValue,
        // A new generation is a new batch — reset the generation timestamp.
        createdAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn(
      { event: "wizard_last_batch_persist_failed", userId: opts.userId, err },
      "Failed to persist wizard last-batch",
    );
  }
}

export interface WizardLastBatchRecord {
  source: string;
  payload: WizardLastBatchPayload;
  createdAt: Date;
}

/**
 * Read the user's last batch, or null when they have none (new users, or a
 * user who has never generated). Never throws — a read failure degrades to null
 * (the no-batch case), so the "See Previous Options" link simply hides.
 */
export async function readWizardLastBatch(opts: {
  prisma: PrismaClient;
  userId: string;
}): Promise<WizardLastBatchRecord | null> {
  try {
    const row = await opts.prisma.wizardLastBatch.findUnique({
      where: { userId: opts.userId },
      select: { source: true, payload: true, createdAt: true },
    });
    if (!row) return null;
    return {
      source: row.source,
      payload: row.payload as unknown as WizardLastBatchPayload,
      createdAt: row.createdAt,
    };
  } catch (err) {
    logger.warn(
      { event: "wizard_last_batch_read_failed", userId: opts.userId, err },
      "Failed to read wizard last-batch",
    );
    return null;
  }
}
