// Row 9 (1.1) · OAuth Block 2 Part B — the two calls.
//
// Transcribed from artifacts/api-server/src/routes/auth.ts's
// `completeOAuthSignIn` response, which is the signup/login shape plus one
// field:
//
//   201 — a new account   ·   200 — a sign-in
//   401 — any verification failure, with NO reason on the wire
//   503 { code: "oauth_unavailable" } — that provider is not configured here
//   409 { code: "guest_session_invalid" } — a stale claim, FIRST sign-in only
//   400 — schema refusal, or SMS consent without a phone
//   403 — the account is not active
//
// `auth: false` on both, and it matters: apiClient fires the session-expired
// cascade on a 401 only when the request WANTED auth (WS9 BUG-239). A 401
// here is "that credential was refused", not "your session died", and
// cascading would clear a token the caller does not have and overwrite the
// screen's message with "Your session expired".

import { z } from "zod";

import { apiClient } from "@/lib/api/client";
import { MeUserSchema } from "@/lib/auth";
import type { AuthResponse } from "@/lib/auth";
import type { User } from "@/lib/types";

import type { AppleOAuthBody, GoogleOAuthBody } from "./request";

/**
 * All the claim/routing fields are OPTIONAL, for the reason
 * lib/auth.ts's ClaimResponseFields gives: the app ships to the stores before
 * the server deploys, and a REQUIRED field here would break sign-in on a
 * binary whose server has not caught up.
 */
const OAuthResponseSchema = z.object({
  user: MeUserSchema,
  authToken: z.string(),
  onboardingRequired: z.boolean().optional(),
  claimedPlanId: z.string().nullable().optional(),
  claimRetryable: z.boolean().optional(),
  /**
   * §2.8 — the one field the password responses do not carry. A REPORT of
   * what the server decided, never an echo of what was asked: the client
   * cannot know whether this identity had an account until it is told.
   */
  isNewUser: z.boolean().optional(),
});

export interface OAuthAuthResponse extends AuthResponse {
  isNewUser?: boolean;
}

function toAuthResponse(body: z.infer<typeof OAuthResponseSchema>): OAuthAuthResponse {
  return {
    user: body.user as User,
    authToken: body.authToken,
    onboardingRequired: body.onboardingRequired,
    claimedPlanId: body.claimedPlanId,
    claimRetryable: body.claimRetryable,
    isNewUser: body.isNewUser,
  };
}

export async function appleOAuthRequest(
  body: AppleOAuthBody,
): Promise<OAuthAuthResponse> {
  const res = await apiClient("/auth/oauth/apple", {
    method: "POST",
    body,
    auth: false,
    schema: OAuthResponseSchema,
  });
  return toAuthResponse(res);
}

export async function googleOAuthRequest(
  body: GoogleOAuthBody,
): Promise<OAuthAuthResponse> {
  const res = await apiClient("/auth/oauth/google", {
    method: "POST",
    body,
    auth: false,
    schema: OAuthResponseSchema,
  });
  return toAuthResponse(res);
}
