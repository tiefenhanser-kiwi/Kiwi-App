-- WS9 Redesign Arc Block 2 (Part A) — the Playlist dial gets a STORED default.
--
-- Hand-written so the enum type is RENAMED in place (Prisma's diff would
-- drop-and-recreate "DiscoveryLevel", which is not possible while
-- user_preferences.discoveryLevel depends on it). Order: RENAME the type →
-- ADD the new column with its default. No data migration (forward-only,
-- D-WS9-230): every existing row gets 'none', the same default the column
-- carried per-run in Block 1.

-- RenameEnum: DiscoveryLevel → DialLevel (both dials share the four values)
ALTER TYPE "DiscoveryLevel" RENAME TO "DialLevel";

-- AlterTable: the Playlist dial's stored default
ALTER TABLE "user_preferences"
ADD COLUMN     "playlistLevel" "DialLevel" NOT NULL DEFAULT 'none';
