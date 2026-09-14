import { z } from "zod";

// The ONE phone rule. Permissive: at least 7 digits anywhere in the string,
// at most 40 characters. Mobile-side formatting (dashes, parens, country
// code) is up to the client; the server only insists there is a number in
// there that could be dialled.
//
// Shared by PATCH /me/profile (where it was born, WS7-2) and POST /auth/signup
// (D-WS9-241 A, BUG-261) so the phone a user can enter at signup and the
// phone they can edit to later are, by construction, the same set.
//
// ⚠️ KEEP IN SYNC with the mobile mirror: artifacts/kiwi/lib/phone.ts carries
// the identical regex + length (separate package, no cheap shared module) so
// the form can refuse what this refuses BEFORE the round-trip. Change BOTH.
export const PHONE_MAX_LENGTH = 40;
export const PHONE_REGEX = /(?:\D*\d){7,}/;

export const phoneSchema = z
  .string()
  .max(PHONE_MAX_LENGTH)
  .regex(PHONE_REGEX, "phone must contain at least 7 digits");
