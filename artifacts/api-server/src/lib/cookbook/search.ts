// BOOK-1S (D-WS9-312) — the Cookbook search: GET /cookbook/meals.
//
// Browse and search the public catalog. Not the shelf: POST /wizard/shelf is a
// seeded random sampler with a difficulty ceiling and one version per dish, and
// browsing needs the opposite — every eligible meal, every version, in a stable
// order you can page through.
//
// SHAPE. One database read returns the light sort-and-facet columns of every
// meal that passes the database-side filters (the public-dinner base, the
// allergen hard filter, the text query and the time cap). Cuisine, tag, the
// facets, the sort and the page are then applied in memory over that list, and
// a second read fetches the card fields for the one page. Measured on dev
// (BOOK-0): the catalog is ~1,300 public dinners and one such read is one
// round trip, text match included. In memory because two of the inputs are not
// columns — the popularity rank lives in the frozen spine (store/dishFamily.ts)
// and the cuisine tokens are derived (store/cuisineNormalize.ts) — and because
// each facet needs the same filters minus its own, which one list answers for
// free and SQL would answer with one query per facet.
//
// ⚠️ THE ALLERGEN FILTER IS THE LINE THAT KEEPS AN ALLERGIC USER SAFE. It is
// the shelf's own (store/allergenFilter.ts), conservative rule included: for a
// user with any mapped allergy, a meal that was never stamped is excluded.

import type { Prisma, PrismaClient } from "@prisma/client";

import { allergenTokensForUser, allergenWhereConditions } from "../store/allergenFilter";
import { normalizeCuisineTokens } from "../store/cuisineNormalize";
import { lookupDishFamily, NON_CATALOG_RANK, parentKeyForMeal } from "../store/dishFamily";
import { MEAL_CARD_SELECT, toMealCard, type MealCard } from "../store/mealCard";
import {
  decodeCursor,
  encodeCursor,
  type CookbookQuery,
  type CookbookSort,
  type SortKey,
} from "./query";

/** The facet the Thanksgiving rail counts (THX-2 writes it into Meal.tags). */
export const THANKSGIVING_TAG = "thanksgiving";

export interface CookbookMeal extends MealCard {
  /** The user has a copy of this meal on their Playlist (by lineage). */
  isSaved: boolean;
}

export interface CookbookFacets {
  /** Per canonical cuisine token, under every filter except `cuisine`. */
  cuisines: Array<{ token: string; count: number }>;
  /** Meals tagged `thanksgiving`, under every filter except `tag`. */
  thanksgiving: number;
}

export interface CookbookResult {
  meals: CookbookMeal[];
  total: number;
  nextCursor: string | null;
  facets: CookbookFacets;
}

export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
  }
}

/**
 * The database-side predicate: the shelf's public-dinner base, the allergen
 * hard filter, the text query and the time cap.
 *
 * The time cap admits DERIVED times only (`activeTimeMinutes` not null),
 * exactly as storeShortlist.ts applies it (D-WS7-166 / BUG-245): a step-less
 * meal's `estimatedTimeMinutes` is an authored claim, and a filter that says
 * "under 30 minutes" must not rest on a claim.
 */
export function buildCookbookWhere(opts: {
  allergenTokens: string[];
  q?: string;
  maxMinutes?: number;
}): Prisma.MealWhereInput {
  const allergenConditions = allergenWhereConditions(opts.allergenTokens);
  const q = opts.q;
  return {
    isPublic: true,
    isArchived: false,
    mealType: "dinner",
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { displayTitle: { contains: q, mode: "insensitive" } },
            {
              dishLinks: {
                some: {
                  dish: {
                    dishIngredients: {
                      some: {
                        ingredient: {
                          OR: [
                            { displayName: { contains: q, mode: "insensitive" } },
                            { canonicalName: { contains: q, mode: "insensitive" } },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        }
      : {}),
    ...(opts.maxMinutes !== undefined
      ? {
          estimatedTimeMinutes: { lte: opts.maxMinutes },
          activeTimeMinutes: { not: null },
        }
      : {}),
    ...(allergenConditions.length > 0 ? { AND: allergenConditions } : {}),
  };
}

const LIGHT_SELECT = {
  id: true,
  title: true,
  displayTitle: true,
  cuisineType: true,
  tags: true,
  estimatedTimeMinutes: true,
  activeTimeMinutes: true,
  dishFamilyKey: true,
} satisfies Prisma.MealSelect;

export type LightRow = Prisma.MealGetPayload<{ select: typeof LIGHT_SELECT }>;

interface Candidate {
  row: LightRow;
  cuisines: Set<string>;
  tags: Set<string>;
  key: SortKey;
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/**
 * The sort key, always ending in the id so every key is unique.
 *   popular  — the parent dish's popularity rank from the frozen spine
 *              (Meal.dishFamilyKey → storeFillDishes.ts TARGET_DISHES.rank via
 *              lookupDishFamily; 1 = most cooked), then the parent, so every
 *              version of one dish sits together; non-catalog meals take
 *              NON_CATALOG_RANK as their own singleton parent, as on the shelf.
 *   quickest — the derived total ascending; a meal with no derived time
 *              (activeTimeMinutes null) sorts after every timed one.
 *   az       — the display title (displayTitle, else title).
 */
export function sortKeyFor(sort: CookbookSort, row: LightRow): SortKey {
  switch (sort) {
    case "popular":
      return [
        lookupDishFamily(row.dishFamilyKey)?.rank ?? NON_CATALOG_RANK,
        parentKeyForMeal(row.id, row.dishFamilyKey),
        row.id,
      ];
    case "quickest": {
      const derived = row.activeTimeMinutes !== null;
      return [derived ? 0 : 1, derived ? row.estimatedTimeMinutes : 0, row.id];
    }
    case "az":
      return [row.displayTitle ?? row.title, row.id];
  }
}

export function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    const c =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : i === a.length - 1
          ? // The id: a plain code-unit compare, so two ids never tie.
            String(x) < String(y)
            ? -1
            : String(x) > String(y)
              ? 1
              : 0
          : collator.compare(String(x), String(y));
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * Filter, facet, sort and page the light rows. Pure — the route's whole
 * in-memory half, exposed for tests.
 */
export function pageCookbook(
  rows: LightRow[],
  query: Pick<CookbookQuery, "cuisine" | "tag" | "sort" | "cursor" | "limit">,
): { page: LightRow[]; total: number; nextCursor: string | null; facets: CookbookFacets } {
  const sort = query.sort;
  const wantCuisines = query.cuisine && query.cuisine.length > 0 ? new Set<string>(query.cuisine) : null;
  const wantTag = query.tag ?? null;

  const candidates: Candidate[] = rows.map((row) => ({
    row,
    cuisines: normalizeCuisineTokens(row.cuisineType),
    tags: new Set(row.tags.map((t) => t.toLowerCase())),
    key: sortKeyFor(sort, row),
  }));

  // A meal matches the cuisine filter when it carries ANY requested token.
  const cuisineOk = (c: Candidate) =>
    wantCuisines === null || [...c.cuisines].some((t) => wantCuisines.has(t));
  const tagOk = (c: Candidate) => wantTag === null || c.tags.has(wantTag);

  // Facets: each under every filter except its own.
  const cuisineCounts = new Map<string, number>();
  let thanksgiving = 0;
  for (const c of candidates) {
    if (tagOk(c)) {
      for (const t of c.cuisines) cuisineCounts.set(t, (cuisineCounts.get(t) ?? 0) + 1);
    }
    if (cuisineOk(c) && c.tags.has(THANKSGIVING_TAG)) thanksgiving += 1;
  }

  const matched = candidates.filter((c) => cuisineOk(c) && tagOk(c));
  matched.sort((a, b) => compareKeys(a.key, b.key));

  let start = 0;
  if (query.cursor) {
    const after = decodeCursor(sort, query.cursor);
    if (after === null) throw new InvalidCursorError();
    start = matched.findIndex((c) => compareKeys(c.key, after) > 0);
    if (start === -1) start = matched.length;
  }
  const slice = matched.slice(start, start + query.limit);
  const hasMore = start + query.limit < matched.length;

  return {
    page: slice.map((c) => c.row),
    total: matched.length,
    nextCursor: hasMore && slice.length > 0 ? encodeCursor(sort, slice[slice.length - 1].key) : null,
    facets: {
      cuisines: [...cuisineCounts.entries()]
        .map(([token, count]) => ({ token, count }))
        .sort((a, b) => b.count - a.count || (a.token < b.token ? -1 : 1)),
      thanksgiving,
    },
  };
}

/**
 * The user's allergen tokens, from their STORED preferences.
 *
 * Not resolveAllergenPreference: that resolver exists for generate requests
 * that carry a per-run allergen field, and its absent-field branch logs
 * `allergen_field_omitted` (a warn) whenever a user with stored allergies sends
 * none — the BUG-201 audit signal. The Cookbook never has a per-run field, so
 * every search by an allergic user would raise that alarm. The value is the
 * same one its stored branch returns.
 */
export async function storedAllergenTokens(
  prisma: Pick<PrismaClient, "userPreferences">,
  userId: string,
): Promise<string[]> {
  const prefs = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { allergiesAndAvoidances: true },
  });
  return allergenTokensForUser(prefs?.allergiesAndAvoidances ?? []);
}

export async function searchCookbook(
  prisma: Pick<PrismaClient, "meal" | "playlistMeal" | "userPreferences">,
  userId: string,
  query: CookbookQuery,
): Promise<CookbookResult> {
  const allergenTokens = await storedAllergenTokens(prisma, userId);
  const rows = await prisma.meal.findMany({
    where: buildCookbookWhere({ allergenTokens, q: query.q, maxMinutes: query.maxMinutes }),
    select: LIGHT_SELECT,
  });

  const { page, total, nextCursor, facets } = pageCookbook(rows, query);
  const pageIds = page.map((r) => r.id);
  if (pageIds.length === 0) return { meals: [], total, nextCursor, facets };

  const [cards, saved] = await Promise.all([
    prisma.meal.findMany({ where: { id: { in: pageIds } }, select: MEAL_CARD_SELECT }),
    // Saved = a Playlist row whose meal is the user's copy of this catalog meal
    // (Meal.sourceStoreMealId, the lineage POST /me/playlist dedupes on), or —
    // for the rare public meal the user owns — the meal itself.
    prisma.playlistMeal.findMany({
      where: {
        userId,
        meal: { isArchived: false },
        OR: [{ mealId: { in: pageIds } }, { meal: { sourceStoreMealId: { in: pageIds } } }],
      },
      select: { mealId: true, meal: { select: { sourceStoreMealId: true } } },
    }),
  ]);

  const savedIds = new Set<string>();
  for (const s of saved) {
    savedIds.add(s.mealId);
    if (s.meal.sourceStoreMealId) savedIds.add(s.meal.sourceStoreMealId);
  }
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const meals = pageIds
    .map((id) => cardById.get(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => ({ ...toMealCard(c), isSaved: savedIds.has(c.id) }));

  return { meals, total, nextCursor, facets };
}
