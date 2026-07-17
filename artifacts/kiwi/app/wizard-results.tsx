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
import { Header } from "@/components/Header";
import { LoadingShim } from "@/components/LoadingShim";
import { Screen } from "@/components/Screen";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useBuildWizardPlans } from "@/hooks/useBuildWizardPlans";
import { useBuildSurprise } from "@/hooks/useBuildSurprise";
import {
  activateWizardDraft,
  expandWizardCandidate,
  type WizardExpandCandidateContext,
  type WizardExpandResponse,
} from "@/lib/api/wizard";
import { getPlans } from "@/lib/api/plans";
import { getPreferences, type UserPreferences } from "@/lib/api/me";
import { ApiError } from "@/lib/api/errors";
import { resolveActivatedPlanRouteAfter404 } from "@/lib/wizard/activateRecovery";
import type {
  BuildFromTextResult,
  ParsedIntent,
} from "@/lib/api/tellKiwi";
import { formatMacro } from "@/lib/format/macros";
import type { TellKiwiInput, WizardPlanCandidate, WizardPreferencesInput } from "@/lib/types";

// R5 (WS9 3c) — client-side timeout for the merged expand→activate chain. The
// activate leg runs the server's finalize-steps + materialize $tx (~35s
// observed); 90s sits comfortably past the server ceiling so a real success is
// never perceived as a timeout, while a true 90s hang is still informative.
// Lifted verbatim from wizard-plan-details.tsx's ACTIVATE_CLIENT_TIMEOUT_MS.
const ACTIVATE_CLIENT_TIMEOUT_MS = 90_000;

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
  return {
    planDurationDays: Math.max(1, Math.min(7, candidate.mealTitles.length || 5)),
    householdSize: 4,
    wantsLeftovers: false,
    allergiesAndAvoidances: [],
    eatingStyles: [],
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
// R5 (WS9 3c) — one state machine now drives TWO card actions, distinguished
// by `mode`:
//   - "use"     → the merged expand→activate chain (one wait), lands on Plan
//                 Review. This is the card's single primary.
//   - "details" → expand-only, lands on the demoted read-only wizard-plan-
//                 details peek (the optional "View details" tertiary).
// BUG-037 — "surprise" auto-expands the single Surprise-me candidate straight
// to the draft screen (with a "Surprise Me again" re-roll), skipping the card
// picker. Same expand as "details" but lands non-peek (keeps the save CTAs).
type ChainMode = "use" | "details" | "surprise";
type ChainState =
  | { kind: "idle" }
  | {
      kind: "pending";
      mode: ChainMode;
      candidateId: string;
      controller: AbortController;
      elapsedSec: number;
    }
  | {
      kind: "error";
      mode: ChainMode;
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
  const { source, input, tellKiwiResult, tellKiwiInput } =
    useLocalSearchParams<{
      source?: "tellkiwi" | "surprise";
      input?: string;
      tellKiwiResult?: string;
      tellKiwiInput?: string;
    }>();
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
  const mutation = useBuildWizardPlans();

  useEffect(() => {
    // Tell Kiwi preloads its result via params; never re-fire the wizard
    // mutation in that case, which would clobber the candidates with an
    // unrelated set from a different prompt. Surprise-me fires its own
    // mutation below, not the build-plans one.
    if (tellKiwiPayload || isSurprise) return;
    if (!wizardInput) return;
    mutation.reset();
    mutation.mutate(wizardInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, attempt, tellKiwiPayload]);

  useEffect(() => {
    // Surprise-me generation (no input). `attempt` re-fires it for the
    // "Surprise me again" re-roll, same as the wizard path's More-options.
    if (!isSurprise) return;
    surpriseMutation.reset();
    surpriseMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSurprise, attempt]);

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

  const subtitle = isSurprise
    ? "3 crowd-pleasers Kiwi picked for you"
    : tellKiwiPayload && parsedIntent
    ? subtitleForScenario(parsedIntent.scenario)
    : source === "tellkiwi"
    ? "3 plans Kiwi built from your request"
    : "3 plans Kiwi cooked up just for you";

  const candidates: WizardPlanCandidate[] = tellKiwiPayload
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

  // ── R5 (WS9 3c) — merged expand→activate chain + View-details peek ──
  // "Use this plan" (the card's single primary) runs expand THEN activate in
  // ONE wait and lands directly on Plan Review. "View details" (tertiary) runs
  // expand-only and lands on the demoted read-only wizard-plan-details peek.
  // Both share one §5.4 loading/error surface, distinguished by ChainState.mode.
  //
  // Activation goes through activateWizardDraft — the canonical draft
  // materialize+activate endpoint — NOT setPlanActiveThisWeek, which needs an
  // already-materialized plan id a fresh draft doesn't have (Phase 0 FLAG B).
  // The server flip sets isActiveThisWeek; we invalidate ["plans"] AND ["home"]
  // so the Home hero doesn't go stale (the dead-home trap 3b flagged).
  const [chainState, setChainState] = useState<ChainState>({ kind: "idle" });
  // Distinguishes a user Cancel (silent — returns to cards) from the 90s client
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

  const runChain = async (candidate: WizardPlanCandidate, mode: ChainMode) => {
    // Already running — ignore. The §5.4 overlay blocks the cards anyway, but
    // the guard makes the intent explicit.
    if (chainState.kind === "pending") return;
    userCancelledRef.current = false;
    const controller = new AbortController();
    // One 90s ceiling over the whole chain (expand ~15s + activate ~35s); well
    // under 90s on success, but a true hang still surfaces.
    const timeoutId = setTimeout(
      () => controller.abort(),
      ACTIVATE_CLIENT_TIMEOUT_MS,
    );
    setChainState({
      kind: "pending",
      mode,
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

      if (mode === "details" || mode === "surprise") {
        // "details" — read-only peek (`peek:"1"`, no CTAs); the card's "Use this
        // plan" owns activation. "surprise" (BUG-037) — auto-expanded single
        // plan; land NON-peek (keeps the save/use CTAs) and pass `surprise:"1"`
        // so the draft screen shows the "Surprise Me again" re-roll.
        setChainState({ kind: "idle" });
        router.replace({
          pathname: "/wizard-plan-details",
          params: {
            draftId: expandResult.draft.id,
            expanded: JSON.stringify(expandResult.expanded),
            ...(mode === "details" ? { peek: "1" } : { surprise: "1" }),
          },
        });
        return;
      }

      // mode === "use" — chain straight into activate: materialize + demote
      // prior actives + auto-date the current week, then land on Plan Review.
      const activateResult = await activateWizardDraft(expandResult.draft.id, {
        signal: controller.signal,
      });
      setChainState({ kind: "idle" });
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
      router.replace({
        pathname: "/plan/[id]",
        params: { id: activateResult.instance.id },
      });
    } catch (err) {
      // A user Cancel already flipped state to idle — don't clobber it.
      if (userCancelledRef.current) {
        userCancelledRef.current = false;
        return;
      }
      // Activate 404 → the draft was already consumed by a dropped-201 (fetch
      // timeout / app backgrounding mid-tx). The plan is safe; recover its id
      // rather than showing red (D-WS7-080 recovery, lifted verbatim).
      if (mode === "use" && err instanceof ApiError && err.status === 404) {
        try {
          const route = await resolveActivatedPlanRouteAfter404(getPlans);
          queryClient.invalidateQueries({ queryKey: ["plans"] });
          queryClient.invalidateQueries({ queryKey: ["home"] });
          setChainState({ kind: "idle" });
          if (route.kind === "plan") {
            router.replace({
              pathname: "/plan/[id]",
              params: { id: route.planId },
            });
          } else {
            router.replace("/(tabs)/plans");
          }
          return;
        } catch {
          // Recovery fetch itself failed — fall through to the error panel.
        }
      }
      const message = controller.signal.aborted
        ? "Kiwi is still working on it. Check your plans in a moment — it may have saved."
        : err instanceof Error && err.message
          ? err.message
          : "Something went wrong.";
      setChainState({ kind: "error", mode, candidate, message });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleUsePlan = (candidate: WizardPlanCandidate) => {
    void runChain(candidate, "use");
  };
  const handleViewDetails = (candidate: WizardPlanCandidate) => {
    void runChain(candidate, "details");
  };

  const handleChainCancel = () => {
    if (chainState.kind !== "pending") return;
    userCancelledRef.current = true;
    chainState.controller.abort();
    setChainState({ kind: "idle" });
  };

  const handleChainRetry = () => {
    if (chainState.kind !== "error") return;
    void runChain(chainState.candidate, chainState.mode);
  };

  const handleChainBackToResults = () => {
    setChainState({ kind: "idle" });
  };

  // BUG-037 — Surprise-me is ONE plan straight to the draft screen, not a card
  // picker. Auto-expand the single candidate once per `attempt`, only once prefs
  // have loaded (so the expand candidateContext carries the hard constraints)
  // and while idle. The re-roll ("Surprise Me again" on the draft screen) mounts
  // this screen fresh (attempt resets), so the guard re-arms.
  const autoExpandedAttemptRef = useRef(-1);
  useEffect(() => {
    if (!isSurprise) return;
    if (chainState.kind !== "idle") return;
    if (!prefsQuery.data) return;
    const first = candidates[0];
    if (!first) return;
    if (autoExpandedAttemptRef.current === attempt) return;
    autoExpandedAttemptRef.current = attempt;
    void runChain(first, "surprise");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSurprise, candidates, chainState.kind, prefsQuery.data, attempt]);

  // ── render branches ──────────────────────────────────────────────────

  // No usable payload — entry-point misrouted (no input AND no preloaded
  // Tell Kiwi result). Surface a recoverable error. BUG-036 — the surprise
  // path carries neither `wizardInput` nor `tellKiwiPayload` (it generates on
  // mount from stored prefs), so it MUST be exempted here or this guard fires
  // on first render and sends every surprise run to the error screen.
  if (!wizardInput && !tellKiwiPayload && !isSurprise) {
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
          {!tellKiwiPayload && (
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

        {(tellKiwiPayload ||
          (isSurprise && surpriseMutation.isSuccess) ||
          (!isSurprise && !mutation.isPending && mutation.isSuccess)) && (
          <View style={s.candidatesWrap}>
            {candidates.map((c) => (
              <CandidateCard
                key={c.id}
                candidate={c}
                expanded={expandedIds.has(c.id)}
                onToggleExpanded={() => toggleExpanded(c.id)}
                onUsePlan={() => handleUsePlan(c)}
                onViewDetails={() => handleViewDetails(c)}
                disabled={chainState.kind === "pending"}
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
              {chainState.mode === "use"
                ? "Building your plan — this usually takes about 10-15 seconds"
                : "This usually takes about 10-15 seconds"}
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
  onUsePlan,
  onViewDetails,
  disabled,
}: {
  candidate: WizardPlanCandidate;
  expanded: boolean;
  onToggleExpanded: () => void;
  onUsePlan: () => void;
  onViewDetails: () => void;
  disabled?: boolean;
}) {
  const macrosLine = `Avg ${formatMacro(candidate.dailyMacros.calories, "0")} cal/day · ${formatMacro(candidate.dailyMacros.proteinG, "0")}g P · ${formatMacro(candidate.dailyMacros.carbsG, "0")}g C · ${formatMacro(candidate.dailyMacros.fatG, "0")}g F`;

  return (
    <View style={s.card}>
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
          <Text style={s.heroTitle} numberOfLines={2}>
            {candidate.title}
          </Text>
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

        {expanded && (
          <View style={s.expandedSection}>
            <Text style={s.subSectionLabel}>Meals in this plan</Text>
            <View style={s.mealList}>
              {candidate.mealTitles.map((title, i) => (
                <View key={i} style={s.mealRow}>
                  <View style={s.mealDot} />
                  <Text style={s.mealText}>{title}</Text>
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

        {/* R5 — one primary per card. "Use this plan" runs the merged
            expand→activate chain and lands on Plan Review; "View details" is
            the optional read-only peek (the demoted wizard-plan-details). */}
        <View style={s.cardCtas}>
          <Button
            label="Use this plan"
            variant="primary"
            onPress={onUsePlan}
            disabled={disabled}
          />
          <Pressable
            onPress={onViewDetails}
            disabled={disabled}
            hitSlop={6}
            style={({ pressed }) => [
              s.viewDetailsLink,
              pressed && !disabled && { opacity: 0.6 },
              disabled && { opacity: 0.4 },
            ]}
          >
            <Text style={s.viewDetailsText}>View details</Text>
          </Pressable>
        </View>
      </View>
    </View>
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
  cardCtas: {
    marginTop: Spacing[2],
    gap: Spacing[1],
  },
  viewDetailsLink: {
    alignSelf: "center",
    paddingVertical: Spacing[2],
    paddingHorizontal: Spacing[3],
  },
  viewDetailsText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
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
    gap: Spacing[2],
  },
  mealDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: Colors.sage[600],
  },
  mealText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
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
