-- [grocery] B4 (D-WS9-286) — the pack COUNT, stored as a count.
--
-- Additive and nullable. Nothing is dropped or renamed, and every existing row
-- reads NULL, which is the documented "the server could not compute one" value —
-- so a list generated before this deploy renders on the old path with no data
-- migration at all.
--
-- Hand-written: `prisma migrate diff --shadow-database-url` RESETS the database
-- it is pointed at (it wiped the Neon dev branch on 2026-09-18). Apply with
-- `prisma migrate deploy` only.

ALTER TABLE "grocery_list_items" ADD COLUMN "packCount" INTEGER;
