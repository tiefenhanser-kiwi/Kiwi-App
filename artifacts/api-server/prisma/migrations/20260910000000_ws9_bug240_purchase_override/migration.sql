-- WS9 BUG-240 — a user-set PURCHASE, stored apart from the derived one.
--
-- Hans ruled the grocery list is a shopping document: once generated it belongs
-- to the user, who edits what they will BUY while the need becomes read-only
-- context. He also ruled that a regeneration may override those edits freely
-- and that nothing needs preserving across one — so there is no backfill, no
-- reconciliation and no cross-generation tracking here, only storage.
--
-- FORWARD-ONLY and it touches no existing data (D-WS9-230). All three columns
-- are nullable with no default: every row that exists today reads NULL, NULL
-- means "the user has not overridden this", and every render path behaves
-- exactly as it does on bd2590e until a PATCH writes one.
--
-- WHY THREE COLUMNS RATHER THAN A FLAG ON THE EXISTING ONES, since the cheaper
-- shape was considered and rejected:
--
--   1. UNDO. The server's own write-back writes purchaseUnit/Quantity/Display,
--      so overwriting them destroys the app's suggestion and "put it back"
--      stops being expressible without re-deriving — a round trip, and the
--      reconciliation the ruling explicitly does not want. Here a revert is a
--      NULL.
--   2. PARTIAL EDITS. A user who changes only the count keeps the derived
--      label. One boolean records that *something* was overridden without
--      recording which.
--   3. THE MARKER IS THE COLUMN. A value in `purchaseDisplay` does NOT mean a
--      user set it — the gap-fill write-back puts values there. Nothing but a
--      user PATCH can ever populate these three, so here the value IS the
--      marker, and it cannot drift out of sync with what it describes the way a
--      separate boolean can.
--
-- Regeneration and reconcile-re-resolution both INSERT a brand-new row (they
-- delete and createMany, never update), so an override vanishes on either — by
-- construction, with no code to maintain. That is the ruling, enforced by the
-- shape rather than by a rule someone has to remember.

ALTER TABLE "grocery_list_items" ADD COLUMN "purchaseUnitOverride" TEXT;
ALTER TABLE "grocery_list_items" ADD COLUMN "purchaseQuantityOverride" DOUBLE PRECISION;
ALTER TABLE "grocery_list_items" ADD COLUMN "purchaseDisplayOverride" TEXT;

-- No index. These are read only as part of the row they sit on — the list
-- detail read already fetches the whole row — and never filtered or joined on.
