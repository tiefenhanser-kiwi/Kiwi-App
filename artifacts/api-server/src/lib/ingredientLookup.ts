// WS9 BUG-096 (D-WS9-174) — the shared, alias-aware name → Ingredient lookup.
//
// WHY THIS EXISTS: the catalog accumulated 81 singular/plural duplicate pairs
// (roma tomato / roma tomatoes, garlic clove / garlic cloves, …) because
// `resolveIngredients` upserts on an exact `canonicalName` match and has never
// consulted aliases. Merging the 81 pairs without teaching the lookup about
// aliases would be a one-time cleanup: the next dish that writes "roma
// tomatoes" mints the duplicate straight back. Alias-awareness is what makes
// the merge durable.
//
// WHY IT IS SHARED: FIVE call sites key a free-text name to an Ingredient row,
// and they behave DIFFERENTLY on a miss —
//   ingredientResolve.ts   creates the row              (duplicate re-accrues)
//   groceryList.ts         ingredient: null             (loses pack/conversion)
//   groceryReconcile.ts    ingredientId: null           (loses pack/conversion)
//   groceryLists.ts        ingredientId: null           (loses pack/conversion)
//   mealCreate.ts          THROWS -> route returns 422  (promote-override dies)
// Teaching only the resolver would ship a known regression at the other four:
// the merge DELETES the loser rows, so every one of those lookups starts
// missing on names that resolved fine yesterday.
//
// ── THE NORMALIZATION CONTRACT (read this before adding a sixth caller) ──────
//
// This module does NOT impose one normalization on the primary lookup. Each
// caller keeps the exact primary key it uses today:
//   • ingredientResolve / overrideResolver  `name.toLowerCase().trim()`
//   • the three grocery paths               `normalizeIngredientName()`
//                                           (adds whitespace collapse + a
//                                           leading "the "/"a " strip)
//   • mealCreate                            `name.toLowerCase()`, no trim
// Forcing those onto one form WOULD be a regression: the grocery paths are fed
// AI/user prose, and dropping the article strip means "the olive oil" stops
// resolving. So `lookupIngredientByName` takes the caller's already-computed
// primary key and owns only the ALIAS fallback, under one normalization
// (`normalizeAliasKey`).
//
// The alias fallback is therefore PURELY ADDITIVE: step 1 is byte-for-byte what
// the caller did before, and step 2 can only turn a former MISS into a hit. No
// call site can regress. That property is the whole reason for this shape, and
// it is what lets `mealCreate`'s missing `.trim()` stay unchanged (its primary
// lookup is untouched; its alias fallback trims, which is strictly better).

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * THE alias-table key. Lower-case, collapse internal whitespace runs to a
 * single space, trim.
 *
 * Deliberately NOT `normalizeIngredientName`: that helper also strips a leading
 * "the "/"a ", which is a grocery-prose concern. Baking it into a shared
 * identity key would make the aliases "the salt" and "salt" collide and raise
 * P2002 on a pair that is not actually ambiguous.
 */
export function normalizeAliasKey(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface IngredientNameMatch {
  id: string;
  canonicalName: string;
  /** How the row was found. Callers log this; nothing branches on it today. */
  matchedVia: "canonical" | "alias";
}

/**
 * Resolve a free-text ingredient name to an existing Ingredient row.
 *
 * @param db            PrismaClient or a TransactionClient.
 * @param primaryKey    The caller's OWN normalized canonicalName key. Tried
 *                      first, unchanged, so existing behaviour is preserved
 *                      exactly.
 * @param rawName       The un-normalized name, used for the alias fallback.
 *                      Defaults to `primaryKey` when the caller has no
 *                      separate raw form.
 * @param opts.caseInsensitivePrimary
 *                      Use `mode: "insensitive"` on the canonical match.
 *                      ONLY `mealCreate` passes this — it is preserving its own
 *                      Q-P1-2 lookup byte-for-byte. Every other caller
 *                      lower-cases before calling and must not pay for an
 *                      unindexed ILIKE.
 * @returns the match, or null. Callers decide what a null means (create /
 *          null FK / throw) — this helper never creates and never throws.
 *
 * PRECEDENCE (ruled): canonical beats alias, unconditionally. 16 alias strings
 * are also some other row's canonicalName ("salt" is an alias on "kosher salt"
 * AND its own row); without this rule each one would be an ambiguity error on a
 * pair that is not ambiguous at all. Guarded by the BUG-135 block in
 * __tests__/ingredientLookup.test.ts, which pins that the alias table is never
 * even consulted for such a name.
 *
 * ⚠️ The count was documented as 20 in three places and measured at 16
 * (BUG-135, 2026-08-25 — all three corrected together). It is not load-bearing
 * for any code path; if it drifts again, re-measure rather than trusting it.
 */
export async function lookupIngredientByName(
  db: Db,
  primaryKey: string,
  rawName: string = primaryKey,
  opts: { caseInsensitivePrimary?: boolean } = {},
): Promise<IngredientNameMatch | null> {
  // 1. canonical — exactly what every caller did before this module existed.
  const canonical = await db.ingredient.findFirst({
    where: {
      canonicalName: opts.caseInsensitivePrimary
        ? { equals: primaryKey, mode: "insensitive" }
        : primaryKey,
    },
    select: { id: true, canonicalName: true },
  });
  if (canonical) {
    return { id: canonical.id, canonicalName: canonical.canonicalName, matchedVia: "canonical" };
  }

  // 2. alias — pure addition. Only ever converts a former miss into a hit.
  const aliasKey = normalizeAliasKey(rawName);
  if (aliasKey.length === 0) return null;
  const alias = await db.ingredientAlias.findUnique({
    where: { aliasKey },
    select: { ingredient: { select: { id: true, canonicalName: true } } },
  });
  if (!alias) return null;
  return {
    id: alias.ingredient.id,
    canonicalName: alias.ingredient.canonicalName,
    matchedVia: "alias",
  };
}

/**
 * Batch form of the above, for callers resolving many names at once
 * (`resolveIngredients` and the wizard-expand grounding lookup).
 *
 * Returns a map keyed by the PRIMARY KEY the caller passed in — never by the
 * survivor's canonicalName — so consumers that look up by
 * `ing.name.toLowerCase().trim()` keep working untouched. Alias-awareness
 * changes the VALUE (which row id you get), never the KEY.
 *
 * Two queries total regardless of input size.
 */
export async function lookupIngredientsByName(
  db: Db,
  keys: Iterable<{ primaryKey: string; rawName: string }>,
): Promise<Map<string, IngredientNameMatch>> {
  const wanted = [...keys].filter((k) => k.primaryKey.length > 0);
  const out = new Map<string, IngredientNameMatch>();
  if (wanted.length === 0) return out;

  const canonicalRows = await db.ingredient.findMany({
    where: { canonicalName: { in: [...new Set(wanted.map((k) => k.primaryKey))] } },
    select: { id: true, canonicalName: true },
  });
  const byCanonical = new Map(canonicalRows.map((r) => [r.canonicalName, r]));

  const unresolved = wanted.filter((k) => !byCanonical.has(k.primaryKey));
  const aliasKeys = [...new Set(unresolved.map((k) => normalizeAliasKey(k.rawName)).filter((k) => k.length > 0))];
  const aliasRows = aliasKeys.length
    ? await db.ingredientAlias.findMany({
        where: { aliasKey: { in: aliasKeys } },
        select: { aliasKey: true, ingredient: { select: { id: true, canonicalName: true } } },
      })
    : [];
  const byAlias = new Map(aliasRows.map((r) => [r.aliasKey, r.ingredient]));

  for (const k of wanted) {
    const c = byCanonical.get(k.primaryKey);
    if (c) {
      out.set(k.primaryKey, { id: c.id, canonicalName: c.canonicalName, matchedVia: "canonical" });
      continue;
    }
    const a = byAlias.get(normalizeAliasKey(k.rawName));
    if (a) out.set(k.primaryKey, { id: a.id, canonicalName: a.canonicalName, matchedVia: "alias" });
  }
  return out;
}
