// WS9A BUG-233 + BUG-234 — the two revocation mechanisms.
//
// These are deliberately SEPARATE and neither substitutes for the other:
//
//   BUG-233 · single use.  A purpose token (password_reset, email_change) must
//     work exactly once. Enforced by the UsedToken ledger: redeeming writes a
//     row keyed by the token's `jti`, and the row's existence refuses every
//     later presentation. An epoch cannot do this job — a token minted after
//     the last epoch bump is, to an epoch, perfectly current no matter how
//     many times it has already been redeemed. That is exactly the measured
//     defect (one email-change token, 200/200/200).
//
//   BUG-234 · session eviction.  A password reset must log the other person
//     out. Enforced by User.tokensValidFrom: a token whose `iat` predates the
//     stamp is refused. A ledger cannot do this job — the attacker's session
//     JWT has never been redeemed, so there is no row to find, and the server
//     cannot enumerate outstanding stateless JWTs to write rows for them.
//
// The epoch does moonlight on one BUG-233 clause: "a completed reset must also
// invalidate every OTHER outstanding reset token". Those tokens are likewise
// un-enumerable, so the epoch is the only thing that can reach them.

import type { PrismaClient } from "@prisma/client";

import type { JwtPayload, TokenPurpose } from "./auth";

/** Prisma's unique-constraint violation. The redeem race hinges on it. */
const UNIQUE_VIOLATION = "P2002";

/**
 * True when a token minted at `iatSeconds` was issued before the user's
 * revocation epoch and must therefore be refused.
 *
 * ⚠️ THE COMPARISON HAPPENS AT SECOND GRANULARITY, ON BOTH SIDES. A JWT `iat`
 * is whole seconds; `tokensValidFrom` is TIMESTAMP(3), i.e. milliseconds. The
 * epoch is floored to its second before comparing, so a token minted in the
 * SAME second as the bump is ACCEPTED.
 *
 * The first cut of this function did the opposite — it compared `iat * 1000`
 * against the raw millisecond epoch and refused the same-second token, on the
 * argument that a spurious re-login in a one-second race was the cheaper error
 * and that the race was not reachable anyway. Device acceptance proved that
 * wrong at machine speed:
 *
 *     login -> PATCH /me/password 200 -> old token correctly 401
 *           -> re-login IN THE SAME SECOND returns a valid 279-char token
 *           -> that token is ALSO 401
 *           -> the same login 5 s later returns 200
 *
 * The 5-second retry is what rules out a units bug: the arithmetic was right,
 * the granularity was wrong. The re-login is not a rare race — a password
 * change forces it, it happens microseconds later, and it lands inside the
 * bump's own second essentially every time. Once BUG-235's reset client exists
 * the same path fires on every reset too.
 *
 * The cost of flooring is a sub-second hole: a token minted in the same second
 * as the bump survives it. For that to matter an attacker's session must be
 * minted in the same wall-clock second as the victim's password change, which
 * is not reachable, while the behaviour it replaces broke legitimate logins
 * every time. Hans ruled the trade deliberately.
 *
 * A token that cannot be placed in time at all is still refused — that branch
 * stays fail-closed and is unrelated to granularity.
 */
export function isIssuedBeforeEpoch(
  iatSeconds: number | undefined,
  epoch: Date | null | undefined,
): boolean {
  if (!epoch) return false; // never revoked — the state of every row today
  if (typeof iatSeconds !== "number" || !Number.isFinite(iatSeconds)) {
    // A verified JWT always carries `iat`. If one somehow does not, we cannot
    // place it relative to the epoch, and "cannot place it" resolves against
    // the token.
    return true;
  }
  // Floor the epoch to the same resolution the token is stamped at, so "same
  // second" compares equal and only STRICTLY earlier seconds are refused.
  const epochSecond = Math.floor(epoch.getTime() / 1000);
  return iatSeconds < epochSecond;
}

/** The narrow row the session guard reads. Two scalars, primary-key lookup. */
export interface SessionEpochRow {
  tokensValidFrom: Date | null;
}

/**
 * Read the revocation epoch for a user. Returns `undefined` when there is no
 * such row — the caller decides what that means (see requireAuth, which treats
 * it as "nothing to revoke", preserving c38a596 behaviour for a token whose
 * user has been deleted; existence checking is not this guard's job).
 */
export async function readTokensValidFrom(
  prisma: PrismaClient,
  userId: string,
): Promise<Date | null | undefined> {
  const row = (await prisma.user.findUnique({
    where: { id: userId },
    select: { tokensValidFrom: true },
  })) as SessionEpochRow | null;
  return row ? row.tokensValidFrom : undefined;
}

/**
 * Bump a user's revocation epoch to `at`, killing every token — session and
 * purpose alike — issued before this instant. Called by both password paths.
 */
export async function bumpTokensValidFrom(
  prisma: PrismaClient,
  userId: string,
  at: Date = new Date(),
): Promise<Date> {
  await prisma.user.update({
    where: { id: userId },
    data: { tokensValidFrom: at },
  });
  return at;
}

export interface RedeemResult {
  ok: boolean;
  /** Why the redemption failed, for the caller's log line. Never surfaced. */
  reason?: "no_jti" | "already_used" | "before_epoch";
}

/**
 * Spend a purpose token, atomically. Returns `{ok:true}` exactly once per
 * token, for every possible interleaving of concurrent callers.
 *
 * The atomicity is the whole point and it comes from the primary key, not from
 * a read: two requests carrying the same token both attempt the insert, the
 * database serialises them, one gets P2002, and only the other is told to
 * proceed. A findFirst-then-create would leave both inside the gap.
 *
 * A token with no `jti` cannot be ledgered and is therefore refused outright.
 * That is the correct answer for a token minted before this commit: it is
 * inside its one-hour window, it predates single-use, and there is no way to
 * tell whether it has already been used. Refusing costs that user one more
 * "forgot password" click; accepting reopens the exact hole being closed.
 */
export async function redeemPurposeToken(
  prisma: PrismaClient,
  payload: JwtPayload,
  purpose: TokenPurpose,
): Promise<RedeemResult> {
  const jti = typeof payload.jti === "string" ? payload.jti : null;
  if (!jti) return { ok: false, reason: "no_jti" };

  try {
    await prisma.usedToken.create({
      data: {
        jti,
        userId: payload.userId,
        purpose,
        // The ledger row is worthless once the signature check refuses the
        // token on its own, so it dies with the JWT it describes.
        expiresAt: new Date(payload.exp * 1000),
      },
    });
    return { ok: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "already_used" };
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Delete ledger rows whose JWT has expired. Pure function of `now`, with no
 * scheduler attached on purpose — nothing in this block runs on a timer. It
 * exists so that whoever wires a sweep later (a cron, a startup hook, an admin
 * route) has one correct implementation to call, and so the retention
 * behaviour is testable today.
 *
 * Safe to run at any cadence, including never: a stale row only ever causes a
 * token to be refused, and that token is already refused by its own expiry.
 */
export async function sweepExpiredUsedTokens(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.usedToken.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}
