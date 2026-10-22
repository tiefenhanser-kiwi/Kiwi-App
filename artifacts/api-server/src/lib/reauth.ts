// SEC-2 #6 — A STOLEN SESSION MUST NOT BECOME A PERMANENT TAKEOVER.
//
// A session token is a 30-day bearer credential. Before this, holding one was
// enough to move the account's email to an inbox the thief controls (after
// which a password reset hands them the account for good) or to delete the
// account outright. Both routes now ask the person to prove they are the owner
// NOW, not merely that a device once signed in:
//
//   · an account WITH a password — the current password, in the body;
//   · an OAuth-only account (no password to ask for) — a sign-in within the
//     last 10 minutes, read from the token's `auth_time` (lib/auth.ts).
//
// A token minted before SEC-2 carries no `auth_time`; for an OAuth-only account
// it therefore never counts as recent, and the person signs in again first.
// Every other route accepts that token exactly as before.
//
// Refusals are 403, never 401: a 401 tells the client its session is dead and
// signs the person out, which is not what happened.

import type { PrismaClient } from "@prisma/client";

import { verifyPassword } from "./auth";

/** How recent an OAuth-only account's sign-in must be. */
export const REAUTH_WINDOW_SECONDS = 10 * 60;

export type ReauthVerdict =
  | { ok: true }
  | {
      ok: false;
      status: 403;
      body:
        | { code: "reauth_required"; method: "password" | "sign_in"; error: string }
        | { code: "password_incorrect"; error: string };
    };

export async function checkRecentAuth(opts: {
  prisma: PrismaClient;
  userId: string;
  /** req.authTime — seconds, or undefined for a pre-SEC-2 token. */
  authTime: number | undefined;
  /** The body's `currentPassword`, if it sent one. */
  currentPassword: string | undefined;
  now?: Date;
}): Promise<ReauthVerdict> {
  const user = await opts.prisma.user.findUnique({
    where: { id: opts.userId },
    select: { passwordHash: true },
  });
  const passwordHash = user?.passwordHash ?? null;

  if (passwordHash) {
    if (!opts.currentPassword) {
      return {
        ok: false,
        status: 403,
        body: { code: "reauth_required", method: "password", error: "current password required" },
      };
    }
    if (!(await verifyPassword(opts.currentPassword, passwordHash))) {
      return {
        ok: false,
        status: 403,
        body: { code: "password_incorrect", error: "current password is incorrect" },
      };
    }
    return { ok: true };
  }

  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const recent =
    typeof opts.authTime === "number" &&
    opts.authTime <= nowSeconds + 60 && // a clock skew of a minute, no more
    nowSeconds - opts.authTime <= REAUTH_WINDOW_SECONDS;
  if (recent) return { ok: true };
  return {
    ok: false,
    status: 403,
    body: { code: "reauth_required", method: "sign_in", error: "sign in again to continue" },
  };
}
