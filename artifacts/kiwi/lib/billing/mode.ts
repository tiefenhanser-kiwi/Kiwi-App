// CLIENT-7 A (D-WS9-356) — free during launch: the billing mode, and the last one
// this device saw.
//
// SERVER-9 A sends `billing: { mode: "free_launch" | "enforced" }` on GET
// /me/subscription (the one source every billing surface reads, through
// subscriptionView.ts isFreeLaunch) and on every user shape: sign-up, login,
// OAuth, /auth/me, PATCH /me/profile. "free_launch" is sent exactly when
// enforcement is off.
//
// Welcome and Sign-up render before anyone signs in, so they cannot read it. They
// read the mode the device last saw instead (Q2, Hans via chat, Oct 29): stored
// from every user shape and every subscription read, and a device that has
// stored nothing (a fresh install) shows the free copy. If enforcement comes
// back, that is a new build, which can change this. No public endpoint.
//
// An answer with no `billing` field (an older server) stores nothing: the
// remembered mode is the last one a server actually said.

import { loadJSON, saveJSON } from "@/lib/storage";

export type BillingMode = "free_launch" | "enforced";

/** Through lib/storage.ts, which prefixes "kiwi:". */
export const BILLING_MODE_DEVICE_KEY = "billingMode";

/** A wire `billing` field's mode, or null for anything else (absent, null, an unknown mode). */
export function billingModeOf(field: unknown): BillingMode | null {
  if (field === null || typeof field !== "object") return null;
  const mode = (field as { mode?: unknown }).mode;
  return mode === "free_launch" || mode === "enforced" ? mode : null;
}

export async function loadRememberedBillingMode(): Promise<BillingMode | null> {
  return billingModeOf({ mode: await loadJSON<unknown>(BILLING_MODE_DEVICE_KEY, null) });
}

/** Store a wire `billing` field's mode. A field with no mode stores nothing. */
export async function rememberBillingMode(field: unknown): Promise<void> {
  const mode = billingModeOf(field);
  if (mode !== null) await saveJSON(BILLING_MODE_DEVICE_KEY, mode);
}

/** Before sign-in: free unless a server last said "enforced". Nothing stored reads as free. */
export function preAuthFreeLaunch(remembered: BillingMode | null): boolean {
  return remembered !== "enforced";
}
