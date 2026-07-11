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

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { LoadingShim } from "@/components/LoadingShim";
import { Screen } from "@/components/Screen";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useBuildWizardPlans } from "@/hooks/useBuildWizardPlans";
import {
  expandWizardCandidate,
  type WizardExpandCandidateContext,
  type WizardExpandResponse,
} from "@/lib/api/wizard";
import type {
  BuildFromTextResult,
  ParsedIntent,
} from "@/lib/api/tellKiwi";
import { formatMacro } from "@/lib/format/macros";
import type { TellKiwiInput, WizardPlanCandidate, WizardPreferencesInput } from "@/lib/types";

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
type ExpandState =
  | { kind: "idle" }
  | {
      kind: "pending";
      candidateId: string;
      controller: AbortController;
      elapsedSec: number;
    }
  | { kind: "error"; candidate: WizardPlanCandidate; message: string };

export default function WizardResultsScreen() {
  const router = useRouter();
  // Two entry points:
  //   - Set Preferences wizard → passes `input` (WizardPreferencesInput JSON);
  //     this screen fires the build-plans mutation and renders 3 candidates.
  //   - Tell Kiwi → passes `tellKiwiResult` (already-built BuildFromTextResult
  //     JSON); the AI ran on the previous screen (tellkiwi.tsx). This screen
  //     just renders the result, branching by parsedIntent.scenario.
  const { source, input, tellKiwiResult, tellKiwiInput } =
    useLocalSearchParams<{
      source?: "tellkiwi";
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

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // `attempt` ticks once per regen request so the effect re-fires even when
  // `input` is identical (re-entering the wizard with unchanged prefs would
  // otherwise leave React Query showing the previous mount's data).
  const [attempt, setAttempt] = useState(0);
  const mutation = useBuildWizardPlans();

  useEffect(() => {
    // Tell Kiwi preloads its result via params; never re-fire the wizard
    // mutation in that case, which would clobber the candidates with an
    // unrelated set from a different prompt.
    if (tellKiwiPayload) return;
    if (!wizardInput) return;
    mutation.reset();
    mutation.mutate(wizardInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, attempt, tellKiwiPayload]);

  const parsedIntent: ParsedIntent | null =
    tellKiwiPayload?.parsedIntent ?? null;

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

  const subtitle = tellKiwiPayload && parsedIntent
    ? subtitleForScenario(parsedIntent.scenario)
    : source === "tellkiwi"
    ? "3 plans Kiwi built from your request"
    : "3 plans Kiwi cooked up just for you";

  const candidates: WizardPlanCandidate[] = tellKiwiPayload
    ? tellKiwiPayload.candidates
    : mutation.data?.candidates ?? [];

  const cannotGenerateMore = tellKiwiPayload
    ? tellKiwiPayload.cannotGenerateMore
    : mutation.data?.cannotGenerateMore;
  const cannotGenerateMoreReason = tellKiwiPayload
    ? tellKiwiPayload.reason
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
    if (!wizardInput) return;
    setExpandedIds(new Set());
    // Bump attempt; the effect handles reset+mutate so both navigation-driven
    // and button-driven re-rolls go through one code path.
    setAttempt((n) => n + 1);
  };

  const handleHeaderBack = () => {
    router.replace("/(tabs)");
  };

  // ── WS7-5b-mobile Block A — expand → Plan Details flow ─────────────
  // Replaces the OLD `handleUsePlan` deep-link to `demo-plan-just-created`
  // (the wizard-results half of D-WS7-059). Per the locked two-step model:
  //   1. User taps "View Plan Details" on a candidate card.
  //   2. POST /wizard/expand runs (~3-15s typical) — show the §5.4 loading
  //      state with a cancel option.
  //   3. On success the server has persisted a hidden draft MealPlanInstance
  //      and returned the expanded plan. Navigate to /wizard/plan-details
  //      with the draft id + expanded JSON; that screen owns the two CTAs
  //      and the post-save state machine.
  const [expandState, setExpandState] = useState<ExpandState>({ kind: "idle" });
  // Stable across re-renders so the elapsed-time interval reads the same
  // controller reference the AbortController was created against.
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drive the §5.4 "Kiwi is being thorough…" 30s threshold by ticking
  // `elapsedSec` once a second while pending. Clears on success/error/cancel.
  useEffect(() => {
    if (expandState.kind !== "pending") {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      return;
    }
    const startedAt = Date.now();
    elapsedTimerRef.current = setInterval(() => {
      setExpandState((prev) => {
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
  }, [expandState.kind]);

  const handleViewPlanDetails = async (candidate: WizardPlanCandidate) => {
    // Already expanding another candidate — ignore. The §5.4 overlay blocks
    // the cards anyway, but the guard makes the intent explicit.
    if (expandState.kind === "pending") return;

    const controller = new AbortController();
    setExpandState({
      kind: "pending",
      candidateId: candidate.id,
      controller,
      elapsedSec: 0,
    });

    const candidateContext = buildCandidateContext(
      candidate,
      wizardInput,
      tellKiwiInputParsed,
    );

    try {
      const result: WizardExpandResponse = await expandWizardCandidate(
        { candidate, candidateContext },
        { signal: controller.signal },
      );
      setExpandState({ kind: "idle" });
      router.push({
        pathname: "/wizard-plan-details",
        params: {
          draftId: result.draft.id,
          expanded: JSON.stringify(result.expanded),
        },
      });
    } catch (err) {
      // AbortError surfaces as a DOMException-style "AbortError" or our
      // ApiNetworkError wrapping the fetch AbortError. Either way, the
      // cancel handler has already flipped state to "idle" — don't clobber.
      if (controller.signal.aborted) return;
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Something went wrong.";
      setExpandState({ kind: "error", candidate, message });
    }
  };

  const handleExpandCancel = () => {
    if (expandState.kind !== "pending") return;
    expandState.controller.abort();
    setExpandState({ kind: "idle" });
  };

  const handleExpandRetry = () => {
    if (expandState.kind !== "error") return;
    void handleViewPlanDetails(expandState.candidate);
  };

  const handleExpandBackToResults = () => {
    setExpandState({ kind: "idle" });
  };

  // ── render branches ──────────────────────────────────────────────────

  // No usable payload — entry-point misrouted (no input AND no preloaded
  // Tell Kiwi result). Surface a recoverable error.
  if (!wizardInput && !tellKiwiPayload) {
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

        {!tellKiwiPayload && mutation.isPending && (
          <LoadingShim variant="status-box" />
        )}

        {!tellKiwiPayload && !mutation.isPending && mutation.isError && (
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
          (!mutation.isPending && mutation.isSuccess)) && (
          <View style={s.candidatesWrap}>
            {candidates.map((c) => (
              <CandidateCard
                key={c.id}
                candidate={c}
                expanded={expandedIds.has(c.id)}
                onToggleExpanded={() => toggleExpanded(c.id)}
                onUsePlan={() => handleViewPlanDetails(c)}
                disabled={expandState.kind === "pending"}
              />
            ))}
          </View>
        )}
      </Screen>

      {/* PRD §5.4 — full-screen modal-style overlay for the expand call.
          Mounted at the screen level (sits above the cards) so the Cancel
          / Try again / Back to results buttons aren't competing with the
          page's existing action row. Copy is locked verbatim. */}
      {expandState.kind === "pending" && (
        <View style={s.expandOverlay}>
          <View style={s.expandPanel}>
            <ActivityIndicator size="large" color={Colors.sage[700]} />
            <Text style={s.expandTitle}>Kiwi is thinking…</Text>
            <Text style={s.expandBody}>
              This usually takes about 10-15 seconds
            </Text>
            {expandState.elapsedSec >= EXPAND_THOROUGH_THRESHOLD_SEC && (
              <Text style={s.expandBodyEmphasis}>
                Kiwi is being thorough — almost there…
              </Text>
            )}
            <View style={s.expandCancelWrap}>
              <Button
                label="Cancel"
                variant="ghost"
                onPress={handleExpandCancel}
              />
            </View>
          </View>
        </View>
      )}

      {expandState.kind === "error" && (
        <View style={s.expandOverlay}>
          <View style={s.expandPanel}>
            <Text style={s.expandTitle}>
              Kiwi got distracted. Want to try again?
            </Text>
            {expandState.message ? (
              <Text style={s.expandBody}>{expandState.message}</Text>
            ) : null}
            <View style={s.expandErrorRow}>
              <View style={{ flex: 1 }}>
                <Button
                  label="Try again"
                  variant="primary"
                  onPress={handleExpandRetry}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="Back to results"
                  variant="ghost"
                  onPress={handleExpandBackToResults}
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
  disabled,
}: {
  candidate: WizardPlanCandidate;
  expanded: boolean;
  onToggleExpanded: () => void;
  onUsePlan: () => void;
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

            <View style={{ marginTop: Spacing[4] }}>
              <Button
                label="View Plan Details"
                variant="primary"
                onPress={onUsePlan}
                disabled={disabled}
              />
            </View>
          </View>
        )}
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
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[600],
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
