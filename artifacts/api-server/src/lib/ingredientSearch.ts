// WS6 6c-6 Block B — Prefix-match Ingredient lookup for the "Add an item"
// typeahead. Loads all Ingredient rows on each call and filters in-memory
// against canonicalName + aliases. At ~121 seeded rows this is microseconds;
// if the table grows past ~5000 rows, refactor to raw Postgres ILIKE +
// GIN index on aliases (D-WS6 candidate, not in 6c-6 scope).
//
// Ranking: exact canonicalName match first, then canonicalName prefix
// matches, then alias matches. Ties broken by insertion order from
// findMany() (no stable secondary sort needed at this size).

import type { PrismaClient } from "@prisma/client";

export interface IngredientSearchResult {
  ingredientId: string;
  canonicalName: string;
  displayName: string;
  category: string;
  defaultUnit: string;
}

interface RawRow {
  id: string;
  canonicalName: string;
  displayName: string;
  category: string;
  defaultUnit: string;
  aliases: string[];
}

type Rank = 0 | 1 | 2;

interface RankedRow {
  row: RawRow;
  rank: Rank;
}

export async function searchIngredientsByPrefix(
  prisma: PrismaClient,
  needle: string,
  limit = 5,
): Promise<IngredientSearchResult[]> {
  const normalized = needle.trim().toLowerCase();
  if (normalized.length === 0) return [];

  const rows = (await prisma.ingredient.findMany({
    select: {
      id: true,
      canonicalName: true,
      displayName: true,
      category: true,
      defaultUnit: true,
      aliases: true,
    },
  })) as RawRow[];

  const ranked: RankedRow[] = [];
  for (const row of rows) {
    const canonical = row.canonicalName.toLowerCase();
    if (canonical === normalized) {
      ranked.push({ row, rank: 0 });
      continue;
    }
    if (canonical.startsWith(normalized)) {
      ranked.push({ row, rank: 1 });
      continue;
    }
    if (row.aliases.some((a) => a.toLowerCase().startsWith(normalized))) {
      ranked.push({ row, rank: 2 });
    }
  }

  ranked.sort((a, b) => a.rank - b.rank);

  return ranked.slice(0, limit).map(({ row }) => ({
    ingredientId: row.id,
    canonicalName: row.canonicalName,
    displayName: row.displayName,
    category: row.category,
    defaultUnit: row.defaultUnit,
  }));
}
