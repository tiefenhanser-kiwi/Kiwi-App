/**
 * Password-reset wrappers — WS9A BUG-235 / D-WS9-241 (C).
 *
 * The two `/auth/password-reset/*` routes had no client at all: the reset
 * web page at the Cloud Run host root (D-WS9-231) was the only surface, and
 * its "Open in the Kiwi app" link (`kiwi://reset-password?token=…`) landed on
 * an unmatched route. These wrappers feed the in-app request screen
 * (`app/(auth)/forgot-password.tsx`) and confirm screen
 * (`app/(auth)/reset-password.tsx`).
 *
 * Why this is its own file and not `lib/api/auth.ts`: the auth-core lane
 * (D-WS9-241 A/B/E) owns `lib/api/auth.ts`, `lib/auth.ts` and
 * `contexts/AuthContext.ts`; keeping the reset wrappers here makes the two
 * lanes file-disjoint.
 *
 * Neither route signs the user in. `request` answers `200 { success: true }`
 * whether or not the email exists (anti-enumeration — never branch UI on the
 * account's existence); `confirm` answers `200 { success: true }` with no
 * token and no user in the body, and the caller is still logged out. The
 * screens route to sign-in afterwards; they do not touch `useAuth()`.
 *
 * Error shape (throw mode): every non-2xx is an `ApiError` with `.status` and
 * `.message = body.error` — e.g. `400 "invalid request body"` (schema),
 * `400 "invalid or expired reset token"` (one opaque 400 for bad / expired /
 * already-spent, BUG-233), `429 "Too many requests, slow down."` — and a
 * fetch rejection is an `ApiNetworkError`. Both routes are unauthenticated,
 * so `auth: false` and no 401 cascade (BUG-239).
 *
 * Path convention per `client.ts`: leading slash, no `/api` (apiBase has it).
 */

import { z } from "zod";

import { apiClient } from "./client";

const SuccessSchema = z.object({ success: z.literal(true) });

/** `POST /auth/password-reset/request` — asks the server to email a reset
 *  link. Resolves on the server's always-200; the caller cannot learn whether
 *  the email matched an account. */
export async function requestPasswordReset(email: string): Promise<void> {
  await apiClient("/auth/password-reset/request", {
    method: "POST",
    body: { email },
    auth: false,
    schema: SuccessSchema,
  });
}

/** `POST /auth/password-reset/confirm` — spends the token from the emailed
 *  link and sets the new password. Server-side bounds are min 8 / max 100
 *  (`resetConfirmSchema`); a violation is a schema 400, so screens
 *  pre-validate. Does NOT sign the user in. */
export async function confirmPasswordReset(
  token: string,
  newPassword: string,
): Promise<void> {
  await apiClient("/auth/password-reset/confirm", {
    method: "POST",
    body: { token, newPassword },
    auth: false,
    schema: SuccessSchema,
  });
}
