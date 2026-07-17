// Plan-Gen Arc · Block 2 · D-WS9-038 — the store's read path (retrieval half).
//
// buildStoreShortlist assembles the "ingredient shelf" the build-plans AI
// composes from: a ranked slice of shared-pool dinner Meals matched against the
// user's effective preferences. The AI (not this code) makes the per-slot
// store-vs-live call — this function's job is to hand it a relevant, generous
// shelf and let it reason about fit / variety / ingredient optimization
// holistically. Deliberately light on hard filtering (over-filtering defeats
// "AI composes"): only truly-disqualifying rows are excluded; cuisine and
// difficulty are soft ranking signals the AI then honors per its prompt.
//
// Pool predicate = isPublic:true (Phase 0 ruling, D-WS9-036): this already spans
// both userId:null system/curated meals AND owned-but-public community meals.
// Each offered meal is re-validated isPublic:true AGAIN at fork time (save
// path) — the shortlist is a suggestion, never a trust boundary.
//
// reconcileStoreSlots is the post-AI guard: the model can only mark a slot as
// store-filled with an id we actually offered, and only at an in-range slot.
// Hallucinated / out-of-range marks are dropped, demoting those slots to live.

import type { PrismaClient } from "@prisma/client";

import type { StoreComposeConfig } from "./storeComposeConfig";
import type { WizardPlanCandidate } from "../ai/schemas/wizard";

// Difficulty ordering for the ceiling signal.
const DIFFICULTY_RANK: Record<string, number> = {
  easy: 0,
  medium: 1,
  fancy: 2,
};

// The per-meal shape handed to the compose AI. Lean but enough to reason about
// fit + macros. `id` is a SHORT per-shortlist alias (m1, m2, …) the AI echoes
// back in storeSlots; reconcileStoreSlots maps it to the real Meal.id.
export interface StoreShortlistMeal {
  id: string;
  title: string;
  cuisineType: string | null;
  difficulty: string;
  estimatedTimeMinutes: number;
  tags: string[];
  macros: {
    caloriesPerServing: number;
    proteinGPerServing: number;
    carbsGPerServing: number;
    fatGPerServing: number;
  };
}

export interface StoreShortlist {
  /** JSON-serializable shelf for the {{storeShortlist}} prompt slot. */
  forPrompt: StoreShortlistMeal[];
  /**
   * BUG-039 / scale — maps each shelf meal's SHORT per-shortlist alias
   * (`m1`, `m2`, … in forPrompt.id) to its real Meal.id (UUID). The AI only
   * ever sees + echoes the alias (token-cheap, collision-free at thousands of
   * meals — the shortlist is capped at shortlistSize regardless of catalog
   * size), and reconcileStoreSlots translates the alias back to the real id
   * before it hits the wire. So expand/save downstream always see real ids.
   */
  aliasToId: Map<string, string>;
}

export interface BuildStoreShortlistOptions {
  cuisines: string[];
  /** The user's difficulty ceiling (easy | medium | fancy). */
  difficulty: string;
  /** Meal ids to exclude (recent history — avoid repeats). */
  excludeMealIds?: string[];
  config: StoreComposeConfig;
}

// Over-fetch factor: pull more than shortlistSize from the DB, score, then trim.
// Cheap headroom so ranking isn't decided by the DB's arbitrary row order.
const OVERFETCH = 4;
const OVERFETCH_CAP = 400;

/**
 * Retrieve + rank the shared-pool shortlist for a compose request. Returns an
 * empty shelf (not an error) when the store is thin — the caller then composes
 * fully-live, which is the structural graceful-degrade (D-WS9-037).
 */
export async function buildStoreShortlist(
  prisma: PrismaClient,
  opts: BuildStoreShortlistOptions,
): Promise<StoreShortlist> {
  const { config } = opts;
  if (config.shortlistSize <= 0) {
    return { forPrompt: [], aliasToId: new Map() };
  }

  const take = Math.min(config.shortlistSize * OVERFETCH, OVERFETCH_CAP);
  const rows = await prisma.meal.findMany({
    where: {
      isPublic: true,
      isArchived: false,
      mealType: "dinner",
      ...(opts.excludeMealIds && opts.excludeMealIds.length > 0
        ? { id: { notIn: opts.excludeMealIds } }
        : {}),
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
      useCount: true,
      likeCount: true,
      createdAt: true,
    },
    // Popular first, so an over-fetch that can't hold the whole pool still
    // captures the strongest candidates before scoring re-ranks them.
    orderBy: [{ useCount: "desc" }, { likeCount: "desc" }, { createdAt: "desc" }],
    take,
  });

  const cuisineSet = new Set(
    opts.cuisines.map((c) => c.trim().toLowerCase()).filter(Boolean),
  );
  const ceiling = DIFFICULTY_RANK[opts.difficulty] ?? DIFFICULTY_RANK.fancy;
  const maxPopularity = rows.reduce(
    (m, r) => Math.max(m, r.useCount + r.likeCount),
    0,
  );

  const scored = rows.map((r) => {
    let score = 0.4; // passed the hard filters
    if (
      r.cuisineType &&
      cuisineSet.has(r.cuisineType.trim().toLowerCase())
    ) {
      score += 0.35;
    }
    const rank = DIFFICULTY_RANK[r.difficulty] ?? DIFFICULTY_RANK.fancy;
    if (rank <= ceiling) score += 0.15;
    if (maxPopularity > 0) {
      score += 0.1 * ((r.useCount + r.likeCount) / maxPopularity);
    }
    return { row: r, score };
  });

  const eligible = scored
    .filter((s) => s.score >= config.minMatchScore)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.useCount + b.row.likeCount - (a.row.useCount + a.row.likeCount) ||
        b.row.createdAt.getTime() - a.row.createdAt.getTime(),
    )
    .slice(0, config.shortlistSize);

  // Assign a short per-shortlist alias (m1, m2, …) as the id the AI sees. The
  // real Meal.id is held in aliasToId for reconcile to translate back. This is
  // what scales: the alias space is bounded by shortlistSize, never the catalog,
  // and short tokens round-trip through the model far more reliably than UUIDs.
  const aliasToId = new Map<string, string>();
  const forPrompt: StoreShortlistMeal[] = eligible.map(({ row }, i) => {
    const alias = `m${i + 1}`;
    aliasToId.set(alias, row.id);
    return {
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
    };
  });

  return { forPrompt, aliasToId };
}

/**
 * Post-AI guard + alias translation for the candidate storeSlots marks. For
 * each candidate, keeps only marks whose storeMealId is a KNOWN alias (in
 * `aliasToId`) AND whose slotIndex is in range [0, mealTitles.length); dedups
 * repeated slotIndex (first wins). Surviving marks are REWRITTEN so
 * storeMealId carries the real Meal.id — the alias never leaves this function,
 * so expand/save downstream always see real ids (no silent demote-to-live from
 * an unresolvable alias). Marks that fail are dropped (those slots go live). A
 * candidate left with no valid marks has storeSlots removed entirely.
 */
export function reconcileStoreSlots(
  candidates: WizardPlanCandidate[],
  aliasToId: Map<string, string>,
): WizardPlanCandidate[] {
  return candidates.map((c) => {
    if (!c.storeSlots || c.storeSlots.length === 0) {
      const { storeSlots: _drop, ...rest } = c;
      return rest;
    }
    const seenSlots = new Set<number>();
    const kept: { slotIndex: number; storeMealId: string }[] = [];
    for (const s of c.storeSlots) {
      if (s.slotIndex < 0 || s.slotIndex >= c.mealTitles.length) continue;
      const realId = aliasToId.get(s.storeMealId);
      if (!realId) continue; // unknown / hallucinated alias
      if (seenSlots.has(s.slotIndex)) continue;
      seenSlots.add(s.slotIndex);
      kept.push({ slotIndex: s.slotIndex, storeMealId: realId });
    }
    if (kept.length === 0) {
      const { storeSlots: _drop, ...rest } = c;
      return rest;
    }
    return { ...c, storeSlots: kept };
  });
}
