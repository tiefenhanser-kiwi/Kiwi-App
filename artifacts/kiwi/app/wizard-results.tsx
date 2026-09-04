import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { DisplayTitle } from "@/components/DisplayTitle";
import { Header } from "@/components/Header";
import { LoadingShim } from "@/components/LoadingShim";
import { Screen } from "@/components/Screen";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
// Latency Block (D-WS9-076) — streaming hook replaces the buffered
// useBuildWizardPlans on the Set-Preferences path. Same mutation-shaped surface
// (mutate/reset/data/isPending/isSuccess/isError), but data.candidates GROWS as
// the SSE stream lands each card, so the gates below render progressively. It
// falls back to the buffered endpoint on any stream failure (worst case =
// today). Tell-Kiwi + Surprise-me stay buffered (separate flows).
import { useBuildWizardPlansStreaming } from "@/hooks/useBuildWizardPlansStreaming";
import { useBuildSurprise } from "@/hooks/useBuildSurprise";
import {
  expandWizardCandidate,
  type WizardExpandCandidateContext,
  type WizardExpandResponse,
} from "@/lib/api/wizard";
import { buildOpenDraftParams } from "@/lib/wizard/openDraftPlanRoute";
import {
  accumulateShownPlans,
  EMPTY_SESSION_EXCLUSION,
  toExclusionRequest,
} from "@/lib/wizard/sessionExclusion";
import { getPreferences, type UserPreferences } from "@/lib/api/me";
import type {
  BuildFromTextResult,
  ParsedIntent,
} from "@/lib/api/tellKiwi";
import { formatMacro } from "@/lib/format/macros";
import type { TellKiwiInput, WizardPlanCandidate, WizardPreferencesInput } from "@/lib/types";

// WS9 3c (D-WS9-032) — client-side ceiling for the expand call that opens a
// candidate as a draft. Expand is ~10-15s typical; 90s sits well past that so a
// real success is never read as a timeout, while a true hang still surfaces via
// the §5.4 error surface. The Cancel button also aborts this controller.
const EXPAND_CLIENT_TIMEOUT_MS = 90_000;

// Synthesize a TellKiwiInput-shaped constraint slice from stored preferences so
// the Surprise-me path can build the same expand candidateContext the Tell Kiwi
// path does — allergies/eating-styles MUST reach expand so ingredient authoring
// stays inside the user's hard constraints (the "surprise" is meal choice only).
function tellKiwiInputFromPrefs(prefs: UserPreferences): TellKiwiInput {
  return {
    description: "",
    planDurationDays: prefs.planLengthDefault,
    householdSize: prefs.householdSize,
    cuisines: prefs.cuisines,
    weeklyPacing: prefs.weeklyPacingDefault ?? "mostly_easy",
    eatingStyles: prefs.eatingStyles,
    allergiesAndAvoidances: prefs.allergiesAndAvoidances,
    dietaryNotes: prefs.dietaryNotes ?? undefined,
    discoveryMealsPerWeek: prefs.discoveryMealsPerWeek,
    saucePreference: prefs.saucePreference,
    maxCookTimeMinutes: prefs.maxCookTimeMinutes,
    maxCookTimeCoverage: prefs.maxCookTimeCoverage,
  };
}

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function parseInput(raw: string | undefined): WizardPreferencesInput | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WizardPreferencesInput;
  } catch {
    return null;
  }
}

// Block 4b-3 (D-WS9-072) — "See Previous Options" rehydrate. The link passes the
// stored batch's candidates as a JSON param so this screen renders them directly,
// skipping the generate mutation entirely (no AI call).
function parseCandidates(
  raw: string | undefined,
): WizardPlanCandidate[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as WizardPlanCandidate[]) : null;
  } catch {
    return null;
  }
}

function parseTellKiwiResult(
  raw: string | undefined,
): BuildFromTextResult | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BuildFromTextResult;
  } catch {
    return null;
  }
}

// WS7-5b-mobile Block A — Tell Kiwi flow plumbs its form input through
// wizard-results so candidateContext can be built for the expand call. The
// Set-Prefs flow already carries WizardPreferencesInput in `input`; Tell Kiwi
// pushes TellKiwiInput in `tellKiwiInput`. Both shapes contribute the same
// subset of fields to candidateContext below.
function parseTellKiwiInput(raw: string | undefined): TellKiwiInput | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TellKiwiInput;
  } catch {
    return null;
  }
}

// Build the WizardExpandCandidateContext from whichever entry point's input
// is available. Set Prefs carries all six fields directly. Tell Kiwi has no
// `difficulty` (free-text scenario), so we default to "medium" — the AI
// expand prompt uses difficulty as a soft hint, and the candidates were
// already generated with the user's actual constraints, so a default
// difficulty here is a low-risk choice. planDurationDays falls back to the
// mealTitles length so multi-day Tell Kiwi plans expand cleanly.
function buildCandidateContext(
  candidate: WizardPlanCandidate,
  wizardInput: WizardPreferencesInput | null,
  tellKiwiInput: TellKiwiInput | null,
): WizardExpandCandidateContext {
  if (wizardInput) {
    return {
      planDurationDays: wizardInput.planDurationDays,
      householdSize: wizardInput.householdSize,
      // wantsLeftovers removed from the wizard payload (Block 4 / D-WS7-190);
      // the field is inert server-side (@default(false)) but the expand schema
      // still expects a boolean, so send the inert value.
      wantsLeftovers: false,
      allergiesAndAvoidances: wizardInput.allergiesAndAvoidances,
      eatingStyles: wizardInput.eatingStyles,
      difficulty: wizardInput.difficulty,
      // Block 4 — carry the per-run sauce + cook-time overrides to expand so a
      // per-plan cook cap survives into ingredient authoring (D-WS7-035).
      saucePreference: wizardInput.saucePreference,
      maxCookTimeMinutes: wizardInput.maxCookTimeMinutes,
      maxCookTimeCoverage: wizardInput.maxCookTimeCoverage,
    };
  }
  if (tellKiwiInput) {
    return {
      // Block 5 — honor the user's per-run plan length when set; fall back to
      // the candidate's meal count for legacy payloads that omit it.
      planDurationDays:
        tellKiwiInput.planDurationDays ??
        Math.max(1, Math.min(7, candidate.mealTitles.length || 5)),
      householdSize: tellKiwiInput.householdSize,
      wantsLeftovers: false,
      allergiesAndAvoidances: tellKiwiInput.allergiesAndAvoidances,
      eatingStyles: tellKiwiInput.eatingStyles,
      difficulty: "medium",
      saucePreference: tellKiwiInput.saucePreference,
      maxCookTimeMinutes: tellKiwiInput.maxCookTimeMinutes,
      maxCookTimeCoverage: tellKiwiInput.maxCookTimeCoverage,
    };
  }
  // No input at all — should not happen given the entry-point guard above,
  // but supply a safe default rather than throwing inside a tap handler.
  //
  // ⚠️ WS9 BUG-201 — allergiesAndAvoidances / eatingStyles ARE OMITTED HERE,
  // NOT SENT EMPTY. This branch fires when the screen has NO input at all, so
  // by construction it knows nothing about the user's constraints — and `[]`
  // is an assertion that they have none. That assertion reaches the expand
  // prompt, which is where ingredients are authored: the safest-looking literal
  // in the file was the one that could put an allergen on a plate. Omitting
  // makes the server resolve from stored, which is the only honest answer a
  // no-input fallback can give.
  return {
    planDurationDays: Math.max(1, Math.min(7, candidate.mealTitles.length || 5)),
    householdSize: 4,
    wantsLeftovers: false,
    difficulty: "medium",
  };
}

// PRD §5.4 (Hans's redline) — "Kiwi is being thorough…" appears after 30s.
const EXPAND_THOROUGH_THRESHOLD_SEC = 30;

// PRD §5.4 — copy verbatim. "Kiwi is thinking…" / "10-15s" / cancel returns to
// results. The §5.4 spec's "Back to inputs" was retargeted by Hans to "Back
// to results" — the user came from the cards, so back-from-expand returns
// to the cards, not the input form.
//
// WS9 3c (D-WS9-032) — the card no longer commits. One state machine now drives
// a single action: EXPAND the picked candidate, then open the SHARED Plan
// Review screen as an unsaved draft (the save/activate decision moves there,
// onto its action bar). Tapping a card = one wait, then Plan Review; the commit
// primary and the "View details" peek are both gone. Surprise-me reuses the
// same expand → draft path (its auto-expand skips the card picker).
type ChainState =
  | { kind: "idle" }
  | {
      kind: "pending";
      candidateId: string;
      controller: AbortController;
      elapsedSec: number;
    }
  | {
      kind: "error";
      candidate: WizardPlanCandidate;
      message: string;
    };

export default function WizardResultsScreen() {
  const router = useRouter();
  // Two entry points:
  //   - Set Preferences wizard → passes `input` (WizardPreferencesInput JSON);
  //     this screen fires the build-plans mutation and renders 3 candidates.
  //   - Tell Kiwi → passes `tellKiwiResult` (already-built BuildFromTextResult
  //     JSON); the AI ran on the previous screen (tellkiwi.tsx). This screen
  //     just renders the result, branching by parsedIntent.scenario.
  const queryClient = useQueryClient();
  const { source, input, tellKiwiResult, tellKiwiInput, rehydrate, rehydratedCandidates } =
    useLocalSearchParams<{
      source?: "tellkiwi" | "surprise";
      input?: string;
      tellKiwiResult?: string;
      tellKiwiInput?: string;
      // Block 4b-3 (D-WS9-072) — rehydrate mode. `rehydrate:"1"` + the stored
      // candidates JSON re-shows a prior batch with no generate call.
      rehydrate?: string;
      rehydratedCandidates?: string;
    }>();
  // Block 4b-3 — when rehydrating a stored batch, render its candidates directly
  // and suppress every mount-time generation effect below.
  const isRehydrate = rehydrate === "1";
  const rehydratedCands = useMemo(
    () => parseCandidates(rehydratedCandidates),
    [rehydratedCandidates],
  );
  const wizardInput = useMemo(() => parseInput(input), [input]);
  const tellKiwiPayload = useMemo(
    () => parseTellKiwiResult(tellKiwiResult),
    [tellKiwiResult],
  );
  const tellKiwiInputParsed = useMemo(
    () => parseTellKiwiInput(tellKiwiInput),
    [tellKiwiInput],
  );

  // WS9 3c 7.6 — Surprise-me: a third entry mode. Zero user input; the server
  // reads stored prefs and generates crowd-pleaser candidates. We fire the
  // mutation on mount (mirroring the wizard build-plans path) and render the
  // same candidate cards. Stored prefs are also read here so the expand
  // candidateContext keeps allergies/eating-styles as hard constraints.
  const isSurprise = source === "surprise" && !tellKiwiPayload && !wizardInput;
  const surpriseMutation = useBuildSurprise();
  const prefsQuery = useQuery<UserPreferences>({
    queryKey: ["me", "preferences"],
    queryFn: getPreferences,
    enabled: isSurprise,
  });

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // `attempt` ticks once per regen request so the effect re-fires even when
  // `input` is identical (re-entering the wizard with unchanged prefs would
  // otherwise leave React Query showing the previous mount's data).
  const [attempt, setAttempt] = useState(0);
  const mutation = useBuildWizardPlansStreaming({
    // BUG-051 fix — invalidate the "See Previous Options" cache only when the
    // stream TRULY completes (server has written its last-batch row), NOT on
    // isSuccess (which flips at the first streamed card, before the write).
    // See the effect below for the surprise (buffered) path, whose isSuccess is
    // already correctly timed. The ["wizard","drafts"] key is no longer
    // invalidated here — its sole observer (wizard.tsx's draftsQuery) was
    // removed with the resume interstitial (WS9 3c), so it has no observers.
    onComplete: () => {
      queryClient.invalidateQueries({ queryKey: ["wizard", "lastBatch"] });
    },
  });

  // BUG-053 (Parts B + F) — every plan shown in THIS session, so a re-roll can
  // exclude them. Accumulated from the arriving candidates (below), NOT from
  // `attempt` (which bumps before the new data lands). Sent on each generation.
  const [sessionExclusion, setSessionExclusion] = useState(
    EMPTY_SESSION_EXCLUSION,
  );

  useEffect(() => {
    // Block 4b-3 — rehydrate re-shows a stored batch; never generate.
    if (isRehydrate) return;
    // Tell Kiwi preloads its result via params; never re-fire the wizard
    // mutation in that case, which would clobber the candidates with an
    // unrelated set from a different prompt. Surprise-me fires its own
    // mutation below, not the build-plans one.
    if (tellKiwiPayload || isSurprise) return;
    if (!wizardInput) return;
    mutation.reset();
    // Part F — exclude the plans shown so far this session from the re-roll.
    mutation.mutate(wizardInput, toExclusionRequest(sessionExclusion));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, attempt, tellKiwiPayload]);

  useEffect(() => {
    // Surprise-me generation (no input). `attempt` re-fires it for the
    // "Surprise me again" re-roll, same as the wizard path's More-options.
    if (isRehydrate) return; // Block 4b-3 — rehydrate never generates.
    if (!isSurprise) return;
    surpriseMutation.reset();
    // Part B — exclude the plans shown so far this session from the re-roll.
    surpriseMutation.mutate(toExclusionRequest(sessionExclusion));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSurprise, attempt]);

  // Fold each shown generation into the session exclusion. Keyed on the
  // arriving data (deduped by plan title in accumulateShownPlans), so the
  // reset()→undefined→new-data cycle of a re-roll accumulates the NEW plan
  // once and never re-counts the stale one. Same-ref-on-no-change keeps this
  // from looping. Takes ALL candidates (surprise: 1, standard wizard: 3).
  const shownCandidates = isSurprise
    ? surpriseMutation.data?.candidates
    : mutation.data?.candidates;
  useEffect(() => {
    if (!shownCandidates || shownCandidates.length === 0) return;
    setSessionExclusion((prev) =>
      accumulateShownPlans(
        prev,
        shownCandidates.map((c) => ({
          title: c.title,
          mealTitles: c.mealTitles,
        })),
      ),
    );
  }, [shownCandidates]);

  // Block 4b-3 (D-WS9-072) — a successful generation overwrote the server
  // last-batch row, so the "See Previous Options" cache must be invalidated to
  // reflect the new run. The STREAMING (Set-Prefs) path invalidates via the
  // hook's onComplete above (BUG-051 — its isSuccess flips at the first card,
  // before the server write). This effect handles the SURPRISE path only: it's
  // buffered, so surpriseMutation.isSuccess fires after the server responds
  // (post-write), making it correctly timed. Once per attempt; never on
  // rehydrate. Tell Kiwi generates on its own screen and invalidates there.
  const invalidatedAttemptRef = useRef(-1);
  useEffect(() => {
    if (isRehydrate) return;
    const generated =
      surpriseMutation.isSuccess &&
      (surpriseMutation.data?.candidates?.length ?? 0) > 0;
    if (generated && invalidatedAttemptRef.current !== attempt) {
      invalidatedAttemptRef.current = attempt;
      queryClient.invalidateQueries({ queryKey: ["wizard", "lastBatch"] });
    }
  }, [
    isRehydrate,
    attempt,
    surpriseMutation.isSuccess,
    surpriseMutation.data,
    queryClient,
  ]);

  // For Surprise-me, synthesize the constraint slice the expand step needs
  // (allergies/eating-styles/household) from stored prefs — the candidate was
  // generated within constraints, but ingredient authoring at expand must be
  // too. Falls back to null until prefs load (buildCandidateContext then uses
  // its own safe default).
  const effectiveTellKiwiInput: TellKiwiInput | null = isSurprise
    ? prefsQuery.data
      ? tellKiwiInputFromPrefs(prefsQuery.data)
      : null
    : tellKiwiInputParsed;

  const parsedIntent: ParsedIntent | null =
    tellKiwiPayload?.parsedIntent ?? surpriseMutation.data?.parsedIntent ?? null;

  const subtitleForScenario = (scenario: ParsedIntent["scenario"]): string => {
    switch (scenario) {
      case "fully_specified":
        return "Here's your plan — exactly as you described";
      case "overflow":
        return "Here's a 5-night plan from your list";
      case "partial":
        return "3 plans built around what you named";
      default:
        return "3 plans Kiwi built from your request";
    }
  };

  const subtitle = isRehydrate
    ? "Your previous options"
    : isSurprise
    ? "3 crowd-pleasers Kiwi picked for you"
    : tellKiwiPayload && parsedIntent
    ? subtitleForScenario(parsedIntent.scenario)
    : source === "tellkiwi"
    ? "3 plans Kiwi built from your request"
    : "3 plans Kiwi cooked up just for you";

  const candidates: WizardPlanCandidate[] = isRehydrate
    ? rehydratedCands ?? []
    : tellKiwiPayload
    ? tellKiwiPayload.candidates
    : isSurprise
    ? surpriseMutation.data?.candidates ?? []
    : mutation.data?.candidates ?? [];

  const cannotGenerateMore = tellKiwiPayload
    ? tellKiwiPayload.cannotGenerateMore
    : isSurprise
    ? surpriseMutation.data?.cannotGenerateMore
    : mutation.data?.cannotGenerateMore;
  const cannotGenerateMoreReason = tellKiwiPayload
    ? tellKiwiPayload.reason
    : isSurprise
    ? surpriseMutation.data?.reason
    : mutation.data?.reason;

  const toggleExpanded = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRefine = () => {
    router.back();
  };

  const handleMoreOptions = () => {
    // Tell Kiwi: there's no re-roll on this screen — refining the wording
    // happens back on tellkiwi.tsx (the prompt determines the scenario).
    if (tellKiwiPayload) {
      router.back();
      return;
    }
    // Surprise-me and the wizard path both re-roll by bumping `attempt`; the
    // mount effects handle reset+mutate so navigation- and button-driven
    // re-rolls share one code path.
    if (!isSurprise && !wizardInput) return;
    setExpandedIds(new Set());
    setAttempt((n) => n + 1);
  };

  const handleHeaderBack = () => {
    router.replace("/(tabs)");
  };

  // ── WS9 3c (D-WS9-032) — expand → open Plan Review as an unsaved draft ──
  // Tapping a card expands the picked candidate (POST /wizard/expand → a hidden
  // draft + the expanded payload) and pushes the SHARED Plan Review screen in
  // draft mode. NO activation here — the save/activate decision lives on Plan
  // Review's action bar now. `router.push` (not replace) keeps this results
  // screen in the stack, so Back from Plan Review returns to the 3 candidates
  // (point 5). One §5.4 loading/error surface, one action.
  const [chainState, setChainState] = useState<ChainState>({ kind: "idle" });
  // Distinguishes a user Cancel (silent — returns to cards) from the client
  // timeout (informative "still working" copy). Both abort the same controller,
  // so the catch can't tell them apart without this flag.
  const userCancelledRef = useRef(false);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drive the §5.4 "Kiwi is being thorough…" 30s threshold by ticking
  // `elapsedSec` once a second while pending. Clears on success/error/cancel.
  useEffect(() => {
    if (chainState.kind !== "pending") {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      return;
    }
    const startedAt = Date.now();
    elapsedTimerRef.current = setInterval(() => {
      setChainState((prev) => {
        if (prev.kind !== "pending") return prev;
        return {
          ...prev,
          elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
        };
      });
    }, 1000);
    return () => {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    };
  }, [chainState.kind]);

  const runOpenDraft = async (candidate: WizardPlanCandidate) => {
    // Already running — ignore. The §5.4 overlay blocks the cards anyway, but
    // the guard makes the intent explicit.
    if (chainState.kind === "pending") return;
    userCancelledRef.current = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      EXPAND_CLIENT_TIMEOUT_MS,
    );
    setChainState({
      kind: "pending",
      candidateId: candidate.id,
      controller,
      elapsedSec: 0,
    });

    const candidateContext = buildCandidateContext(
      candidate,
      wizardInput,
      effectiveTellKiwiInput,
    );

    try {
      const expandResult: WizardExpandResponse = await expandWizardCandidate(
        { candidate, candidateContext },
        { signal: controller.signal },
      );
      setChainState({ kind: "idle" });
      // Open the SHARED Plan Review screen in draft mode. `id: "draft"` is a
      // placeholder path segment (draft mode branches on draftId, never fetches
      // it); the real plan id is minted only when the user commits on Plan
      // Review. `push` keeps this results screen below in the stack so Back
      // returns to the candidates (point 5).
      router.push({
        pathname: "/plan/[id]",
        params: buildOpenDraftParams(expandResult),
      });
    } catch (err) {
      // A user Cancel already flipped state to idle — don't clobber it.
      if (userCancelledRef.current) {
        userCancelledRef.current = false;
        return;
      }
      const message = controller.signal.aborted
        ? "Kiwi is still working on it. Try again in a moment."
        : err instanceof Error && err.message
          ? err.message
          : "Something went wrong.";
      setChainState({ kind: "error", candidate, message });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleOpenDraft = (candidate: WizardPlanCandidate) => {
    void runOpenDraft(candidate);
  };

  const handleChainCancel = () => {
    if (chainState.kind !== "pending") return;
    userCancelledRef.current = true;
    chainState.controller.abort();
    setChainState({ kind: "idle" });
  };

  const handleChainRetry = () => {
    if (chainState.kind !== "error") return;
    void runOpenDraft(chainState.candidate);
  };

  const handleChainBackToResults = () => {
    setChainState({ kind: "idle" });
  };

  // WS9 3c follow-up (Part A / surprise A′) — Surprise-me NO LONGER auto-expands.
  // It generates and lands on the single surprise card with details expanded by
  // default; expand fires only when the user taps "See full plan & save". This
  // deletes the effect that raced the generation on a re-roll (BUG-053): the
  // effect re-armed on `attempt` and fired an expand on the STALE candidate as
  // "Surprise Me again" kicked off a new generation. With no auto-expand, a
  // re-roll is a generation only — the concurrent expand is gone by construction.

  // ── render branches ──────────────────────────────────────────────────

  // No usable payload — entry-point misrouted (no input AND no preloaded
  // Tell Kiwi result). Surface a recoverable error. BUG-036 — the surprise
  // path carries neither `wizardInput` nor `tellKiwiPayload` (it generates on
  // mount from stored prefs), so it MUST be exempted here or this guard fires
  // on first render and sends every surprise run to the error screen.
  if (!isRehydrate && !wizardInput && !tellKiwiPayload && !isSurprise) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack onBack={handleHeaderBack} title="Plan options" />
        <Screen>
          <View style={s.statusBox}>
            <Text style={s.errorTitle}>Kiwi got distracted. Try again?</Text>
            <Text style={s.errorBody}>
              Plan input wasn&apos;t passed through. Head back to the wizard
              and resubmit.
            </Text>
            <View style={{ marginTop: Spacing[3] }}>
              <Button
                label="Back to wizard"
                variant="primary"
                onPress={handleRefine}
              />
            </View>
          </View>
        </Screen>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header
        showBack
        onBack={handleHeaderBack}
        title="Plan options"
        subtitle={subtitle}
      />
      <Screen>
        {/* Surprise A′ (Part A) — "Surprise Me again" sits at the TOP: one tap,
            no expand, straight to a new generation (the reject path costs
            nothing). Not shown on a rehydrated snapshot (a recall, not a run). */}
        {isSurprise && !isRehydrate ? (
          <View style={s.actionRow}>
            <View style={{ flex: 1 }}>
              <Button
                label="Surprise Me again ↺"
                variant="primary"
                onPress={handleMoreOptions}
                disabled={surpriseMutation.isPending}
              />
            </View>
          </View>
        ) : (
          <View style={s.actionRow}>
            <View style={{ flex: 1 }}>
              <Button
                label={tellKiwiPayload ? "Edit my message" : "Refine preferences"}
                variant="ghost"
                onPress={handleRefine}
              />
            </View>
            {/* For Tell Kiwi, "More options" returns to the form (the wording
                determines the scenario — re-rolling here would just call the
                same prompts and likely produce the same plan). For the wizard
                path it triggers a fresh AI call. */}
            {/* Block 4b-3 — no re-roll on a rehydrated snapshot. */}
            {!tellKiwiPayload && !isRehydrate && (
              <View style={{ flex: 1 }}>
                <Button
                  label="More options ↺"
                  variant="primary"
                  onPress={handleMoreOptions}
                  disabled={mutation.isPending}
                />
              </View>
            )}
          </View>
        )}

        {!tellKiwiPayload && !isSurprise && mutation.isPending && (
          <LoadingShim variant="status-box" />
        )}

        {isSurprise && surpriseMutation.isPending && (
          <LoadingShim
            variant="status-box"
            label="Kiwi is dreaming up crowd-pleasers…"
          />
        )}

        {!tellKiwiPayload && !isSurprise && !mutation.isPending && mutation.isError && (
          <View style={s.statusBox}>
            <Text style={s.errorTitle}>Kiwi got distracted. Try again?</Text>
            {mutation.error?.message ? (
              <Text style={s.errorBody}>{mutation.error.message}</Text>
            ) : null}
            <View style={{ marginTop: Spacing[3] }}>
              <Button
                label="Try again"
                variant="primary"
                onPress={handleMoreOptions}
              />
            </View>
          </View>
        )}

        {isSurprise && !surpriseMutation.isPending && surpriseMutation.isError && (
          <View style={s.statusBox}>
            <Text style={s.errorTitle}>Kiwi got distracted. Try again?</Text>
            {surpriseMutation.error?.message ? (
              <Text style={s.errorBody}>{surpriseMutation.error.message}</Text>
            ) : null}
            <View style={{ marginTop: Spacing[3] }}>
              <Button
                label="Surprise me again"
                variant="primary"
                onPress={handleMoreOptions}
              />
            </View>
          </View>
        )}

        {/* Scenario-aware notice. fully_specified gets a friendly confirmation;
            overflow surfaces the dropped meals; cannotGenerateMore (e.g.
            tight constraints from Set Prefs) gets the constraint-explanation. */}
        {parsedIntent?.scenario === "fully_specified" && (
          <View style={s.noticeBox}>
            <Text style={s.noticeText}>
              Here&apos;s your plan — exactly as you described.
            </Text>
          </View>
        )}

        {parsedIntent?.scenario === "overflow" &&
          (tellKiwiPayload?.needsClarification?.options?.length ?? 0) > 0 && (
            <View style={s.overflowBox}>
              <Text style={s.overflowTitle}>
                Couldn&apos;t fit them all in 5 nights
              </Text>
              <Text style={s.overflowBody}>
                Pick a meal below to swap into the plan (coming soon — for now,
                just letting you know what didn&apos;t make it).
              </Text>
              <View style={s.overflowChipRow}>
                {tellKiwiPayload?.needsClarification?.options?.map((meal) => (
                  <View key={meal} style={s.overflowChip}>
                    <Text style={s.overflowChipText}>{meal}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

        {!tellKiwiPayload &&
          !mutation.isPending &&
          mutation.isSuccess &&
          cannotGenerateMore && (
            <View style={s.noticeBox}>
              <Text style={s.noticeText}>
                {cannotGenerateMoreReason ??
                  "Kiwi couldn't produce 3 distinct plans for these constraints."}
              </Text>
            </View>
          )}

        {(isRehydrate ||
          tellKiwiPayload ||
          (isSurprise && surpriseMutation.isSuccess) ||
          (!isSurprise && !mutation.isPending && mutation.isSuccess)) && (
          <View style={s.candidatesWrap}>
            {candidates.map((c) => (
              <CandidateCard
                key={c.id}
                candidate={c}
                expanded={expandedIds.has(c.id)}
                onToggleExpanded={() => toggleExpanded(c.id)}
                onOpenDraft={() => handleOpenDraft(c)}
                // Surprise: keep the commit button disabled until stored prefs
                // load, so expand's candidateContext carries the user's hard
                // constraints (allergies / eating styles) — the guard the old
                // auto-expand effect enforced with `if (!prefsQuery.data)`.
                disabled={
                  chainState.kind === "pending" ||
                  (isSurprise && !prefsQuery.data)
                }
                // Surprise A′ (Part A) — one card, expanded by default, commit
                // via an explicit button (no whole-card tap).
                forceExpanded={isSurprise}
                explicitButton={isSurprise}
              />
            ))}
          </View>
        )}
      </Screen>

      {/* PRD §5.4 — full-screen modal-style overlay for the expand call.
          Mounted at the screen level (sits above the cards) so the Cancel
          / Try again / Back to results buttons aren't competing with the
          page's existing action row. Copy is locked verbatim. */}
      {chainState.kind === "pending" && (
        <View style={s.expandOverlay}>
          <View style={s.expandPanel}>
            <ActivityIndicator size="large" color={Colors.sage[700]} />
            <Text style={s.expandTitle}>Kiwi is thinking…</Text>
            <Text style={s.expandBody}>
              Building your plan — this usually takes about 10-15 seconds
            </Text>
            {chainState.elapsedSec >= EXPAND_THOROUGH_THRESHOLD_SEC && (
              <Text style={s.expandBodyEmphasis}>
                Kiwi is being thorough — almost there…
              </Text>
            )}
            <View style={s.expandCancelWrap}>
              <Button
                label="Cancel"
                variant="ghost"
                onPress={handleChainCancel}
              />
            </View>
          </View>
        </View>
      )}

      {chainState.kind === "error" && (
        <View style={s.expandOverlay}>
          <View style={s.expandPanel}>
            <Text style={s.expandTitle}>
              Kiwi got distracted. Want to try again?
            </Text>
            {chainState.message ? (
              <Text style={s.expandBody}>{chainState.message}</Text>
            ) : null}
            <View style={s.expandErrorRow}>
              <View style={{ flex: 1 }}>
                <Button
                  label="Try again"
                  variant="primary"
                  onPress={handleChainRetry}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="Back to results"
                  variant="ghost"
                  onPress={handleChainBackToResults}
                />
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

function CandidateCard({
  candidate,
  expanded,
  onToggleExpanded,
  onOpenDraft,
  disabled,
  forceExpanded = false,
  explicitButton = false,
}: {
  candidate: WizardPlanCandidate;
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpenDraft: () => void;
  disabled?: boolean;
  // WS9 3c follow-up (Part A / surprise A′) — surprise shows ONE card with its
  // details expanded by default (forceExpanded, hiding the toggle) and commits
  // via an explicit button, not a whole-card tap (explicitButton), so the
  // single full-screen card can't be mis-tapped into an expand + navigation.
  // The 3-candidate results screen passes neither and keeps whole-card-tap.
  forceExpanded?: boolean;
  explicitButton?: boolean;
}) {
  const macrosLine = `Avg ${formatMacro(candidate.dailyMacros.calories, "0")} cal/day · ${formatMacro(candidate.dailyMacros.proteinG, "0")}g P · ${formatMacro(candidate.dailyMacros.carbsG, "0")}g C · ${formatMacro(candidate.dailyMacros.fatG, "0")}g F`;
  const isExpanded = forceExpanded || expanded;

  const inner = (
    <>
      {/* Hero */}
      <View style={s.hero}>
        {candidate.imageUrl ? (
          <Image source={{ uri: candidate.imageUrl }} style={s.heroImage} />
        ) : (
          <View style={[s.heroImage, s.heroFallback]} />
        )}
        <View style={s.heroOverlay} />
        <View style={s.heroFooter}>
          {candidate.badge && (
            <View
              style={[
                s.badge,
                candidate.badge === "featured"
                  ? s.badgeFeatured
                  : s.badgeTopRated,
              ]}
            >
              <Text style={s.badgeText}>
                {candidate.badge === "featured" ? "Featured" : "Top Rated"}
              </Text>
            </View>
          )}
          <DisplayTitle source={candidate} variant="row" style={s.heroTitle} />
        </View>
      </View>

      {/* Body */}
      <View style={s.body}>
        <View style={s.tagRow}>
          {candidate.tags.map((t) => (
            <View key={t} style={s.tag}>
              <Text style={s.tagText}>{t}</Text>
            </View>
          ))}
        </View>

        <View style={s.whyBox}>
          <Text style={s.whyLabel}>WHY THIS WORKS</Text>
          {candidate.whyBullets.map((b, i) => (
            <View key={i} style={s.whyRow}>
              <View style={s.whyDot} />
              <Text style={s.whyText}>{b}</Text>
            </View>
          ))}
        </View>

        <Text style={s.macrosLine} numberOfLines={1} ellipsizeMode="tail">
          {macrosLine}
        </Text>

        {/* No collapse toggle when forceExpanded (surprise) — the details are
            the point of the single card. */}
        {!forceExpanded && (
          <Pressable
            onPress={onToggleExpanded}
            hitSlop={6}
            style={({ pressed }) => [
              s.expandToggle,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={s.expandToggleText}>
              {expanded ? "Hide preview" : "Preview meals & macros"}
            </Text>
            <Feather
              name={expanded ? "chevron-up" : "chevron-down"}
              size={16}
              color={Colors.sage[700]}
            />
          </Pressable>
        )}

        {isExpanded && (
          <View style={s.expandedSection}>
            <Text style={s.subSectionLabel}>Meals in this plan</Text>
            {/* D-WS9-032 point 1 — meals render as ROWS (not bullets). Per-meal
                images aren't on the candidate payload (C4 — no server change to
                enrich it), so each row carries a neutral placeholder in the
                thumbnail slot; a later enrichment can drop a real image in. */}
            <View style={s.mealList}>
              {candidate.mealTitles.map((title, i) => (
                <View key={i} style={s.mealRow}>
                  <View style={s.mealThumbPlaceholder} />
                  <Text style={s.mealRowText}>{title}</Text>
                </View>
              ))}
            </View>

            <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
              Daily averages
            </Text>
            <View style={s.macrosGrid}>
              <MacroCell
                value={candidate.dailyMacros.calories}
                label="cal/day"
              />
              <MacroCell
                value={candidate.dailyMacros.proteinG}
                label="g protein"
              />
              <MacroCell
                value={candidate.dailyMacros.carbsG}
                label="g carbs"
              />
              <MacroCell
                value={candidate.dailyMacros.fatG}
                label="g fat"
              />
            </View>
          </View>
        )}

        {explicitButton ? (
          // Surprise (Part A) — an explicit primary owns the navigation; the
          // card body is not a tap target.
          <View style={s.cardButtonWrap}>
            <Button
              label="See full plan & save"
              variant="primary"
              onPress={onOpenDraft}
              disabled={disabled}
            />
          </View>
        ) : (
          // D-WS9-032 — the card no longer commits. A tap-hint stands in for the
          // removed "Use this plan" primary; the whole card opens Plan Review as
          // a draft, where Save for Later / Use This Week live.
          <View style={s.tapHintRow}>
            <Text style={s.tapHintText}>Review &amp; save</Text>
            <Feather name="arrow-right" size={16} color={Colors.sage[700]} />
          </View>
        )}
      </View>
    </>
  );

  // Explicit-button mode (surprise): no whole-card tap target — the button owns
  // the navigation, so the card is a plain View.
  if (explicitButton) {
    return <View style={[s.card, disabled && { opacity: 0.6 }]}>{inner}</View>;
  }

  // WS9 3c (D-WS9-032) — the whole card is the tap target on the 3-candidate
  // screen. The inline "Preview meals & macros" toggle is a nested Pressable, so
  // tapping it expands without also opening the draft (RN grants the responder
  // to the innermost pressable).
  return (
    <Pressable
      onPress={disabled ? undefined : onOpenDraft}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        s.card,
        pressed && !disabled && { opacity: 0.9 },
        disabled && { opacity: 0.6 },
      ]}
    >
      {inner}
    </Pressable>
  );
}

function MacroCell({ value, label }: { value: number; label: string }) {
  return (
    <View style={s.macroCell}>
      <Text style={s.macroValue}>{formatMacro(value, "0")}</Text>
      <Text style={s.macroLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  actionRow: {
    flexDirection: "row",
    gap: Spacing[2],
    marginBottom: Spacing[3],
  },
  candidatesWrap: {
    gap: Spacing[3],
  },
  statusBox: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[2],
  },
  statusText: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
  errorTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  errorBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  noticeBox: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    padding: Spacing[3],
    marginBottom: Spacing[3],
  },
  noticeText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[400],
  },
  overflowBox: {
    backgroundColor: Colors.terracotta[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.terracotta[300],
    padding: Spacing[3],
    marginBottom: Spacing[3],
    gap: 6,
  },
  overflowTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  overflowBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  overflowChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: Spacing[1],
  },
  overflowChip: {
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
    backgroundColor: Colors.neutral[100],
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.terracotta[300],
  },
  overflowChipText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[600],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    overflow: "hidden",
  },
  hero: {
    height: 120,
    width: "100%",
    backgroundColor: Colors.sage[200],
    position: "relative",
  },
  heroImage: {
    width: "100%",
    height: "100%",
  },
  heroFallback: {
    backgroundColor: Colors.sage[200],
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(20,35,18,0.35)",
  },
  heroFooter: {
    position: "absolute",
    left: Spacing[3],
    right: Spacing[3],
    bottom: Spacing[2],
    gap: 6,
  },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: Spacing[2],
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  badgeFeatured: {
    backgroundColor: Colors.terracotta[500],
  },
  badgeTopRated: {
    backgroundColor: Colors.sage[700],
  },
  badgeText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  heroTitle: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[0],
    // BUG-035 — a serif 700 weight needs the Fraunces_700Bold face (loaded 3b);
    // pairing fontWeight:700 with the 600 face rendered a synthetic/wrong bold.
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
  },
  body: {
    padding: Spacing[3],
    gap: Spacing[2],
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  tag: {
    paddingHorizontal: Spacing[2],
    paddingVertical: 3,
    backgroundColor: Colors.neutral[100],
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
  },
  tagText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
  whyBox: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    padding: Spacing[3],
    gap: 6,
  },
  whyLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[600],
    fontWeight: Typography.fontWeight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: Typography.face.sans[600],
    marginBottom: 2,
  },
  whyRow: {
    flexDirection: "row",
    gap: Spacing[2],
    alignItems: "flex-start",
  },
  whyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.terracotta[400],
    marginTop: 7,
  },
  whyText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    lineHeight: 20,
    fontFamily: Typography.face.sans[400],
  },
  macrosLine: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  expandToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  expandToggleText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  expandedSection: {
    paddingTop: Spacing[2],
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[300],
    marginTop: Spacing[2],
  },
  subSectionLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[600],
    fontWeight: Typography.fontWeight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: Typography.face.sans[600],
    marginBottom: Spacing[2],
  },
  mealList: {
    gap: Spacing[1],
  },
  mealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    paddingVertical: Spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.neutral[200],
  },
  mealThumbPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.sage[100],
  },
  mealRowText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
  },
  cardButtonWrap: {
    marginTop: Spacing[3],
  },
  tapHintRow: {
    marginTop: Spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 4,
  },
  tapHintText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  macrosGrid: {
    flexDirection: "row",
    gap: Spacing[1],
  },
  macroCell: {
    flex: 1,
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    paddingVertical: Spacing[2],
    alignItems: "center",
  },
  macroValue: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  macroLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
    textAlign: "center",
  },
  expandOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(20,35,18,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing[4],
  },
  expandPanel: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[2],
  },
  expandTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  expandBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  expandBodyEmphasis: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textAlign: "center",
    marginTop: Spacing[1],
  },
  expandCancelWrap: {
    marginTop: Spacing[2],
    width: "60%",
  },
  expandErrorRow: {
    flexDirection: "row",
    gap: Spacing[2],
    marginTop: Spacing[3],
    width: "100%",
  },
});
