// SERVER-9 B (BUG-603, P1 security) — refuse common and breached passwords.
//
// Checked wherever a NEW password is set: POST /auth/signup, POST
// /auth/password-reset/confirm, PATCH /me/password. Never at login: existing
// accounts are not forced to change.
//
// The list: SecLists' top 10,000 (lib/commonPasswordsList.ts, MIT, cited
// there), plus "kiwi", "kitchenwizard" and the account's own email local part
// (with and without a "+tag"). Compared after trimming, case-insensitively, so
// "Password1" and " letmein " are on it. The length rule (8–100, the routes' zod
// schemas) is unchanged and runs first: a short common password is still
// answered by the length rule.

import { SECLISTS_COMMON_10K } from "./commonPasswordsList";

export const PASSWORD_TOO_COMMON = "password_too_common";
export const PASSWORD_TOO_COMMON_MESSAGE =
  "That password is too common. Try a longer phrase only you would use.";

/** Kiwi's own names: the first thing anyone tries against a Kiwi account. */
const KIWI_WORDS = ["kiwi", "kitchenwizard"];

function normalise(s: string): string {
  return s.trim().toLowerCase();
}

const COMMON: ReadonlySet<string> = new Set([...SECLISTS_COMMON_10K, ...KIWI_WORDS].map(normalise));

/** The email's local part, and the same without a "+tag" when it has one. */
function localParts(email: string): string[] {
  const at = email.lastIndexOf("@");
  const local = normalise(at >= 0 ? email.slice(0, at) : email);
  if (local === "") return [];
  const untagged = local.split("+")[0] ?? "";
  return untagged !== "" && untagged !== local ? [local, untagged] : [local];
}

export function isCommonPassword(password: string, email?: string | null): boolean {
  const p = normalise(password);
  if (COMMON.has(p)) return true;
  return email ? localParts(email).includes(p) : false;
}

/** The 400 body. `userFacingMessage` is what the app shows (kiwi lib/api/errors.ts). */
export function passwordTooCommonBody(): { error: string; userFacingMessage: string } {
  return { error: PASSWORD_TOO_COMMON, userFacingMessage: PASSWORD_TOO_COMMON_MESSAGE };
}
