// /plan-options — WS9 Plan-flow redesign (D-WS9-191) Block 2 Part B. Written
// fresh (Hans: "writing it from scratch is honestly probably the best path to
// avoid drift"); it REPLACES app/wizard-results.tsx, which stays in the tree
// unrouted until Block 3 removes it (D-WS9-032 point 7).
//
// The ruling this implements: the wizard's generate lands on ONE screen of
// candidate cards, each a pared-back plan review, with three actions — Use This
// Week · Save for Later · Not For Me — and one button below the cards, "Get
// another plan option": one press = one plan, four presses then the
// refine-or-Tell-Kiwi card. Use This Week saves + activates + routes to the
// EXISTING Plan Review; Save for Later saves and confirms in place. There is no
// unsaved-draft Plan Review, no "View details", no "More options ↺".
//
// Three entry modes, the same params as the retired chooser so the wizard,
// Tell Kiwi and "See previous options" route here with no param change:
//   wizard    — `input` (WizardPreferencesInput JSON); mount fires the
//               build-plans STREAM (progressive cards, buffered fallback).
//   tellkiwi  — `source:"tellkiwi"` + `tellKiwiResult` (pre-built) +
//               `tellKiwiInput`; no generation here.
//   rehydrate — `rehydrate:"1"` + `rehydratedCandidates`; no generation.
//
// The rules live in lib/wizard/planOptions.ts (tested); this file is the wiring:
// fetches, navigation, the toast. app/** is outside the test glob (D-WS9-164) —
// the device pass is this file's gate.
//
// 🔴 HOOKS SIT ABOVE THE EARLY RETURNS.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutAnimation,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { ExhaustedCard } from "@/components/ExhaustedCard";
import { Header } from "@/components/Header";
import { PlanOptionCard, PlanOptionCardSkeleton, type PlanOptionCardBusyAction } from "@/components/PlanOptionCard";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useToast } from "@/contexts/ToastProvider";
import {
  useBuildWizardPlansStreaming,
  type UseBuildWizardPlansStreamingDeps,
} from "@/hooks/useBuildWizardPlansStreaming";
import { ApiError } from "@/lib/api/errors";
import { getPlans, patchPlan } from "@/lib/api/plans";
import { buildFromText, type BuildFromTextResult } from "@/lib/api/tellKiwi";
import {
  activateWizardDraft,
  buildWizardPlans,
  dismissWizardCandidate,
  expandWizardCandidate,
  getWizardLimits,
  saveWizardDraft,
} from "@/lib/api/wizard";
import { streamWizardPlans } from "@/lib/api/wizardStream";
import { demotionToastMessage } from "@/lib/plans/planLifecycleActions";
import { decidePlanDetailsCta } from "@/lib/plans/wizardPostSaveCta";
import { resolveActivatedPlanRouteAfter404 } from "@/lib/wizard/activateRecovery";
import {
  ANOTHER_LABEL,
  anotherRequestFor,
  anyBusy,
  appendCandidates,
  buildCandidateContext,
  DEFAULT_MAX_PRESSES,
  dismissCard,
  dismissRequestFor,
  EMPTY_PLAN_OPTIONS,
  EXHAUSTED_PLANS_TITLE,
  insertAnother,
  noticeFor,
  patchCard,
  PLAN_OPTIONS_TITLE,
  pressesLeft,
  sublineFor,
  visibleCards,
  type PlanOptionCard as PlanOptionCardModel,
  type PlanOptionList,
  type PlanOptionsMode,
  type PlanOptionsSource,
} from "@/lib/wizard/planOptions";
import { EMPTY_SESSION_EXCLUSION, toExclusionRequest } from "@/lib/wizard/sessionExclusion";
import type { TellKiwiInput, WizardPlanCandidate, WizardPreferencesInput } from "@/lib/types";

// The client-side ceiling over the expand + activate legs (expand ~10-15s,
// activate's materialize + finalize-steps ~35s observed). 90s sits past the
// server tx budget so a real success is never read as a timeout — the same
// figure Plan Review's draft flow and the retired chooser used.
const CHAIN_CLIENT_TIMEOUT_MS = 90_000;

// Copy — the existing flows' lines, verbatim.
const STILL_WORKING_COPY =
  "Kiwi is still working on it. Check your plans in a moment — it may have saved.";
const DRAFT_ARCHIVED_COPY =
  "This plan is no longer available — it was replaced by a newer set. Go back to pick another, or generate a new one.";
const SAVE_FAILED_COPY = "Couldn't save this plan.";
const ACTIVATE_FAILED_COPY = "Couldn't activate this plan.";
const ANOTHER_FAILED_COPY = "Kiwi got distracted. Try again?";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function parseJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseCandidates(raw: string | undefined): WizardPlanCandidate[] {
  const arr = parseJson<unknown>(raw);
  return Array.isArray(arr) ? (arr as WizardPlanCandidate[]) : [];
}

type GenerateInput = WizardPreferencesInput | TellKiwiInput;

// "Get another plan option" through the SAME progressive-render + fallback
// machinery the first batch uses, one impl pair per source: the wizard's real
// stream (+ buffered fallback); Tell Kiwi's buffered build-from-text adapted
// to the stream's callback shape (there is no text-mode stream).
const WIZARD_ANOTHER_DEPS: UseBuildWizardPlansStreamingDeps<GenerateInput> = {
  streamImpl: (input, onCandidate, opts) =>
    streamWizardPlans(input as WizardPreferencesInput, onCandidate, opts),
  bufferedImpl: (input, exclude) => buildWizardPlans(input as WizardPreferencesInput, exclude),
};
const TELLKIWI_ANOTHER_DEPS: UseBuildWizardPlansStreamingDeps<GenerateInput> = {
  streamImpl: async (input, onCandidate, opts) => {
    const result = await buildFromText(input as TellKiwiInput, opts.exclude);
    result.candidates.forEach((c, i) => onCandidate(i, c));
    return { cannotGenerateMore: result.cannotGenerateMore, reason: result.reason };
  },
  bufferedImpl: async (input, exclude) => {
    const result = await buildFromText(input as TellKiwiInput, exclude);
    return {
      candidates: result.candidates,
      cannotGenerateMore: result.cannotGenerateMore,
      reason: result.reason,
    };
  },
};

export default function PlanOptionsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const params = useLocalSearchParams<{
    source?: "tellkiwi";
    input?: string;
    tellKiwiResult?: string;
    tellKiwiInput?: string;
    rehydrate?: string;
    rehydratedCandidates?: string;
  }>();

  const wizardInput = useMemo(() => parseJson<WizardPreferencesInput>(params.input), [params.input]);
  const tellKiwiPayload = useMemo(
    () => parseJson<BuildFromTextResult>(params.tellKiwiResult),
    [params.tellKiwiResult],
  );
  const tellKiwiInput = useMemo(() => parseJson<TellKiwiInput>(params.tellKiwiInput), [params.tellKiwiInput]);
  const rehydrated = useMemo(() => parseCandidates(params.rehydratedCandidates), [params.rehydratedCandidates]);
  const isRehydrate = params.rehydrate === "1";
  const mode: PlanOptionsMode = isRehydrate ? "rehydrate" : tellKiwiPayload ? "tellkiwi" : "wizard";
  const source: PlanOptionsSource =
    params.source === "tellkiwi" || (!!tellKiwiInput && !wizardInput) ? "tellkiwi" : "wizard";
  const householdSize = wizardInput?.householdSize ?? tellKiwiInput?.householdSize ?? null;
  // The stored body an "another" call re-sends. Absent on a legacy rehydrate
  // row → the button does not render.
  const anotherBody: GenerateInput | null = source === "tellkiwi" ? tellKiwiInput : wizardInput;

  // ── the list ─────────────────────────────────────────────────────────────
  const [list, setList] = useState<PlanOptionList>(() =>
    mode === "tellkiwi"
      ? appendCandidates(EMPTY_PLAN_OPTIONS, tellKiwiPayload?.candidates ?? [])
      : mode === "rehydrate"
        ? appendCandidates(EMPTY_PLAN_OPTIONS, rehydrated)
        : EMPTY_PLAN_OPTIONS,
  );
  const [presses, setPresses] = useState(0);
  const lastDismissedIndexRef = useRef<number | null>(null);
  const [busyAction, setBusyAction] = useState<{ key: string; action: PlanOptionCardBusyAction } | null>(null);
  // Mirrors `list` for the async chains (a chain reads the list AFTER awaits).
  const listRef = useRef(list);
  listRef.current = list;

  // ── the cap ──────────────────────────────────────────────────────────────
  const limitsQuery = useQuery({
    queryKey: ["wizard", "limits"],
    queryFn: getWizardLimits,
    staleTime: 5 * 60 * 1000,
  });
  const cap = limitsQuery.data?.maxRefreshesPerSession ?? DEFAULT_MAX_PRESSES;
  const left = pressesLeft(cap, presses);

  const invalidateLastBatch = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["wizard", "lastBatch"] });
  }, [queryClient]);
  const invalidatePlans = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["plans"] });
    queryClient.invalidateQueries({ queryKey: ["home"] });
  }, [queryClient]);

  // ── the first batch (wizard mode) ────────────────────────────────────────
  const [attempt, setAttempt] = useState(0);
  const initial = useBuildWizardPlansStreaming({ onComplete: invalidateLastBatch });
  useEffect(() => {
    if (mode !== "wizard" || !wizardInput) return;
    initial.reset();
    initial.mutate(wizardInput, toExclusionRequest(EMPTY_SESSION_EXCLUSION));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.input, attempt, mode]);
  const initialCandidates = initial.data?.candidates;
  useEffect(() => {
    if (!initialCandidates || initialCandidates.length === 0) return;
    setList((prev) => appendCandidates(prev, initialCandidates));
  }, [initialCandidates]);
  // The first batch is COMPLETE (the button's gate): a stream that settled, a
  // pre-built or rehydrated set at mount.
  const firstBatchComplete = mode !== "wizard" || initial.isComplete;

  // ── "Get another plan option" ────────────────────────────────────────────
  const anotherDeps = source === "tellkiwi" ? TELLKIWI_ANOTHER_DEPS : WIZARD_ANOTHER_DEPS;
  const another = useBuildWizardPlansStreaming<GenerateInput>({
    ...anotherDeps,
    onComplete: invalidateLastBatch,
  });
  const [anotherBusy, setAnotherBusy] = useState(false);
  // Candidate ids already counted as a press — the stream re-delivers its cards
  // in the catch-up before `done`, which re-fires this effect with the same
  // card; insertAnother dedupes the list, this dedupes the count.
  const countedRef = useRef<Set<string>>(new Set());
  const anotherCandidates = another.data?.candidates;
  useEffect(() => {
    if (!anotherCandidates || anotherCandidates.length === 0) return;
    // ONE press = ONE plan: the first card of the response, whatever the server
    // sent (a pre-Block-1 server ignores the count and returns three).
    const fresh = anotherCandidates[0];
    if (countedRef.current.has(fresh.id)) return;
    countedRef.current.add(fresh.id);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const at = lastDismissedIndexRef.current;
    lastDismissedIndexRef.current = null;
    setList((prev) => insertAnother(prev, fresh, at));
    setPresses((n) => n + 1);
    setAnotherBusy(false);
  }, [anotherCandidates]);
  useEffect(() => {
    if (!another.isError) return;
    setAnotherBusy(false);
    showToast({ message: another.error?.message || ANOTHER_FAILED_COPY });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [another.isError]);
  // A run that settled with NO card (the server's cannotGenerateMore on an
  // exhausted constraint set) — release the button and say why; not a press.
  useEffect(() => {
    if (!another.isComplete || (anotherCandidates?.length ?? 0) > 0) return;
    setAnotherBusy(false);
    showToast({
      message:
        another.data?.reason || "Kiwi couldn't find another distinct plan for these constraints.",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [another.isComplete]);

  const handleAnother = () => {
    if (!anotherBody || anotherBusy || left <= 0 || anyBusy(list)) return;
    setAnotherBusy(true);
    another.reset();
    another.mutate(anotherBody, anotherRequestFor(list));
  };

  // ── Not For Me ───────────────────────────────────────────────────────────
  const handleNotForMe = (card: PlanOptionCardModel) => {
    if (anyBusy(list)) return;
    // Fire-and-forget: the row is for a future wizard; a failure never blocks.
    void dismissWizardCandidate(dismissRequestFor(card.candidate, source)).catch(() => {});
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const { list: next, dismissedIndex } = dismissCard(list, card.key);
    if (dismissedIndex !== null) lastDismissedIndexRef.current = dismissedIndex;
    setList(next);
  };

  // ── expand (shared by Use / Save) ────────────────────────────────────────
  // POST /wizard/expand with the WIRE candidate (meals sent back as received)
  // → the draft id, remembered on the card so a retry skips the call (the
  // server's expand is idempotent by content hash anyway).
  const expandFor = async (card: PlanOptionCardModel, signal: AbortSignal): Promise<string> => {
    if (card.draftId) return card.draftId;
    const result = await expandWizardCandidate(
      {
        candidate: card.candidate,
        candidateContext: buildCandidateContext(card.candidate, wizardInput, tellKiwiInput),
      },
      { signal },
    );
    setList((prev) => patchCard(prev, card.key, { draftId: result.draft.id }));
    return result.draft.id;
  };

  const setBusy = (card: PlanOptionCardModel, action: PlanOptionCardBusyAction) => {
    setBusyAction({ key: card.key, action });
    setList((prev) => patchCard(prev, card.key, { state: "busy" }));
  };
  const restore = (card: PlanOptionCardModel, state: PlanOptionCardModel["state"]) => {
    setBusyAction(null);
    setList((prev) => patchCard(prev, card.key, { state }));
  };

  // ── Save for Later ───────────────────────────────────────────────────────
  const handleSaveForLater = async (card: PlanOptionCardModel) => {
    if (anyBusy(list) || card.state !== "fresh") return;
    setBusy(card, "save");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHAIN_CLIENT_TIMEOUT_MS);
    try {
      const draftId = await expandFor(card, controller.signal);
      const result = await saveWizardDraft(draftId);
      invalidatePlans();
      setBusyAction(null);
      setList((prev) =>
        patchCard(prev, card.key, { state: "saved", planId: result.instance.id, draftId }),
      );
    } catch (err) {
      restore(card, "fresh");
      if (err instanceof ApiError && err.status === 409) {
        setList((prev) => patchCard(prev, card.key, { draftId: undefined }));
        showToast({ message: DRAFT_ARCHIVED_COPY });
        return;
      }
      showToast({
        message: controller.signal.aborted
          ? STILL_WORKING_COPY
          : err instanceof Error && err.message
            ? err.message
            : SAVE_FAILED_COPY,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // ── Use This Week ────────────────────────────────────────────────────────
  // The choice is made (D-WS9-191 §4.2): land on the EXISTING Plan Review with
  // Back going to the Plans tab, not here. dismissAll pops the wizard modal +
  // this screen; the replace makes the Plans tab the base; the push puts the
  // plan on top of it.
  const routeToPlanReview = (planId: string) => {
    router.dismissAll();
    router.replace("/(tabs)/plans");
    router.push({ pathname: "/plan/[id]", params: { id: planId } });
  };

  const handleUseThisWeek = async (card: PlanOptionCardModel) => {
    if (anyBusy(list) || card.state === "busy" || card.state === "dismissed") return;
    const prior = card.state;
    setBusy(card, "use");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHAIN_CLIENT_TIMEOUT_MS);
    // Plan Review's decider: pre-save → the draft-activate endpoint; after a
    // save the draft id is dead and activation is PATCH /plans/:planId.
    const target = decidePlanDetailsCta(card.planId ?? null).useTarget;
    try {
      let planId: string;
      let demoted: { id: string; name: string } | null | undefined;
      if (target.kind === "patch-plan") {
        const result = await patchPlan(target.planId, { isActiveThisWeek: true });
        planId = target.planId;
        demoted = result.demoted;
      } else {
        const draftId = await expandFor(card, controller.signal);
        const result = await activateWizardDraft(draftId, { signal: controller.signal });
        planId = result.instance.id;
        demoted = result.demoted;
      }
      invalidatePlans();
      const msg = demotionToastMessage(card.candidate.title, demoted);
      if (msg) showToast({ message: msg });
      routeToPlanReview(planId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        restore(card, prior);
        setList((prev) => patchCard(prev, card.key, { draftId: undefined }));
        showToast({ message: DRAFT_ARCHIVED_COPY });
        return;
      }
      // D-WS7-080 — a dropped 201 already consumed the draft; the plan is safe.
      // Find it rather than showing red.
      if (target.kind === "draft-activate" && err instanceof ApiError && err.status === 404) {
        try {
          const route = await resolveActivatedPlanRouteAfter404(getPlans);
          invalidatePlans();
          if (route.kind === "plan") routeToPlanReview(route.planId);
          else {
            router.dismissAll();
            router.replace("/(tabs)/plans");
          }
          return;
        } catch {
          // fall through to the toast
        }
      }
      restore(card, prior);
      showToast({
        message: controller.signal.aborted
          ? STILL_WORKING_COPY
          : err instanceof Error && err.message
            ? err.message
            : ACTIVATE_FAILED_COPY,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // ── render ───────────────────────────────────────────────────────────────
  const visible = visibleCards(list);
  const scenario = tellKiwiPayload?.parsedIntent.scenario ?? null;
  const subline = sublineFor(mode, visible.length, scenario);
  const notice = noticeFor({
    scenario,
    overflowMeals: tellKiwiPayload?.needsClarification?.options ?? null,
    cannotGenerateMore:
      mode === "tellkiwi" ? tellKiwiPayload?.cannotGenerateMore : initial.data?.cannotGenerateMore,
    reason: mode === "tellkiwi" ? tellKiwiPayload?.reason : initial.data?.reason,
  });
  const showSkeleton = mode === "wizard" && initial.isPending;
  const showError = mode === "wizard" && initial.isError;
  const busy = anyBusy(list);
  const canAskForAnother = !!anotherBody && firstBatchComplete && !showError;

  // No usable payload — misrouted (no input, no pre-built result, no stored
  // batch). Recoverable: back to the wizard.
  if (mode === "wizard" && !wizardInput) {
    return (
      <View style={s.screen}>
        <Header showBack onBack={() => router.back()} title={PLAN_OPTIONS_TITLE} />
        <View style={s.body}>
          <View style={s.statusCard}>
            <Text style={s.statusTitle}>Kiwi got distracted. Try again?</Text>
            <Text style={s.statusBody}>
              Plan input wasn&apos;t passed through. Head back to the wizard and resubmit.
            </Text>
            <Button label="Back to wizard" variant="primary" onPress={() => router.back()} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <Header showBack onBack={() => router.back()} title={PLAN_OPTIONS_TITLE} subtitle={subline} />
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {notice ? <Text style={s.notice}>{notice}</Text> : null}

        <View style={s.list}>
          {visible.map((card) => (
            <PlanOptionCard
              key={card.key}
              candidate={card.candidate}
              state={card.state === "dismissed" ? "fresh" : card.state}
              busyAction={busyAction?.key === card.key ? busyAction.action : null}
              disabled={busy && busyAction?.key !== card.key}
              householdSize={householdSize}
              onUseThisWeek={() => void handleUseThisWeek(card)}
              onSaveForLater={() => void handleSaveForLater(card)}
              onNotForMe={() => handleNotForMe(card)}
            />
          ))}
          {(showSkeleton || anotherBusy) && <PlanOptionCardSkeleton />}
        </View>

        {showError && (
          <View style={s.statusCard}>
            <Text style={s.statusTitle}>Kiwi got distracted. Try again?</Text>
            {initial.error?.message ? <Text style={s.statusBody}>{initial.error.message}</Text> : null}
            <Button label="Try again" variant="primary" onPress={() => setAttempt((n) => n + 1)} />
          </View>
        )}

        {canAskForAnother &&
          (left > 0 ? (
            <View style={s.anotherWrap}>
              <Button
                label={ANOTHER_LABEL}
                variant="tint"
                onPress={handleAnother}
                disabled={anotherBusy || busy}
                testID="plan-options-another"
              />
            </View>
          ) : (
            <ExhaustedCard title={EXHAUSTED_PLANS_TITLE} />
          ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.neutral[100],
  },
  body: {
    padding: Spacing[4],
  },
  scroll: {
    padding: Spacing[4],
    paddingBottom: Spacing[8],
    gap: Spacing[3],
  },
  list: {
    gap: Spacing[3],
  },
  notice: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[400],
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    padding: Spacing[3],
  },
  anotherWrap: {
    marginTop: Spacing[1],
  },
  statusCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[3],
  },
  statusTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  statusBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
});
