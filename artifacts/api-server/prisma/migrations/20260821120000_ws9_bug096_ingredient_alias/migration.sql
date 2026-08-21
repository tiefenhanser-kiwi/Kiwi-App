-- WS9 BUG-096 (D-WS9-174) — IngredientAlias: the alias source of truth.
--
-- WHY A TABLE. Ruling 2 requires a colliding alias to RAISE, not to be silently
-- resolved one way or the other. Postgres cannot enforce that on the existing
-- `ingredients.aliases TEXT[]`: an exclusion constraint needs an index access
-- method with `amgettuple` (GiST / SP-GiST only — GIN has none, and errors with
-- "access method 'gin' does not support exclusion constraints"), and core
-- Postgres ships no GiST operator class for `text[]`. A unique index on a
-- scalar column is the only mechanism that actually enforces the invariant, and
-- it needs a row of its own to sit on.
--
-- `aliasKey` is normalizeAliasKey(alias) — lower-case, collapse whitespace runs,
-- trim (src/lib/ingredientLookup.ts). It carries the UNIQUE. `alias` keeps the
-- authored casing for display.
--
-- INVARIANT ENFORCED: "no alias string is owned by two ingredients."
-- INVARIANT DELIBERATELY *NOT* ENFORCED: "no alias string is also some row's
-- canonicalName." Precedence is ruled canonical-beats-alias, so that overlap is
-- legal and unambiguous — and 20 such pairs exist today (alias "apple" on row
-- "apples", alias "salt" on "kosher salt", …). A constraint spanning
-- canonical ∪ alias would fail on all 20 the moment it was created.
--
-- Backfill: the 63 seeded strings currently in `ingredients.aliases` move here.
-- Verified before writing this migration: ZERO of those 63 are owned by more
-- than one row, so the unique index lands clean. The array column is RETAINED
-- but is no longer read or written by anything (drop candidate D-WS7-218) —
-- keeping it means this migration loses no data and can be reverted by simply
-- pointing the readers back.
--
-- ON DELETE CASCADE so a merged-away Ingredient cannot leave a dangling alias
-- behind. The BUG-096 merge re-points the loser's aliases onto the survivor
-- BEFORE it deletes anything, so the cascade is a backstop, not the mechanism.

-- CreateTable
CREATE TABLE "ingredient_aliases" (
    "id" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL,

    CONSTRAINT "ingredient_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingredient_aliases_aliasKey_key" ON "ingredient_aliases"("aliasKey");

-- CreateIndex
CREATE INDEX "ingredient_aliases_ingredientId_idx" ON "ingredient_aliases"("ingredientId");

-- AddForeignKey
ALTER TABLE "ingredient_aliases" ADD CONSTRAINT "ingredient_aliases_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the retained array column. `gen_random_uuid()` is pgcrypto,
-- available in core Postgres 13+ (this database is 17.11).
--
-- The normalization here MUST match normalizeAliasKey(): lower(), collapse
-- whitespace runs to one space, trim. `regexp_replace(..., '\s+', ' ', 'g')`
-- then `btrim` is exactly that.
--
-- DISTINCT ON (aliasKey) with a deterministic tiebreak: if the array data ever
-- held the same alias twice the insert would violate the new unique index and
-- take the whole migration down. It does not today (verified: 0 duplicates
-- across 63 strings), so this is a belt-and-braces guard that changes nothing
-- about the current data.
INSERT INTO "ingredient_aliases" ("id", "ingredientId", "alias", "aliasKey")
SELECT DISTINCT ON (k."aliasKey")
    gen_random_uuid()::text,
    k."ingredientId",
    k."alias",
    k."aliasKey"
FROM (
    SELECT
        i."id"                                                              AS "ingredientId",
        a                                                                   AS "alias",
        btrim(regexp_replace(lower(a), '\s+', ' ', 'g'))                    AS "aliasKey"
    FROM "ingredients" i
    CROSS JOIN LATERAL unnest(i."aliases") AS a
) k
WHERE k."aliasKey" <> ''
ORDER BY k."aliasKey", k."ingredientId";
