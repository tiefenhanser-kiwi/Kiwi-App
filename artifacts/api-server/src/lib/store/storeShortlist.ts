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

import type { DifficultyLevel, Prisma, PrismaClient } from "@prisma/client";

import type { StoreComposeConfig } from "./storeComposeConfig";
import type { WizardPlanCandidate } from "../ai/schemas/wizard";
import { lookupDishFamily, NON_CATALOG_RANK } from "./dishFamily";
import { cuisineMatches, userCuisineTokens } from "./cuisineNormalize";
import { allergenTokensForUser, allergenWhereConditions } from "./allergenFilter";
import {
  rngFromString,
  weightedSampleWithoutReplacement,
} from "./shortlistSampling";

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

// The projected DB row the selection pipeline works over.
interface StoreRow {
  id: string;
  title: string;
  cuisineType: string | null;
  difficulty: string;
  estimatedTimeMinutes: number;
  tags: string[];
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  dishFamilyKey: string | null;
  allergens: string[];
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
  /** The user's selected cuisine prefs (free-form UI labels). */
  cuisines: string[];
  /** The user's allergy labels (domain.ts ALLERGIES_AND_AVOIDANCES) — hard filter. */
  allergiesAndAvoidances: string[];
  /** The user's cooking skill (easy | medium | fancy) — tiered difficulty ceiling. */
  difficulty: string;
  /** Seeds per-user shortlist variety (two users with equal prefs differ). */
  userId: string;
  /** Rotates the seed across a user's plans so repeat requests vary. */
  rotationSalt: number;
  /** Meal ids to exclude (recent history — avoid repeats). */
  excludeMealIds?: string[];
  config: StoreComposeConfig;
}

// Difficulty tiers, ordered. The user's skill sets a HARD ceiling one tier above
// their level (a beginner gets easy+medium, never fancy — a too-hard meal reads as
// "this app makes cooking hard" and churns; a mild stretch reads as a pleasant
// surprise). No floor: an easy weeknight meal suits any skill level.
const DIFFICULTY_RANK: Record<string, number> = { easy: 0, medium: 1, fancy: 2 };
const DIFFICULTY_LEVELS = ["easy", "medium", "fancy"] as const;

// Within the allowed band, weight toward the user's ACTUAL level: each tier of
// distance from their level multiplies the meal's weight by this falloff. So a
// beginner's easy+medium band leans easy; a medium cook's band leans medium.
const DIFFICULTY_WEIGHT_FALLOFF = 0.5;

function difficultyLevel(v: string): number {
  return DIFFICULTY_RANK[v] ?? DIFFICULTY_RANK.fancy;
}

// The difficulty tokens a user of the given skill may be served: everything up to
// and including one tier above their level. Missing/unknown skill → treat as the
// most permissive (fancy) so we never over-restrict on bad input.
function allowedDifficultyLevels(userDifficulty: string): DifficultyLevel[] {
  const ceiling = Math.min(
    difficultyLevel(userDifficulty) + 1,
    DIFFICULTY_RANK.fancy,
  );
  return DIFFICULTY_LEVELS.filter((d) => DIFFICULTY_RANK[d] <= ceiling);
}

// Safety bound on the eligible fetch. Far above the current dinner pool (~1.1k),
// so reach ≈ the whole filtered catalog (the old newest-160 window is gone).
// Keyset-paginate here if the catalog ever grows past this.
const POOL_FETCH_CAP = 5000;

// Rank → sampling weight. Decreasing in rank so popular parents (low rank) are
// favored, but every parent keeps a positive chance (tail stays reachable). The
// gentle 1/sqrt(rank) curve leans popular without starving the mid/tail.
// Exported so the non-catalog-rank regression test can assert the tail-starvation
// property against the REAL curve (a future change to it must not re-starve
// live_writeback meals silently).
export function rankWeight(rank: number): number {
  return 1 / Math.sqrt(rank);
}

interface EnrichedRow {
  row: StoreRow;
  parentKey: string;
  rank: number;
  matches: boolean;
  /** Distance (in tiers) of this meal's difficulty from the user's level. */
  difficultyDistance: number;
}

/**
 * Retrieve + select the shared-pool shortlist for a compose request (Block 4b-1,
 * D-WS9-075). Pipeline:
 *   1. HARD FILTERS in the DB: isPublic/dinner/not-archived, recent-exclude, and
 *      the allergen filter (exclude stamped matches; conservative unstamped
 *      exclusion when the user has any allergy).
 *   2. DIVERSITY CAP: recover each meal's parent dish (dishFamilyKey → spine) and
 *      keep ONE seeded version per parent — so a 40-shelf is ~40 DISTINCT dinners,
 *      not six versions of a crowd-pleaser.
 *   3. CUISINE QUOTA: reserve the majority of the shelf for cuisine matches, then
 *      backfill from the rest so a thin-cuisine user is never stranded.
 *   4. RANK-WEIGHTED SAMPLING seeded by (userId, rotationSalt): leans popular,
 *      varies per user + per request, fully deterministic.
 * Returns an empty shelf (not an error) when the pool is empty — the caller then
 * composes fully-live (structural graceful-degrade, D-WS9-037).
 */
export async function buildStoreShortlist(
  prisma: PrismaClient,
  opts: BuildStoreShortlistOptions,
): Promise<StoreShortlist> {
  const { config } = opts;
  if (config.shortlistSize <= 0) {
    return { forPrompt: [], aliasToId: new Map() };
  }

  const allergenTokens = allergenTokensForUser(opts.allergiesAndAvoidances);
  const andConditions: Prisma.MealWhereInput[] = allergenWhereConditions(
    allergenTokens,
  );
  const allowedLevels = allowedDifficultyLevels(opts.difficulty);
  const where: Prisma.MealWhereInput = {
    isPublic: true,
    isArchived: false,
    mealType: "dinner",
    // Hard difficulty ceiling — one tier above the user's skill (D-WS9-075).
    difficulty: { in: allowedLevels },
    ...(opts.excludeMealIds && opts.excludeMealIds.length > 0
      ? { id: { notIn: opts.excludeMealIds } }
      : {}),
    ...(andConditions.length > 0 ? { AND: andConditions } : {}),
  };

  const rows = (await prisma.meal.findMany({
    where,
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
      dishFamilyKey: true,
      allergens: true,
    },
    // Deterministic base order so seeded sampling is reproducible regardless of
    // the DB's physical row order (the sampling result depends on the order rng
    // draws are assigned to rows).
    orderBy: { id: "asc" },
    take: POOL_FETCH_CAP,
  })) as StoreRow[];

  if (rows.length === 0) {
    return { forPrompt: [], aliasToId: new Map() };
  }

  const userTokens = userCuisineTokens(opts.cuisines);
  const userLevel = difficultyLevel(opts.difficulty);
  const rng = rngFromString(`${opts.userId}:${opts.rotationSalt}`);

  // Enrich with parent + rank + cuisine match + difficulty distance. Sorted by id
  // above → stable.
  const enriched: EnrichedRow[] = rows.map((row) => {
    const info = lookupDishFamily(row.dishFamilyKey);
    return {
      row,
      parentKey: info ? info.parentKey : `x:${row.id}`,
      rank: info ? info.rank : NON_CATALOG_RANK,
      matches: cuisineMatches(row.cuisineType, userTokens),
      difficultyDistance: Math.abs(difficultyLevel(row.difficulty) - userLevel),
    };
  });

  // Sampling weight = popularity (rank) × difficulty affinity (leans toward the
  // user's actual skill level). Used both for the per-parent version pick (rank is
  // constant within a parent, so it leans the surviving version toward the user's
  // level) and for the final shelf sampling.
  const weightOf = (e: EnrichedRow): number =>
    rankWeight(e.rank) *
    Math.pow(DIFFICULTY_WEIGHT_FALLOFF, e.difficultyDistance);

  // 2. Diversity cap — one version per parent dish, leaning to the user's level.
  const byParent = new Map<string, EnrichedRow[]>();
  for (const e of enriched) {
    const group = byParent.get(e.parentKey);
    if (group) group.push(e);
    else byParent.set(e.parentKey, [e]);
  }
  const reps: EnrichedRow[] = [];
  for (const group of byParent.values()) {
    const [pick] = weightedSampleWithoutReplacement(group, weightOf, 1, rng);
    if (pick) reps.push(pick);
  }

  // 3 + 4. Cuisine quota + rank/difficulty-weighted sampling.
  const size = config.shortlistSize;
  let selected: EnrichedRow[];

  if (userTokens.size > 0) {
    const matches = reps.filter((e) => e.matches);
    const nonMatches = reps.filter((e) => !e.matches);
    const matchTarget = Math.min(
      matches.length,
      Math.ceil(size * config.cuisineQuotaFraction),
    );
    const chosenMatches = weightedSampleWithoutReplacement(
      matches,
      weightOf,
      matchTarget,
      rng,
    );
    // Backfill from OUTSIDE the chosen cuisines first — guarantees some variety
    // beyond the user's picks — then, only if those are exhausted, leftover
    // matches. Narrow toward the prefs, but never strand a thin-cuisine user.
    const chosenNon = weightedSampleWithoutReplacement(
      nonMatches,
      weightOf,
      size - chosenMatches.length,
      rng,
    );
    selected = [...chosenMatches, ...chosenNon];
    if (selected.length < size) {
      const taken = new Set(selected.map((e) => e.row.id));
      const leftoverMatches = matches.filter((e) => !taken.has(e.row.id));
      selected = [
        ...selected,
        ...weightedSampleWithoutReplacement(
          leftoverMatches,
          weightOf,
          size - selected.length,
          rng,
        ),
      ];
    }
  } else {
    selected = weightedSampleWithoutReplacement(reps, weightOf, size, rng);
  }

  // Order popular-first (rank asc) for the prompt; stable id tiebreak.
  selected.sort((a, b) => a.rank - b.rank || (a.row.id < b.row.id ? -1 : 1));

  // Assign a short per-shortlist alias (m1, m2, …) as the id the AI sees. The
  // real Meal.id is held in aliasToId for reconcile to translate back. This is
  // what scales: the alias space is bounded by shortlistSize, never the catalog,
  // and short tokens round-trip through the model far more reliably than UUIDs.
  const aliasToId = new Map<string, string>();
  const forPrompt: StoreShortlistMeal[] = selected.map(({ row }, i) => {
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
