-- WS9A BUG-233 + BUG-234 — single-use purpose tokens and session invalidation.
--
-- FORWARD-ONLY, and it touches no existing data (D-WS9-230). The new column is
-- nullable with no default and no backfill: every row that exists today reads
-- NULL, NULL means "never revoked", and the guards short-circuit on NULL. So
-- behaviour for existing rows is identical to c38a596 until a password path
-- writes a stamp.

-- BUG-234 · the revocation epoch. Any token whose `iat` predates this instant
-- is refused. Bumped by /auth/password-reset/confirm and PATCH /me/password.
ALTER TABLE "users" ADD COLUMN "tokensValidFrom" TIMESTAMP(3);

-- BUG-233 · the spent-token ledger. One row per purpose token actually
-- redeemed; the primary key on `jti` is what makes redemption atomic, so two
-- concurrent presentations of one token cannot both succeed.
CREATE TABLE "used_tokens" (
    "jti" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "used_tokens_pkey" PRIMARY KEY ("jti")
);

-- Drives sweepExpiredUsedTokens(): a row is dead weight once the JWT it
-- describes stops verifying on its own.
CREATE INDEX "used_tokens_expiresAt_idx" ON "used_tokens"("expiresAt");

-- Per-user lookup, for any future "kill this user's outstanding links" work.
CREATE INDEX "used_tokens_userId_idx" ON "used_tokens"("userId");

-- No FOREIGN KEY to "users" on purpose: this is a short-lived ledger swept on
-- expiry, not user data, and a constraint check on every redemption buys
-- nothing. Orphaned rows are swept like any other expired row.
