-- SEC-2 #16 — one free trial per person.
--
-- ADDITIVE: two nullable columns and an index. A live revision that does not
-- know the columns is unaffected, so this can be applied before or after the
-- deploy that reads them.

ALTER TABLE "users" ADD COLUMN "emailCanonical" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "trialDeniedReason" TEXT;

CREATE INDEX "users_emailCanonical_idx" ON "users"("emailCanonical");

-- Backfill. EXACTLY the rule in lib/emailCanonical.ts canonicalEmail():
--   lower-case and trim; split at the LAST "@" (no "@", or one at position 0,
--   leaves the address as it is); drop a "+tag" from the local part unless that
--   empties it; googlemail.com becomes gmail.com; and for gmail.com drop the
--   dots from the local part unless that empties it.
UPDATE "users" AS u
SET "emailCanonical" = c.canonical
FROM (
  SELECT
    id,
    CASE
      WHEN domain IS NULL OR local = '' THEN e
      ELSE
        (CASE
           WHEN domain2 = 'gmail.com' AND replace(local2, '.', '') <> '' THEN replace(local2, '.', '')
           ELSE local2
         END) || '@' || domain2
    END AS canonical
  FROM (
    SELECT
      id,
      e,
      local,
      domain,
      CASE WHEN split_part(local, '+', 1) <> '' THEN split_part(local, '+', 1) ELSE local END AS local2,
      CASE WHEN domain = 'googlemail.com' THEN 'gmail.com' ELSE domain END AS domain2
    FROM (
      SELECT
        id,
        lower(btrim(email)) AS e,
        regexp_replace(lower(btrim(email)), '@[^@]*$', '') AS local,
        substring(lower(btrim(email)) FROM '@([^@]*)$') AS domain
      FROM "users"
    ) AS raw
  ) AS parts
) AS c
WHERE u.id = c.id;
