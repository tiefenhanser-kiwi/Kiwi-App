-- Row 9 (1.1) "OAuth" · Block 1 — Sign in with Apple / Continue with Google.
--
-- ONE NEW TABLE AND ONE NEW ENUM. Nothing is altered, nothing is backfilled,
-- and no existing column changes type or nullability:
--
--   · `users.passwordHash` was ALREADY `String?` before this block, so an
--     OAuth-only account needs no schema change to exist. That is the whole
--     reason this migration touches `users` only through a foreign key.
--   · `user_identities` starts empty. Every row in it will be written by a
--     verified sign-in; there is no correct value to backfill for accounts
--     that have never used a provider, and NULL is not it — the absence of a
--     row IS the fact.
--   · ADDITIVE, so the live Cloud Run revision that has never heard of the
--     table keeps working unchanged (D-WS9-254).
--
-- THE CONSTRAINT THAT DOES THE WORK is `user_identities_provider_subject_key`.
-- The provider's `sub` claim is unique per provider and stable across an email
-- change, which is why sign-in resolution keys on it first. The unique index
-- is also the concurrency guard: two simultaneous first sign-ins with the same
-- identity token cannot both create an account — the second insert raises
-- P2002 instead of winning.
--
-- `ON DELETE CASCADE` is deliberate and is the opposite of what
-- `guest_sessions.claimedByUserId` does (SET NULL). A guest session is funnel
-- EVIDENCE that must survive the account it produced; an identity row is a
-- CREDENTIAL and a stored Apple refresh token, and neither has any meaning —
-- or any business existing — once the user is gone. DELETE /me revokes the
-- Apple token at appleid.apple.com BEFORE the delete runs; this cascade is
-- what removes the local copy.
--
-- HAND-VERIFIED against `prisma migrate diff --from-url <dev> --script`
-- (read-only). NOT APPLIED on this box — Hans applies it to the Neon dev
-- branch. No `--shadow-database-url` was passed to anything: that flag RESETS
-- the database it is given and wiped a branch on September 18.

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('apple', 'google');

-- CreateTable
CREATE TABLE "user_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "emailAtLink" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "isPrivateRelay" BOOLEAN NOT NULL DEFAULT false,
    "appleRefreshTokenEnc" TEXT,
    "appleClientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_identities_userId_idx" ON "user_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_subject_key" ON "user_identities"("provider", "subject");

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
