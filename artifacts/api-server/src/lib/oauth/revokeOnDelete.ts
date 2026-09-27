// Row 9 (1.1) · OAuth Block 1 Part E — the revocation DELETE /me owes Apple.
//
// App Store Review guideline 5.1.1(v): an app offering Sign in with Apple must
// revoke the Apple token when the user deletes their account. This runs BEFORE
// the delete, once per Apple identity on the account.
//
// 🔴 BEST-EFFORT, BY RULING (§2.6). Nothing here can stop a deletion:
//
//   · no identities, or none from Apple  → nothing to do
//   · the deploy has no signing trio or
//     no encryption key                  → logged, skipped
//   · the stored blob will not decrypt
//     (a rotated key, a truncated column) → logged, skipped
//   · Apple 4xx/5xx/times out/throws      → logged, skipped
//
// A person asking to be deleted GETS DELETED. The alternative is an account
// that cannot be removed because a third party is having an outage, which is
// worse for them, and worse for us under GDPR, than an un-revoked token whose
// account no longer exists. Every skip is logged loudly enough to chase.
//
// The identity ROWS themselves need no deletion here: the FK cascades with the
// user (see the migration's note on why that differs from guest_sessions).

import type { PrismaClient } from "@prisma/client";

import {
  productionAppleFetch,
  revokeAppleToken as productionRevokeAppleToken,
  type AppleFetch,
} from "./appleTokens";
import type { OAuthConfig } from "./config";
import { decryptSecret } from "./secretBox";
import { logger } from "../logger";

export interface RevokeAppleForUserOptions {
  prisma: PrismaClient;
  userId: string;
  config: OAuthConfig;
  /** Injected in tests; production uses the real POST. */
  revokeAppleToken?: typeof productionRevokeAppleToken;
  fetchImpl?: AppleFetch;
}

export interface RevokeAppleForUserResult {
  /** How many Apple identities the account had. */
  found: number;
  /** How many Apple actually accepted a revoke for. */
  revoked: number;
  /** Why the rest were skipped — names of reasons, for the log. */
  skipped: string[];
}

export async function revokeAppleIdentitiesForUser(
  opts: RevokeAppleForUserOptions,
): Promise<RevokeAppleForUserResult> {
  const { prisma, userId, config } = opts;
  const revoke = opts.revokeAppleToken ?? productionRevokeAppleToken;
  const result: RevokeAppleForUserResult = { found: 0, revoked: 0, skipped: [] };

  const identities = await prisma.userIdentity.findMany({
    where: { userId, provider: "apple" },
    select: { id: true, appleRefreshTokenEnc: true, appleClientId: true },
  });
  result.found = identities.length;
  if (identities.length === 0) return result;

  if (!config.appleSigning || !config.appleRefreshEncSecret) {
    // The boot line already logged an ERROR for this deploy state
    // (oauth_apple_revocation_unavailable). This says it happened to a real
    // deletion, which is the line that actually matters for 5.1.1(v).
    result.skipped.push("not_configured");
    logger.error(
      { event: "apple_revoke_skipped", userId, reason: "not_configured", count: identities.length },
      "Account deleted WITHOUT revoking its Apple token — the server is not configured to sign Apple's client secret",
    );
    return result;
  }

  for (const identity of identities) {
    if (!identity.appleRefreshTokenEnc) {
      // Normal: the sign-in sent no authorization code, or the exchange failed.
      result.skipped.push("no_token");
      logger.warn(
        { event: "apple_revoke_skipped", userId, identityId: identity.id, reason: "no_token" },
        "No stored Apple refresh token for this identity — nothing to revoke",
      );
      continue;
    }

    let refreshToken: string;
    try {
      refreshToken = decryptSecret(identity.appleRefreshTokenEnc, config.appleRefreshEncSecret);
    } catch (err) {
      // A rotated APPLE_REFRESH_TOKEN_ENC_KEY lands here for every row written
      // under the old one. Documented in DEPLOY.md as the cost of rotation.
      result.skipped.push("undecryptable");
      logger.error(
        { event: "apple_revoke_skipped", userId, identityId: identity.id, reason: "undecryptable", err },
        "Stored Apple refresh token could not be decrypted — deletion proceeds without revoking",
      );
      continue;
    }

    // The client_id the token was MINTED for. Apple refuses a mismatch, and
    // APPLE_OAUTH_AUDIENCES is a list, so the first entry is a guess and the
    // recorded value is the fact. Falling back to the first entry is better
    // than not trying at all on a row written before the column existed.
    const clientId = identity.appleClientId ?? config.appleAudiences[0];
    if (!clientId) {
      result.skipped.push("no_client_id");
      continue;
    }

    try {
      const outcome = await revoke({
        signing: config.appleSigning,
        clientId,
        refreshToken,
        fetchImpl: opts.fetchImpl ?? productionAppleFetch,
      });
      if (outcome.ok) {
        result.revoked++;
      } else {
        result.skipped.push("apple_refused");
        logger.error(
          { event: "apple_revoke_failed", userId, identityId: identity.id, detail: outcome.detail },
          "Apple refused the token revocation — deletion proceeds (5.1.1(v) obligation unmet for this account)",
        );
      }
    } catch (err) {
      // 🔴 THE CATCH IS THE WHOLE POINT. A throw escaping here would take the
      // deletion with it, which is the one outcome this feature must never
      // produce.
      result.skipped.push("threw");
      logger.error(
        { event: "apple_revoke_failed", userId, identityId: identity.id, err },
        "Apple revocation threw — deletion proceeds regardless",
      );
    }
  }

  return result;
}
