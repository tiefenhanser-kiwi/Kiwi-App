// FIX-2 (BUG-058 / D-WS9-102) — the Swap for Similar candidate POOL, built on
// the server.
//
// WHAT IT REPLACED. The sheet used to post the first 60 rows of
// GET /me/meals?filter=my_meals,featured,top_rated,hosting: the user's own meals
// A→Z plus "Top Rated", which ranks on counters nothing increments and so is the
// first 20 catalog meals A→Z. The ~1,325-meal catalog was never searched, and
// only the source meal was excluded — so the plan's own meals (every plan meal is
// the user's fork) came back as the best "similar" matches. Measured before this
// change (October 17, dev, prompt v1): 2–4 of the top 5 were already in the plan
// for five of six sources; the sixth (Al Pastor tacos) got four Al Pastor tacos.
//
// THE POOL NOW (D-WS9-102 ruling 2: user AND catalog meals):
//   · the everyday catalog (public, live, the source's meal type), plus the
//     user's own live meals;
//   · a fork is folded onto its catalog meal (Meal.sourceStoreMealId) — the
//     catalog row stands for both;
//   · the user's allergen hard filter, the shelf's own (store/allergenFilter.ts);
//   · minus the source and EVERY meal in the plan — by id, by lineage, by title,
//     by dish (isSameDish) and by version (isVersionOf: "Chicken Parmesan Pasta"
//     is not a swap for chicken parmesan);
//   · theme meals (Thanksgiving) stay out unless the source is one.
// Then preFilterByForm keeps the few dozen whose FORM is closest (dishForm.ts),
// one row per dish, no one form taking every slot — and the AI ranks those.

import type { DishRole, MealType, Prisma, PrismaClient } from "@prisma/client";

import { allergenWhereConditions } from "../store/allergenFilter";
import { storedAllergenTokens } from "../cookbook/search";
import { EVERYDAY_SHELF_EXCLUDED_TAGS, everydayPoolWhere } from "../store/storeShortlist";
import {
  dishFormProfile,
  formScore,
  headTokens,
  isOneDish,
  isSameDishTokens,
  isVersionOf,
  type DishFormProfile,
} from "./dishForm";

/** The candidate count the AI sees. A few dozen strong ones, not 60 alphabetical. */
export const SWAP_POOL_AI_SIZE = 36;
/** At most this many shortlist rows may share one exact set of main forms. */
export const SWAP_POOL_PER_FORM_CAP = 6;
/** Below this score a candidate shares no form or family with the source. */
const MIN_FORM_SCORE = 1;

/** The light projection the pool is built from. Card fields are read for the winners only. */
export const SWAP_POOL_MEAL_SELECT = {
  id: true,
  title: true,
  cuisineType: true,
  tags: true,
  userId: true,
  isPublic: true,
  mealType: true,
  sourceStoreMealId: true,
  dishLinks: {
    select: { roleLabel: true, positionIndex: true, dish: { select: { title: true } } },
    orderBy: { positionIndex: "asc" },
  },
} as const satisfies Prisma.MealSelect;

export type SwapPoolMealRow = Prisma.MealGetPayload<{ select: typeof SWAP_POOL_MEAL_SELECT }>;

export interface SwapPoolCandidate {
  row: SwapPoolMealRow;
  mainDishTitles: string[];
  sideDishTitles: string[];
  profile: DishFormProfile;
  head: ReadonlySet<string>;
}

function splitDishes(row: { dishLinks: { roleLabel: DishRole; dish: { title: string } }[] }) {
  const main: string[] = [];
  const side: string[] = [];
  for (const l of row.dishLinks) (l.roleLabel === "main" ? main : side).push(l.dish.title);
  // A meal whose links are all sides (legacy rows) still has a main: its first dish.
  if (main.length === 0 && side.length > 0) main.push(side.shift()!);
  return { main, side };
}

export function toCandidate(row: SwapPoolMealRow): SwapPoolCandidate {
  const { main, side } = splitDishes(row);
  return {
    row,
    mainDishTitles: main,
    sideDishTitles: side,
    profile: dishFormProfile({ title: row.title, mainDishTitles: main, sideDishTitles: side }),
    head: headTokens(row.title),
  };
}

export function normTitle(t: string): string {
  return t.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.!?,;:'"]+$/g, "");
}

export interface AssembleInput {
  source: SwapPoolMealRow;
  /** The meals of the plan the swap happens in (empty when no plan was named). */
  planMeals: { id: string; title: string; sourceStoreMealId: string | null }[];
  catalogRows: SwapPoolMealRow[];
  userRows: SwapPoolMealRow[];
}

/**
 * The pure half: fold forks, then drop the source and the plan's meals. The
 * user's own (non-fork) meals come first, so when one is the same dish as a
 * catalog meal the dedupe in preFilterByForm keeps the version they know.
 */
export function assembleSwapPool(input: AssembleInput): SwapPoolCandidate[] {
  const { source, planMeals } = input;
  const excludedIds = new Set<string>([source.id]);
  if (source.sourceStoreMealId) excludedIds.add(source.sourceStoreMealId);
  const known = [source.title, ...planMeals.map((m) => m.title)];
  for (const m of planMeals) {
    excludedIds.add(m.id);
    if (m.sourceStoreMealId) excludedIds.add(m.sourceStoreMealId);
  }
  const knownNorm = new Set(known.map(normTitle));
  const knownHeads = known.map(headTokens);

  const catalogIds = new Set(input.catalogRows.map((r) => r.id));
  // A fork folds onto its catalog meal: drop the user's copy when the catalog
  // row it came from is in the pool.
  const ownRows = input.userRows
    .filter((r) => !(r.sourceStoreMealId && catalogIds.has(r.sourceStoreMealId)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const catalog = [...input.catalogRows].sort((a, b) => a.id.localeCompare(b.id));

  const out: SwapPoolCandidate[] = [];
  for (const row of [...ownRows, ...catalog]) {
    if (excludedIds.has(row.id)) continue;
    if (row.sourceStoreMealId && excludedIds.has(row.sourceStoreMealId)) continue;
    if (knownNorm.has(normTitle(row.title))) continue;
    const c = toCandidate(row);
    if (knownHeads.some((k) => isSameDishTokens(k, c.head) || isVersionOf(k, c.head))) continue;
    out.push(c);
  }
  return out;
}

function formSignature(p: DishFormProfile): string {
  return [...p.main].sort().join("+");
}

/**
 * Keep the candidates whose form is closest to the source's: ranked by form
 * score, ties on the same cuisine, then id (stable). Walking that order it keeps
 * one row per dish (same title or isOneDish) and at most SWAP_POOL_PER_FORM_CAP
 * rows per exact set of main forms, so a dumplings source sees stews AND pot
 * pies AND soups rather than 30 chilis. When too few share any form, it fills
 * with the same cuisine, then the rest, so the AI still has something to rank.
 */
export function preFilterByForm(
  source: SwapPoolCandidate,
  pool: SwapPoolCandidate[],
  size = SWAP_POOL_AI_SIZE,
): SwapPoolCandidate[] {
  const sourceCuisine = (source.row.cuisineType ?? "").toLowerCase();
  const scored = pool.map((c) => ({
    c,
    score: formScore(source.profile, c.profile),
    sameCuisine: sourceCuisine !== "" && (c.row.cuisineType ?? "").toLowerCase() === sourceCuisine,
  }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.sameCuisine) - Number(a.sameCuisine) ||
      a.c.row.id.localeCompare(b.c.row.id),
  );

  const kept: SwapPoolCandidate[] = [];
  const keptTitles = new Set<string>();
  const perForm = new Map<string, number>();
  const deferred: typeof scored = [];
  const tryKeep = (s: (typeof scored)[number], capped: boolean): boolean => {
    const nt = normTitle(s.c.row.title);
    if (keptTitles.has(nt) || kept.some((k) => isOneDish(k.head, s.c.head))) return false;
    const sig = formSignature(s.c.profile);
    if (capped && (perForm.get(sig) ?? 0) >= SWAP_POOL_PER_FORM_CAP) {
      deferred.push(s);
      return false;
    }
    kept.push(s.c);
    keptTitles.add(nt);
    perForm.set(sig, (perForm.get(sig) ?? 0) + 1);
    return true;
  };

  for (const s of scored) {
    if (kept.length >= size || s.score < MIN_FORM_SCORE) break;
    tryKeep(s, true);
  }
  // Form-matched rows the cap held back come before any unmatched filler.
  for (const s of deferred.splice(0)) {
    if (kept.length >= size) break;
    tryKeep(s, false);
  }
  if (kept.length < Math.min(12, size)) {
    const rest = scored.filter((s) => s.score < MIN_FORM_SCORE);
    for (const s of [...rest.filter((r) => r.sameCuisine), ...rest.filter((r) => !r.sameCuisine)]) {
      if (kept.length >= size) break;
      tryKeep(s, false);
    }
  }
  return kept;
}

export class SwapSourceNotFoundError extends Error {
  constructor() {
    super("source meal not found");
  }
}

/**
 * The database half. Reads the source (must be readable by the user), the plan
 * (only when it is the user's), the catalog and the user's own meals.
 */
export async function buildSwapPool(
  prisma: Pick<PrismaClient, "meal" | "mealPlanInstance" | "userPreferences">,
  userId: string,
  opts: { sourceMealId: string; planId?: string },
): Promise<{ source: SwapPoolCandidate; pool: SwapPoolCandidate[]; shortlist: SwapPoolCandidate[] }> {
  const sourceRow = await prisma.meal.findUnique({
    where: { id: opts.sourceMealId },
    select: SWAP_POOL_MEAL_SELECT,
  });
  if (!sourceRow || (!sourceRow.isPublic && sourceRow.userId !== userId)) {
    throw new SwapSourceNotFoundError();
  }

  const themed = sourceRow.tags.some((t) => EVERYDAY_SHELF_EXCLUDED_TAGS.includes(t));
  const [plan, allergenTokens] = await Promise.all([
    opts.planId
      ? prisma.mealPlanInstance.findFirst({
          where: { id: opts.planId, userId },
          select: {
            items: { select: { meal: { select: { id: true, title: true, sourceStoreMealId: true } } } },
          },
        })
      : Promise.resolve(null),
    storedAllergenTokens(prisma, userId),
  ]);
  const allergenConditions = allergenWhereConditions(allergenTokens);
  const base: Prisma.MealWhereInput = {
    isArchived: false,
    mealType: sourceRow.mealType as MealType,
    ...(themed ? {} : everydayPoolWhere()),
    ...(allergenConditions.length > 0 ? { AND: allergenConditions } : {}),
  };
  const [catalogRows, userRows] = await Promise.all([
    prisma.meal.findMany({
      // A public meal the user owns is read on the user side only. (An OR, not
      // a NOT: `base` already carries everydayPoolWhere's NOT, and NOT on a
      // nullable column would drop every owner-less catalog row.)
      where: { ...base, isPublic: true, OR: [{ userId: null }, { userId: { not: userId } }] },
      select: SWAP_POOL_MEAL_SELECT,
    }),
    prisma.meal.findMany({ where: { ...base, userId }, select: SWAP_POOL_MEAL_SELECT }),
  ]);

  const source = toCandidate(sourceRow);
  const pool = assembleSwapPool({
    source: sourceRow,
    planMeals: plan?.items.map((i) => i.meal) ?? [],
    catalogRows,
    userRows,
  });
  return { source, pool, shortlist: preFilterByForm(source, pool) };
}
