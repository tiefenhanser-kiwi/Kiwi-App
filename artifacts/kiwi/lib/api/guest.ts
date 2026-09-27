// Row 13 "Test Kitchen" · Block 2 — the four guest routes, plus the two wizard
// routes a guest may call.
//
// Every call here passes `principal: "guest"`, which (lib/api/client.ts):
//   · attaches the guest token from lib/guest/guestToken.ts, never readToken();
//   · refuses any path not on lib/guest/guestRoutes.ts's allowlist;
//   · never fires the session-expired cascade, on any status.
//
// POST /guest/session is the ONE call with `auth: false` — it is how the token
// comes into existence.

import { z } from "zod";

import { apiClient } from "./client";
import {
  WizardExpandedPlanSchema,
  WizardPlanCandidateSchema,
  type WizardExpandRequest,
} from "./wizard";
import type { WizardPlanCandidate, WizardPreferencesInput } from "../types";

// ── POST /guest/session ───────────────────────────────────────────────────

const GuestSessionCreateResponseSchema = z.object({
  guestSessionId: z.string(),
  token: z.string(),
  expiresAt: z.string(),
});
export type GuestSessionCreateResponse = z.infer<
  typeof GuestSessionCreateResponseSchema
>;

/**
 * Mints a guest session. `429 { code: "guest_ip_cap" }` when the per-IP cap is
 * hit (inert until TRUST_PROXY_HOPS > 0), `503` when the guest lane is off.
 * Both arrive as `ApiError` with `.status`, which the entry screen branches on.
 *
 * R12 — `turnstileToken` is sent ONLY when the client has one. The server lets
 * the check pass through while TURNSTILE_SECRET_KEY is unset, so omitting is
 * correct today and the field is already on the wire for when keys land.
 */
export async function createGuestSession(
  opts: { turnstileToken?: string } = {},
): Promise<GuestSessionCreateResponse> {
  return apiClient("/guest/session", {
    method: "POST",
    auth: false,
    body: opts.turnstileToken ? { turnstileToken: opts.turnstileToken } : {},
    schema: GuestSessionCreateResponseSchema,
  });
}

// ── GET /guest/session ───────────────────────────────────────────────────

const GuestSessionReadSchema = z.object({
  id: z.string(),
  expiresAt: z.string(),
  generationCount: z.number(),
  hasDraft: z.boolean(),
  // The guest's wizard answers, stored as the build-plans body that produced
  // the generation. Unknown-shaped on purpose: it round-trips into the expand's
  // candidateContext and is re-read as a slice, never trusted field-by-field.
  preferences: z.unknown().nullable(),
  // Returned RAW — the same candidate wire the generate put out, so it parses
  // with the schema the options screen already uses. null (never []) before the
  // first generation.
  candidates: z.array(WizardPlanCandidateSchema).nullable(),
});
export type GuestSessionRead = z.infer<typeof GuestSessionReadSchema>;

export async function getGuestSession(): Promise<GuestSessionRead> {
  return apiClient("/guest/session", {
    principal: "guest",
    schema: GuestSessionReadSchema,
  });
}

// ── GET /guest/draft ─────────────────────────────────────────────────────

const GuestDraftSchema = z.object({
  draft: z.object({ id: z.string(), createdAt: z.string() }),
  expanded: WizardExpandedPlanSchema,
});
export type GuestDraft = z.infer<typeof GuestDraftSchema>;

/**
 * The guest's expanded plan, in GET /wizard/drafts/:id's envelope.
 * `404 { code: "no_draft" }` when they have not opened a candidate yet.
 */
export async function getGuestDraft(): Promise<GuestDraft> {
  return apiClient("/guest/draft", {
    principal: "guest",
    schema: GuestDraftSchema,
  });
}

// ── POST /guest/events ───────────────────────────────────────────────────

/**
 * R11's names, and ONLY these: the client-postable subset of the server's
 * GUEST_EVENTS. `generated`, `expanded`, `catalog_only_gap` and
 * `claim_plan_failed` are written server-side — `generated` is client-postable
 * on the server's list but the server row is the authoritative one, so this
 * client does not duplicate it.
 */
export const GUEST_CLIENT_EVENTS = [
  "wizard_step",
  "thin_shelf",
  "plan_opened",
  "recipe_opened",
  "door_tapped",
  "signup_started",
] as const;
export type GuestClientEvent = (typeof GUEST_CLIENT_EVENTS)[number];

/**
 * Best-effort (R11): a failed event NEVER blocks the UI, so this swallows
 * everything — including the "no guest token" throw, which happens naturally
 * the moment a claim clears the session while an event is in flight.
 *
 * Deliberately not awaited by callers. `void trackGuestEvent(...)`.
 */
export async function trackGuestEvent(
  event: GuestClientEvent,
  opts: { step?: string; meta?: unknown } = {},
): Promise<void> {
  try {
    await apiClient("/guest/events", {
      method: "POST",
      principal: "guest",
      body: {
        event,
        ...(opts.step ? { step: opts.step } : {}),
        ...(opts.meta === undefined ? {} : { meta: opts.meta }),
      },
      parseAs: "none",
    });
  } catch {
    // Telemetry never sinks the funnel it measures.
  }
}

// ── POST /wizard/build-plans (guest) ─────────────────────────────────────

const GuestBuildPlansResponseSchema = z.object({
  candidates: z.array(WizardPlanCandidateSchema),
  cannotGenerateMore: z.boolean().optional(),
  reason: z.string().optional(),
});

/**
 * The guest's ONE generation. BUFFERED, not the SSE stream: the stream client
 * (lib/api/wizardStream.ts) reads `readToken()` directly through expo/fetch and
 * owns its own status handling, so teaching it a second principal would put the
 * member path's cascade at risk to give a one-shot flow progressive cards. A
 * guest sees a loader instead. `409 { code: "guest_generation_used" }` arrives
 * as `ApiError` with `.status === 409`.
 *
 * No `exclude` parameter: the session extras exist for re-rolls, and a guest has
 * none — a second generation is a door.
 */
export async function buildGuestPlans(
  input: WizardPreferencesInput,
): Promise<{ candidates: WizardPlanCandidate[]; cannotGenerateMore?: boolean; reason?: string }> {
  return apiClient("/wizard/build-plans", {
    method: "POST",
    principal: "guest",
    body: input,
    schema: GuestBuildPlansResponseSchema,
  });
}

// ── POST /wizard/expand (guest) ──────────────────────────────────────────

/**
 * The guest expand is CATALOG-ONLY and the server says so in the response, not
 * by status: a candidate the catalog cannot fill entirely comes back
 * `409 { code: "catalog_only_gap", liveSlotTitles, storeSlotCount }`, which the
 * wrapper would otherwise surface as an `ApiError`. This returns a DISCRIMINATED
 * UNION instead, because the gap is a door (R6), not a failure — and it reads
 * the CODE off the body rather than keying on 409, which this route also uses
 * for the draft-superseded case on the member path.
 */
const CatalogOnlyGapBodySchema = z.object({
  code: z.literal("catalog_only_gap"),
  liveSlotTitles: z.array(z.string()).optional(),
  storeSlotCount: z.number().optional(),
});

export type GuestExpandResult =
  | { status: "expanded"; draft: GuestDraft }
  | { status: "catalog_only_gap"; liveSlotTitles: string[] };

export async function expandGuestCandidate(
  request: WizardExpandRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<GuestExpandResult> {
  const result = await apiClient("/wizard/expand", {
    method: "POST",
    principal: "guest",
    body: request,
    signal: opts.signal,
    errorMode: "envelope",
  });
  if (result.success) {
    const parsed = GuestDraftSchema.safeParse(result.data);
    if (!parsed.success) {
      throw new Error("The plan came back in a shape Kiwi could not read.");
    }
    return { status: "expanded", draft: parsed.data };
  }
  // The thin shelf, read off the BODY (the status is whatever the route chose).
  const gap = CatalogOnlyGapBodySchema.safeParse(
    (result.error as { body?: unknown }).body,
  );
  if (gap.success) {
    return { status: "catalog_only_gap", liveSlotTitles: gap.data.liveSlotTitles ?? [] };
  }
  throw result.error;
}
