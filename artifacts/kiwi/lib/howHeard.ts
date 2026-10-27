// CLIENT-3 D (ATTR) — "How did you hear about Kiwi?", once, after a NEW
// account's first sign-in.
//
// One optional screen between a sign-up and wherever that sign-up was going
// (onboarding, or Home after a Test Kitchen claim): one tap answers, Skip
// leaves, and either way the account is never asked again. It is reached only
// from a sign-up that created the account (the password sign-up, or an OAuth
// sign-in the server answered with isNewUser), and a per-account marker on the
// device sends a reload or a deep link straight on.
//
// The answer goes on PATCH /me/profile as howHeard (+ howHeardDetail for "A
// creator"), in a request of its own, unawaited and never retried: an answer is
// worth less than a stalled sign-up. SERVER-6 adds both fields with this list
// (lib/signupAttribution.ts SIGNUP_HOW_HEARD, detail <= 80). Until it lands, the
// route REFUSES them: profilePatchSchema is .strict(), so an old server answers
// 400 rather than stripping the keys, and the answer is lost (nothing else
// rides that request, so nothing else is).

import type { Href } from "expo-router";

import { patchProfile } from "@/lib/api/me";
import { authLanding, type AuthLandingRoute } from "@/lib/authCompletion";
import type { ClaimResponse } from "@/lib/guest/claim";
import { loadJSON, saveJSON } from "@/lib/storage";

export const HOW_HEARD_TITLE = "How did you hear about Kiwi?";

export const HOW_HEARD_OPTIONS = [
  { value: "friend", label: "Friend or family" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "reddit", label: "Reddit" },
  { value: "google", label: "Google search" },
  { value: "app_store", label: "App Store / Play Store search" },
  { value: "creator", label: "A creator" },
  { value: "other", label: "Other" },
] as const;

export type HowHeard = (typeof HOW_HEARD_OPTIONS)[number]["value"];

export const HOW_HEARD_DETAIL_MAX = 80;

/** The PATCH body: the detail only for "A creator", trimmed, and only when typed. */
export function howHeardBody(
  value: HowHeard,
  detail?: string,
): { howHeard: HowHeard; howHeardDetail?: string } {
  const d = value === "creator" ? (detail ?? "").trim().slice(0, HOW_HEARD_DETAIL_MAX).trim() : "";
  return d.length > 0 ? { howHeard: value, howHeardDetail: d } : { howHeard: value };
}

/** Fire-and-forget. Never throws, never awaited by the screen. */
export function sendHowHeard(
  body: { howHeard: HowHeard; howHeardDetail?: string },
  patch: (input: { howHeard: HowHeard; howHeardDetail?: string }) => Promise<unknown> = patchProfile,
): void {
  void patch(body).catch(() => {});
}

const LANDINGS: readonly AuthLandingRoute[] = ["/(tabs)", "/onboarding-prefs"];

/**
 * Where a completed sign-in lands. A new account goes through the question
 * first, carrying where it was going; everyone else lands as before.
 */
export function landingAfterAuth(res: ClaimResponse, isNewAccount: boolean): Href {
  const next = authLanding(res);
  return isNewAccount ? { pathname: "/how-heard", params: { next } } : next;
}

/** The question's onward route; anything unexpected goes through "/" (index.tsx's gate). */
export function howHeardNext(param: unknown): AuthLandingRoute | "/" {
  return typeof param === "string" && (LANDINGS as readonly string[]).includes(param)
    ? (param as AuthLandingRoute)
    : "/";
}

const markerKey = (userId: string) => `howHeardAsked:${userId}`;

export async function wasHowHeardAsked(userId: string): Promise<boolean> {
  return (await loadJSON<boolean>(markerKey(userId), false)) === true;
}

export async function markHowHeardAsked(userId: string): Promise<void> {
  await saveJSON(markerKey(userId), true);
}
