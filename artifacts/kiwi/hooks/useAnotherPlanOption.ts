// WS9 Plan-flow redesign (D-WS9-191) Block 3 Part A — BUG-289.
//
// One "Get another plan option" run, owned here so the rule that fixes the
// freeze is testable (app/** is outside the test glob, D-WS9-164):
//
//   🔴 THE BUSY FLAG IS RELEASED BY THE THING THAT KNOWS THE RUN SETTLED,
//   NEVER BY THE THING THAT DECIDES WHETHER TO RENDER THE RESULT.
//
// The freeze: the screen's insert effect was the only path clearing `busy` on
// success, and it early-returned on a dedupe hit BEFORE clearing — so a second
// press whose candidate collided (on the AI-minted id, BUG-289's other half)
// left the skeleton and the greyed button on screen forever. Here the settle
// effect (isComplete OR isError) clears `busy` unconditionally; the card
// effect only decides whether a card is delivered.
//
// `counted` dedupes the stream's within-run catch-up re-delivery on the
// CONTENT identity (candidateIdentity), and is cleared at the start of every
// run — it was never meant to persist across runs.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  useBuildWizardPlansStreaming,
  type UseBuildWizardPlansStreamingDeps,
  type WizardExclusionArg,
} from "@/hooks/useBuildWizardPlansStreaming";
import { candidateIdentity } from "@/lib/wizard/planOptions";
import type { WizardPlanCandidate } from "@/lib/types";

export interface AnotherRunOutcome {
  /** A card reached `onCard` and it accepted it (a press was consumed). */
  delivered: boolean;
  /** Set when the run failed (zero cards; the buffered fallback failed too). */
  error: Error | null;
  /** The server's cannotGenerateMore reason, when it sent one. */
  reason?: string;
}

export interface UseAnotherPlanOptionOpts<TInput> extends UseBuildWizardPlansStreamingDeps<TInput> {
  /**
   * The ONE card of a run (the first of the response, whatever the server
   * sent). Return true when it was inserted; false when the list already held
   * it (a duplicate is not a delivery — no press consumed).
   */
  onCard: (candidate: WizardPlanCandidate) => boolean;
  /** Fired exactly once per run, when it settled — card or not, error or not. */
  onSettled: (outcome: AnotherRunOutcome) => void;
}

export interface AnotherPlanOption<TInput> {
  /** True from `start` until the run settles. The button's disable + the skeleton's gate. */
  busy: boolean;
  /** True once this run has produced a card (the skeleton can drop before `done`). */
  hasCard: boolean;
  start: (input: TInput, extras?: WizardExclusionArg) => void;
}

export function useAnotherPlanOption<TInput>(
  opts: UseAnotherPlanOptionOpts<TInput>,
): AnotherPlanOption<TInput> {
  const { onCard, onSettled, ...deps } = opts;
  const run = useBuildWizardPlansStreaming<TInput>(deps);
  const [busy, setBusy] = useState(false);
  // Latest callbacks without re-subscribing the effects.
  const onCardRef = useRef(onCard);
  onCardRef.current = onCard;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const countedRef = useRef<Set<string>>(new Set());
  const deliveredRef = useRef(false);

  const candidates = run.data?.candidates;

  // The card effect: decides delivery, touches nothing else.
  useEffect(() => {
    if (!busy || !candidates || candidates.length === 0) return;
    // ONE press = ONE plan: the first card of the response, whatever the server
    // sent (a pre-Block-1 server ignores the count and returns three).
    const fresh = candidates[0];
    const identity = candidateIdentity(fresh);
    if (countedRef.current.has(identity)) return;
    countedRef.current.add(identity);
    if (onCardRef.current(fresh)) deliveredRef.current = true;
  }, [busy, candidates]);

  // The settle effect: the ONLY owner of `busy` on the way down.
  useEffect(() => {
    if (!busy) return;
    if (!run.isComplete && !run.isError) return;
    setBusy(false);
    onSettledRef.current({
      delivered: deliveredRef.current,
      error: run.isError ? run.error : null,
      reason: run.data?.reason,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, run.isComplete, run.isError]);

  const { reset, mutate } = run;
  const start = useCallback(
    (input: TInput, extras?: WizardExclusionArg) => {
      countedRef.current = new Set();
      deliveredRef.current = false;
      setBusy(true);
      reset();
      mutate(input, extras);
    },
    [reset, mutate],
  );

  return { busy, hasCard: (candidates?.length ?? 0) > 0, start };
}
