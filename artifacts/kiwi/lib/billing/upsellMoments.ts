// Row 9 (1.1) · Stripe S2 Part B — THE THREE UPSELL MOMENTS (D-WS9-270 §5a).
//
// The experiment: show the upsell where the product has just proved itself,
// rather than only where the user runs into a wall. Three moments, each ONCE per
// device, ever.
//
// 🔴 A CONFIG LIST, NOT THREE CALLSITE HABITS. The failure mode this shape
// exists to prevent is the same one lib/guest/doors.ts was built against and is
// worth repeating: the fourth moment, added in a later block by someone who
// re-implements "have we shown this" slightly differently, and a user who gets
// the upsell twice. A moment is a KEY IN THIS TABLE plus one `maybeFire` call;
// there is no second place to get the gate wrong.
//
// ── THE FOUR GATES, AND WHY EACH ONE IS NOT NEGOTIABLE ───────────────────
//
//   1. `enforced` false → never. The whole billing surface is dark before the
//      cutover (§2.1), and an upsell is the loudest thing in it.
//   2. status not `trialing` → never. The upsell's copy is "keep every week this
//      easy" and its whole argument is the pay-early bonus; showing it to a
//      lapsed account is the wrong sheet, and to an `active` one it is an
//      apology waiting to happen.
//   3. already seen on this device → never. Deliberate break (2) in the S2
//      report removes this and watches a moment fire twice.
//   4. NEVER BLOCKING. Structural rather than asserted: `shouldFire` returns a
//      boolean and the caller opens a sheet whose secondary button is "Not now".
//      Nothing here awaits the user, and no moment sits between an action and
//      its result — the plan is generated, the list is built and the Instacart
//      link is opened BEFORE the sheet is asked for.

import { loadJSON, saveJSON } from "@/lib/storage";

import type { SubscriptionPayload } from "./subscriptionView";

/**
 * The moments, with the event each one rides. The `where` note is the answer to
 * "was this wired where the event already fires, or did the lane invent a hook?"
 * — §27.2's question, answered in the table rather than in a report only.
 */
export const UPSELL_MOMENTS = {
  first_plan_generated: {
    where: "app/plan-options.tsx — the first batch settling (mode-agnostic)",
  },
  first_grocery_list: {
    where: "lib/groceryHandoff.ts — a generate result that resolved to navigate",
  },
  first_instacart_handoff: {
    where: "app/grocery-list/[id].tsx — after Linking.openURL resolves",
  },
} as const;

export type UpsellMoment = keyof typeof UPSELL_MOMENTS;

export function allUpsellMoments(): UpsellMoment[] {
  return Object.keys(UPSELL_MOMENTS) as UpsellMoment[];
}

function isUpsellMoment(x: unknown): x is UpsellMoment {
  return typeof x === "string" && x in UPSELL_MOMENTS;
}

/** The device key, through lib/storage.ts (which prefixes "kiwi:"). */
export const UPSELL_MOMENTS_DEVICE_KEY = "billingUpsellMomentsSeen";

// ── the gate ─────────────────────────────────────────────────────────────

export interface UpsellMomentInput {
  moment: UpsellMoment;
  /** null while `GET /me/subscription` has not answered — no upsell over a load. */
  sub: SubscriptionPayload | null;
  /** What this device has already shown. An unreadable store is an EMPTY set. */
  seen: ReadonlySet<UpsellMoment>;
}

/**
 * Gates 1–3. Pure, so the test walks every status × `enforced` × seen
 * combination instead of trusting three screens to have each remembered.
 *
 * ⚠️ AN UNREADABLE STORE ERRS TOWARDS SHOWING, and that is the opposite of the
 * personalize nudge's ruling (lib/home/personalizeNudge.ts starts its device
 * flag `true` so a modal the user must tap through cannot flash). The difference
 * is what happens when the guess is wrong: this sheet is dismissible with "Not
 * now" and never traps, so a second sighting costs a tap, while a nudge shown
 * again costs a decision. Both defaults follow from "which error is cheaper for
 * this particular surface", which is why they disagree.
 */
export function shouldFireUpsellMoment(input: UpsellMomentInput): boolean {
  const { moment, sub, seen } = input;
  if (sub === null) return false;
  // 🔴 Gate 1 — the blackout.
  if (!sub.enforced) return false;
  // Gate 2 — the upsell is a trial-only sheet.
  if (sub.status !== "trialing") return false;
  // Gate 3 — once per device, ever.
  return !seen.has(moment);
}

// ── the persisted set ────────────────────────────────────────────────────
//
// lib/storage.ts already swallows every throw and returns the fallback, on both
// platforms (AsyncStorage on native, its localStorage shim on web), so the
// try/catch §2.5 asks for is satisfied by using it rather than by re-wrapping
// it. What this layer adds is TOLERATING GARBAGE: the stored value is an array
// of strings, and a value that is not one — a hand-edited key, a shape from a
// future version, a half-written write — must read as "nothing seen" rather
// than throw inside a render.

export async function loadSeenMoments(): Promise<Set<UpsellMoment>> {
  const raw = await loadJSON<unknown>(UPSELL_MOMENTS_DEVICE_KEY, []);
  return parseSeenMoments(raw);
}

/** Exported for the test: every malformed shape collapses to an empty set. */
export function parseSeenMoments(raw: unknown): Set<UpsellMoment> {
  if (!Array.isArray(raw)) return new Set();
  // Unknown keys are dropped rather than kept: a retired moment left in storage
  // must not come back as a member of a typed set.
  return new Set(raw.filter(isUpsellMoment));
}

/**
 * Record a moment as shown and return the new set.
 *
 * Returns the set SYNCHRONOUSLY-USABLE (the caller updates its state from the
 * return value) and persists in the background, because the in-memory set is
 * what stops a double-fire inside one session and a storage write that loses
 * the race must not be able to cause one.
 */
export async function markMomentSeen(
  moment: UpsellMoment,
  seen: ReadonlySet<UpsellMoment>,
): Promise<Set<UpsellMoment>> {
  const next = new Set(seen);
  next.add(moment);
  await saveJSON(UPSELL_MOMENTS_DEVICE_KEY, [...next]);
  return next;
}
