-- SERVER-6 A (ATTR) — where each signup came from.
--
--   · users.signupAttribution — the link's facts at create (ref, utmSource,
--     utmMedium, utmCampaign, landingPath; each ≤ 120 characters), written once
--     by the account-creating doors and never updated.
--   · users.howHeard / howHeardDetail — the person's own answer to "How did you
--     hear about Kiwi?", set once through PATCH /me/profile.
--
-- ADDITIVE FOR THE LIVE REVISION (D-WS9-254): three nullable columns, no
-- default, no backfill. Code that does not know them is unaffected.
--
-- Generated with `prisma migrate diff --from-url <dev> --to-schema-datamodel
-- --script` (read-only against the live schema). No `--shadow-database-url`.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "howHeard" TEXT,
ADD COLUMN     "howHeardDetail" TEXT,
ADD COLUMN     "signupAttribution" JSONB;
