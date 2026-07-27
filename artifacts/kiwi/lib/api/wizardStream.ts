// Latency Block (D-WS9-076) — streaming client for POST /api/wizard/build-plans.
//
// Consumes the server's SSE stream (event: candidate / done / error) via
// `expo/fetch`, whose FetchResponse.body is a real ReadableStream (React
// Native's global fetch is NOT streamable — that's why this uses expo/fetch).
// Each candidate is validated with the SAME WizardPlanCandidateSchema the
// buffered path uses and handed to onCandidate the moment it arrives, so the
// results screen paints cards progressively.
//
// This layer is deliberately transport-only: it throws on ANY failure so the
// hook (useBuildWizardPlansStreaming) can own the fallback-to-buffered
// decision. It does not retry and does not touch React state.

import { fetch as expoFetch } from "expo/fetch";

import { apiBase } from "./base";
import { readToken } from "../auth";
import { emitSessionExpired } from "./auth-bridge";
import {
  ApiError,
  ApiNetworkError,
  UnauthenticatedError,
  UpgradeRequiredError,
  extractUserFacingMessage,
} from "./errors";
import { WizardPlanCandidateSchema } from "./wizard";
import type { WizardPlanCandidate, WizardPreferencesInput } from "../types";

// If no bytes arrive for this long mid-stream, treat the stream as stalled,
// abort it, and throw so the hook falls back to the buffered endpoint. Chosen
// well above the model's inter-token gap (~64 tok/s) but low enough that a
// wedged stream doesn't leave the user staring at a spinner. 20s.
export const WIZARD_STREAM_STALL_MS = 20_000;

export interface WizardStreamDoneMeta {
  cannotGenerateMore?: boolean;
  reason?: string;
}

/**
 * Opens the SSE stream and invokes `onCandidate` for each validated candidate
 * in arrival order. Resolves with the done-frame metadata on clean completion.
 *
 * Throws (never silently degrades) on: transport failure, a stall, an HTTP
 * error status, a server `error` frame, or a body the platform can't stream.
 * `UnauthenticatedError`/`UpgradeRequiredError` propagate as-is so the hook can
 * choose NOT to fall back (a buffered retry would hit the same wall).
 */
export async function streamWizardPlans(
  input: WizardPreferencesInput,
  onCandidate: (index: number, candidate: WizardPlanCandidate) => void,
  opts: {
    signal?: AbortSignal;
    stallMs?: number;
    // Test seam — inject a fetch. Production omits (uses expo/fetch, the only
    // RN fetch whose response body is a real ReadableStream).
    fetchImpl?: typeof expoFetch;
  } = {},
): Promise<WizardStreamDoneMeta> {
  const doFetch = opts.fetchImpl ?? expoFetch;
  const token = await readToken();
  if (!token) {
    emitSessionExpired();
    throw new UnauthenticatedError({
      status: 401,
      body: null,
      userFacingMessage: "You need to be signed in.",
    });
  }

  // Stall watchdog + external-signal composition into one AbortController.
  const controller = new AbortController();
  const stallMs = opts.stallMs ?? WIZARD_STREAM_STALL_MS;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let stalled = false;
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };
  const clearStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };
  const onExternalAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onExternalAbort);
  }

  try {
    let res: Awaited<ReturnType<typeof expoFetch>>;
    armStall();
    try {
      res = await doFetch(`${apiBase}/wizard/build-plans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch (cause) {
      if (stalled) throw new ApiNetworkError("Stream stalled", cause);
      throw new ApiNetworkError(
        cause instanceof Error ? cause.message : "Stream request failed",
        cause,
      );
    }

    if (!res.ok) {
      // Read the error body so typed errors carry the server's message. Mirror
      // apiClient's status routing for the two non-fallback cases.
      let rawBody: unknown = undefined;
      try {
        rawBody = await res.json();
      } catch {
        /* non-JSON error body — leave undefined */
      }
      const userFacingMessage = extractUserFacingMessage(rawBody);
      const details = { status: res.status, body: rawBody, userFacingMessage };
      if (res.status === 401) {
        emitSessionExpired();
        throw new UnauthenticatedError(details);
      }
      if (res.status === 402) throw new UpgradeRequiredError(details);
      throw new ApiError(
        userFacingMessage ?? `Stream failed (${res.status})`,
        details,
      );
    }

    const body = res.body;
    if (!body) {
      // Platform returned a non-streamable body (e.g. web without streaming) —
      // signal the hook to fall back rather than hang.
      throw new ApiNetworkError("Response body is not streamable", null);
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done: WizardStreamDoneMeta | null = null;

    // SSE frames are separated by a blank line. Parse whole frames out of the
    // rolling buffer; keep any partial tail for the next chunk.
    const consumeFrames = () => {
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseFrame(frame);
        if (!parsed) continue;
        if (parsed.event === "candidate") {
          const c = WizardPlanCandidateSchema.safeParse(parsed.data?.candidate);
          const index = parsed.data?.index;
          if (c.success && typeof index === "number") {
            onCandidate(index, c.data as WizardPlanCandidate);
          }
          // A candidate that fails validation is dropped, not fatal — the
          // server also sends it in the catch-up before `done`.
        } else if (parsed.event === "error") {
          throw new ApiError(
            typeof parsed.data?.error === "string"
              ? parsed.data.error
              : "Kiwi got distracted. Try again?",
            {
              status: 502,
              body: parsed.data,
              userFacingMessage:
                typeof parsed.data?.error === "string"
                  ? parsed.data.error
                  : undefined,
            },
          );
        } else if (parsed.event === "done") {
          done = {
            cannotGenerateMore:
              typeof parsed.data?.cannotGenerateMore === "boolean"
                ? parsed.data.cannotGenerateMore
                : undefined,
            reason:
              typeof parsed.data?.reason === "string"
                ? parsed.data.reason
                : undefined,
          };
        }
      }
    };

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        if (stalled) throw new ApiNetworkError("Stream stalled", cause);
        throw new ApiNetworkError(
          cause instanceof Error ? cause.message : "Stream read failed",
          cause,
        );
      }
      if (chunk.done) break;
      armStall(); // progress — reset the watchdog
      buffer += decoder.decode(chunk.value, { stream: true });
      consumeFrames();
      if (done) break;
    }

    if (!done) {
      // Stream ended without a done frame — server closed early. Treat as a
      // failure so the hook can fall back if nothing usable arrived.
      throw new ApiNetworkError("Stream ended before completion", null);
    }
    return done;
  } finally {
    clearStall();
    if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
  }
}

// Parse one SSE frame ("event: X\ndata: {...}") into { event, data }. Returns
// null for a comment/keepalive or an unparseable data line.
function parseFrame(
  frame: string,
): { event: string; data: Record<string, unknown> | null } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { event, data: null };
  }
}
