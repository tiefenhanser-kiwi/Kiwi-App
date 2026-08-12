-- WS9-2 2c (D-WS9-154) — seed the initial Tried & True rail order.
--
-- Without this the rail ships EMPTY. `null = out of the rail` is the ruled
-- semantic, and every one of the 72 template rows is null immediately after the
-- ADD COLUMN in the preceding migration. The six public non-archived rows ARE
-- the entire live rail today, so they are seeded to 1..6 in exactly the order
-- the pre-migration rail rendered them:
--   badge group first  — Hosting, then Featured, then unbadged (what the old
--                        three-bucket hosting/featured/top_rated merge produced,
--                        since top_rated is ungated and swept the remainder);
--   createdAt DESC     — within the group, which was each bucket's ORDER BY.
--
-- Result: the rail renders the identical six cards in the identical order across
-- this migration. Curation then happens by editing these integers in Neon.
--
-- Scoped to `railPosition IS NULL` so re-running never clobbers a curated value.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      ORDER BY
        CASE
          WHEN "isHostingFeatured" THEN 0
          WHEN "isFeatured" THEN 1
          ELSE 2
        END,
        "createdAt" DESC
    ) AS pos
  FROM "meal_plan_templates"
  WHERE "isPublic" = true
    AND "isArchived" = false
    AND "railPosition" IS NULL
)
UPDATE "meal_plan_templates" AS t
SET "railPosition" = ranked.pos
FROM ranked
WHERE t."id" = ranked."id";
