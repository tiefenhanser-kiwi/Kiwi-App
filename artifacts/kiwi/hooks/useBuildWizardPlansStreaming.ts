// Latency Block (D-WS9-076) — streaming replacement for useBuildWizardPlans.
//
// Exposes a react-query-mutation-SHAPED surface (mutate / reset / data /
// isPending / isSuccess / isError / error) so the results screen swaps one hook
// import and its existing render gates keep working — but `data.candidates`
// now GROWS as the SSE stream delivers each card, driving progressive render.
//
// Gate semantics that make the screen progressive with no JSX change:
//   isPending  = in-flight AND zero cards so far   → spinner until first card
//   isSuccess  = at least one card (or clean done) → cards render immediately
//   isError    = failed with zero cards            → error box + retry
//
// Fallback (design contract): on ANY stream failure with zero cards received,
// transparently call the buffered endpoint (which retries) so the worst case is
// exactly today's behavior. 401/402 propagate without a redundant buffered hit.
// If cards already arrived when the stream dies, we keep them rather than error.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildWizardPlans,
  type BuildWizardPlansResult,
} from "@/lib/api/wizard";
import { streamWizardPlans } from "@/lib/api/wizardStream";
import { UnauthenticatedError, UpgradeRequiredError } from "@/lib/api/errors";
import type { WizardPlanCandidate, WizardPreferencesInput } from "@/lib/types";

type Status = "idle" | "streaming" | "success" | "error";

interface InternalState {
  status: Status;
  candidates: WizardPlanCandidate[];
  cannotGenerateMore?: boolean;
  reason?: string;
  error: Error | null;
}

export interface BuildWizardPlansStreamingResult {
  data: BuildWizardPlansResult | undefined;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: Error | null;
  mutate: (input: WizardPreferencesInput) => void;
  reset: () => void;
}

// Test seams — production callers pass nothing and get the real streaming +
// buffered impls. `streamImpl` mirrors streamWizardPlans; `bufferedImpl`
// mirrors buildWizardPlans (the fallback).
export interface UseBuildWizardPlansStreamingDeps {
  streamImpl?: (
    input: WizardPreferencesInput,
    onCandidate: (index: number, candidate: WizardPlanCandidate) => void,
    opts: { signal?: AbortSignal },
  ) => Promise<{ cannotGenerateMore?: boolean; reason?: string }>;
  bufferedImpl?: (
    input: WizardPreferencesInput,
  ) => Promise<BuildWizardPlansResult>;
  // BUG-051 fix (WS9 3c) — fired ONCE when a generation TRULY completes: the
  // stream's `done` resolved (server finished, including its end-of-run
  // last-batch write) OR the buffered fallback succeeded. NOT on the first
  // streamed card (which is when isSuccess flips true for progressive render) —
  // that was the race: the old caller invalidated ["wizard","lastBatch"] on
  // isSuccess, before the server had written the new batch, so the client
  // refetched the OLD batch and never re-asked. Invalidating here happens after
  // the server write, closing BUG-051. Not fired on error / partial-keep (a
  // died-mid-stream run may not have written the batch).
  onComplete?: () => void;
}

const IDLE: InternalState = { status: "idle", candidates: [], error: null };

export function useBuildWizardPlansStreaming(
  deps: UseBuildWizardPlansStreamingDeps = {},
): BuildWizardPlansStreamingResult {
  const streamImpl = deps.streamImpl ?? streamWizardPlans;
  const bufferedImpl = deps.bufferedImpl ?? buildWizardPlans;
  // Track onComplete in a ref so mutate's captured closure always calls the
  // latest callback without needing to be in its useCallback dep list.
  const onCompleteRef = useRef(deps.onComplete);
  onCompleteRef.current = deps.onComplete;
  const [state, setState] = useState<InternalState>(IDLE);
  // Monotonic run id — a re-roll / reset / unmount bumps it so a stale stream's
  // late callbacks (or its fallback) can't clobber the current run's state.
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stop();
    setState(IDLE);
  }, [stop]);

  // Abort any live stream on unmount so a backgrounded screen doesn't keep the
  // socket open or fire a fallback after teardown.
  useEffect(() => stop, [stop]);

  const mutate = useCallback((input: WizardPreferencesInput) => {
    const gen = ++genRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "streaming", candidates: [], error: null });

    // Sparse-by-index buffer; densified for render. Candidates stream in order
    // but indexing defensively tolerates any gap/reorder.
    const received: WizardPlanCandidate[] = [];
    const onCandidate = (index: number, candidate: WizardPlanCandidate) => {
      if (gen !== genRef.current) return;
      received[index] = candidate;
      const dense = received.filter(Boolean);
      setState((s) =>
        s.status === "streaming" ? { ...s, candidates: dense } : s,
      );
    };

    void (async () => {
      try {
        const done = await streamImpl(input, onCandidate, {
          signal: controller.signal,
        });
        if (gen !== genRef.current) return;
        setState((s) => ({
          status: "success",
          candidates: s.candidates,
          cannotGenerateMore: done.cannotGenerateMore,
          reason: done.reason,
          error: null,
        }));
        // Stream truly completed — the server has written its last-batch row.
        onCompleteRef.current?.();
      } catch (err) {
        if (gen !== genRef.current) return;
        // Entitlement / auth walls: a buffered retry hits the same wall, so
        // surface directly.
        if (
          err instanceof UpgradeRequiredError ||
          err instanceof UnauthenticatedError
        ) {
          setState((s) => ({ ...s, status: "error", error: err }));
          return;
        }
        // Cards already arrived → keep them (usable) instead of erroring.
        if (received.filter(Boolean).length > 0) {
          setState((s) => ({ ...s, status: "success" }));
          return;
        }
        // Zero cards → fall back to the buffered endpoint (worst case = today).
        try {
          const buffered = await bufferedImpl(input);
          if (gen !== genRef.current) return;
          setState({
            status: "success",
            candidates: buffered.candidates,
            cannotGenerateMore: buffered.cannotGenerateMore,
            reason: buffered.reason,
            error: null,
          });
          // Buffered fallback succeeded — the server wrote its last-batch row.
          onCompleteRef.current?.();
        } catch (bufErr) {
          if (gen !== genRef.current) return;
          setState({
            status: "error",
            candidates: [],
            error: bufErr instanceof Error ? bufErr : new Error(String(bufErr)),
          });
        }
      }
    })();
  }, [streamImpl, bufferedImpl]);

  const hasCards = state.candidates.length > 0;
  const data: BuildWizardPlansResult | undefined =
    state.status === "success" || hasCards
      ? {
          candidates: state.candidates,
          cannotGenerateMore: state.cannotGenerateMore,
          reason: state.reason,
        }
      : undefined;

  return {
    data,
    isPending: state.status === "streaming" && !hasCards,
    isSuccess: state.status === "success" || hasCards,
    isError: state.status === "error",
    error: state.error,
    mutate,
    reset,
  };
}
