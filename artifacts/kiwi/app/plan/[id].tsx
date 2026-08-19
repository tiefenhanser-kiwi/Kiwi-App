import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { AddMealsSheet } from "@/components/AddMealsSheet";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { DisplayTitle, resolveDisplayTitle } from "@/components/DisplayTitle";
import { SwapMealSheet, type SwapMode } from "@/components/SwapMealSheet";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { LoadingShim } from "@/components/LoadingShim";
import { PlanDateRangeEditor } from "@/components/PlanDateRangeEditor";
import { PlanNameEditor } from "@/components/PlanNameEditor";
import { PlanReviewMealRow } from "@/components/PlanReviewMealRow";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useApp } from "@/contexts/AppContext";
import { useToast } from "@/contexts/ToastProvider";
import { useCompostWithUndo } from "@/hooks/useCompostWithUndo";
import { useMeal } from "@/hooks/useMeal";
import { usePlan } from "@/hooks/usePlan";
import { ApiError } from "@/lib/api/errors";
import { buildDayStrip } from "@/lib/domain";
import { formatMacro } from "@/lib/format/macros";
import { generateGroceryListForPlan } from "@/lib/api/grocery";
import { dispatchGenerateResult } from "@/lib/groceryHandoff";
import { getPlans } from "@/lib/api/plans";
import {
  activateWizardDraft,
  saveWizardDraft,
  WizardExpandedPlanSchema,
  type WizardExpandedPlan,
} from "@/lib/api/wizard";
import { resolveActivatedPlanRouteAfter404 } from "@/lib/wizard/activateRecovery";
import {
  mealDetailToRow,
  planDetailToReviewPlan,
  sortUnscheduledNewestFirst,
} from "@/lib/plans/reviewPlanAdapter";
import { wizardExpandedPlanToReviewPlan } from "@/lib/plans/wizardDraftReviewAdapter";
import { decidePlanDetailsCta } from "@/lib/plans/wizardPostSaveCta";
import {
  demotionToastMessage,
  needsActiveCompostConfirm,
} from "@/lib/plans/planLifecycleActions";
import {
  DRAFT_CUSTOMIZABLE_COPY,
  planReviewState,
  planReviewSurface,
} from "@/lib/plans/planReviewSurface";
import { formatPlanDateRange } from "@/lib/cooking/hubModel";
import type {
  DayOfWeek,
  MealSummary,
  ReviewPlan,
  ReviewPlanMealRow,
} from "@/lib/types";

// WS9 3c (D-WS9-032) — client-side ceiling for the "Use This Week" activate
// leg (materialize + finalize-steps AI, ~35s observed). 90s sits past the
// server tx budget so a real success is never read as a timeout. Lifted from
// wizard-plan-details.tsx's ACTIVATE_CLIENT_TIMEOUT_MS (the flow this replaces).
const ACTIVATE_CLIENT_TIMEOUT_MS = 90_000;

// WS9 3c (D-WS9-032, point 6) — edit-guard copy, verbatim. A draft is not yet
// in the library, so meal edits/adds are gated behind this until the user
// commits via the action bar.
const DRAFT_EDIT_GUARD_COPY =
  "To customize this plan, save it to your library for this week or later.";

// BUG-052 / Part E — shown when the server reports the draft was superseded
// (409 archived) at commit time: a clear "no longer available" instead of the
// old 422 "malformed" that read as corruption. The Back button (→ results) is
// the obvious next action.
const DRAFT_ARCHIVED_COPY =
  "This plan is no longer available — it was replaced by a newer set. Go back to pick another, or generate a new one.";

// Parse the expanded-draft route param (JSON) into a WizardExpandedPlan.
// Returns null on malformed/absent input so the screen can render an error
// frame instead of crashing inside a tap handler.
function parseDraftExpanded(raw: string | undefined): WizardExpandedPlan | null {
  if (!raw) return null;
  try {
    const parsed = WizardExpandedPlanSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Android requires opt-in for LayoutAnimation. One-time global flag —
// this is the only file that opts in today; safe no-op if set elsewhere.
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const capitalize = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1);

// WS9-2 2e Part 3 — action-panel cell icon size. 18 is the app's most common
// in-control Feather size (16 of 41 call sites across app/ + components/,
// including PlanCardOverflowMenu's sheet items), so the panel inherits the
// existing sizing convention rather than introducing a new one.
const PANEL_ICON_SIZE = 18;

/**
 * Apply a day-pill tap. Updates the row's dayStrip to reflect the
 * new assignment and moves the row between scheduledMeals and
 * unscheduledMeals if its scheduled status flipped.
 *
 * Pure — caller wraps the resulting state with setReviewPlan plus
 * any animation/persistence side effects.
 */
function applyDayAssignment(
  plan: ReviewPlan,
  planItemId: string,
  newDay: DayOfWeek | null,
): ReviewPlan {
  const allRows = [...plan.scheduledMeals, ...plan.unscheduledMeals];
  const row = allRows.find((r) => r.planItemId === planItemId);
  if (!row) return plan;

  const updatedRow: ReviewPlanMealRow = {
    ...row,
    dayStrip: buildDayStrip(newDay),
  };
  const isNowScheduled = newDay !== null;

  const filteredScheduled = plan.scheduledMeals.filter(
    (r) => r.planItemId !== planItemId,
  );
  const filteredUnscheduled = plan.unscheduledMeals.filter(
    (r) => r.planItemId !== planItemId,
  );

  return isNowScheduled
    ? {
        ...plan,
        scheduledMeals: [...filteredScheduled, updatedRow],
        unscheduledMeals: filteredUnscheduled,
      }
    : {
        ...plan,
        scheduledMeals: filteredScheduled,
        unscheduledMeals: [...filteredUnscheduled, updatedRow],
      };
}

export default function PlanReviewScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id, addMealId, draftId, expanded } = useLocalSearchParams<{
    id: string;
    addMealId?: string;
    // WS9 3c (D-WS9-032, Option A) — draft mode. When a wizard candidate is
    // tapped, the results card expands it and routes here with the draft id +
    // the expanded payload; the plan is rendered UNSAVED until the action bar
    // commits it (Save for Later / Use This Week). Absent = everyday saved plan.
    draftId?: string;
    expanded?: string;
  }>();
  const planId = id ?? "";
  const isDraft = !!draftId;
  const draftPlan = useMemo(
    () => (isDraft ? parseDraftExpanded(expanded) : null),
    [isDraft, expanded],
  );
  const {
    changeMealForPlanItem,
    assignDayToPlanItem,
    unassignDayFromPlanItem,
    addMealToPlan,
    removeMealFromPlan,
    updatePlanName,
    updatePlanDateRange,
    setPlanActiveThisWeek,
    copyPlan,
    isMacrosRecalcInFlight,
  } = useApp();
  const { showToast } = useToast();
  const compostWithUndo = useCompostWithUndo();

  // WS7-4-D c14 — Re-seed local state on every server payload change so
  // post-mutation itemIds (Q-P0-3 atomic-swap from Change Meal, real
  // server ids from add-meal stub reconciliation) stay current. The pre-c14
  // `!reviewPlan` one-shot guard locked local state to the initial fetch:
  // subsequent invalidations updated planQuery.data but local state held
  // stale itemIds, so the next day-pill / compost / change-meal tap sent
  // the old id to the server and uncaught "item not found" ApiErrors fired.
  // Optimistic updates in the mutator helpers below remain visible until the
  // refetch arrives (~200ms) and then converge to server truth.
  // Draft mode never hits the network — usePlan("") is disabled (enabled:
  // id.length > 0). Saved mode fetches the real plan and seeds reviewPlan below.
  const planQuery = usePlan(isDraft ? "" : planId);
  // Draft mode seeds reviewPlan synchronously from the adapted expanded payload
  // (lazy initializer) so the first render already has the plan — the draft
  // params are fixed for this screen's life, and a commit navigates away
  // (router.replace to the real plan id). Saved mode starts null and is seeded
  // by the effect once planQuery resolves.
  const [reviewPlan, setReviewPlan] = useState<ReviewPlan | null>(() =>
    isDraft && draftPlan ? wizardExpandedPlanToReviewPlan(draftPlan) : null,
  );

  useEffect(() => {
    // Draft mode owns reviewPlan locally (seeded above, mutated by nothing —
    // edits are guarded off); never let a disabled planQuery clobber it.
    if (isDraft) return;
    if (planQuery.data) {
      setReviewPlan(planDetailToReviewPlan(planQuery.data));
    }
  }, [isDraft, planQuery.data]);

  // WS9 3e Part 3 (D-WS9-090 guard) — composted (soft-deleted) plan. Read
  // straight off the server payload: compost is terminal (no optimistic
  // mutation flips it back), and a draft's planQuery is disabled so this is
  // always false on a draft. Drives the composted action-bar branch below.
  const isComposted = !!planQuery.data?.compostedAt;

  // PRD §9.4 — deep-link from AddMealToPlanSheet's "Create new plan" card.
  // Asynchronously fetches the meal detail and injects a row into the
  // unscheduled cluster. Idempotent via consumedAddMealRef so a re-render
  // or re-navigate with the same param doesn't double-add.
  const injectMealQuery = useMeal(addMealId ?? "");
  const consumedAddMealRef = useRef<string | null>(null);

  useEffect(() => {
    if (!addMealId) return;
    if (consumedAddMealRef.current === addMealId) return;
    if (!injectMealQuery.data) return;
    if (!reviewPlan) return;

    consumedAddMealRef.current = addMealId;
    const injected = mealDetailToRow(injectMealQuery.data);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setReviewPlan((prev) =>
      prev
        ? { ...prev, unscheduledMeals: [...prev.unscheduledMeals, injected] }
        : prev,
    );
  }, [addMealId, injectMealQuery.data, reviewPlan]);

  // WS9 3d Part 1b — deep-link error UX. Retires the Ruling-9 Alert fallback
  // now that the shared Toast (Part 1a) exists: the failure surfaces as an
  // informational toast ("Couldn't add that meal.") instead of a modal Alert,
  // preserving the exact message the Alert carried.
  useEffect(() => {
    if (injectMealQuery.isError) {
      console.warn("[plan/id] addMealId fetch failed", {
        addMealId,
        error: injectMealQuery.error,
      });
      showToast({ message: "Couldn't add that meal." });
    }
  }, [injectMealQuery.isError, injectMealQuery.error, addMealId, showToast]);

  // Sheet state for §8.4.2 Change Meal flow.
  // WS9 3d Part 4 (D-WS9-018) — one swap-sheet state for BOTH row actions.
  // `mode` selects Different (filter chips) vs Similar (AI ranking); the source
  // meal is the one being replaced either way. Replaces the separate
  // changeMealForRow / findSimilarForRow state the two old sheets used.
  const [swapForRow, setSwapForRow] = useState<{
    planItemId: string;
    mode: SwapMode;
    sourceMealId: string;
    sourceMealTitle?: string;
    sourceCuisine?: string;
  } | null>(null);

  // Sheet state for §8.3.8 Add Meals flow.
  const [addMealsVisible, setAddMealsVisible] = useState(false);

  const planName = resolveDisplayTitle(reviewPlan);

  const [breakfastOpen, setBreakfastOpen] = useState(false);
  const [breakfastDraft, setBreakfastDraft] = useState("");
  const [lunchOpen, setLunchOpen] = useState(false);
  const [lunchDraft, setLunchDraft] = useState("");

  // Imperative scroll handle on the keyboard-aware scroll container plus
  // captured Y positions for the Breakfast/Lunch sections so toggles can
  // scroll the freshly-expanded section into view.
  const scrollRef = useRef<ScrollView>(null);
  const breakfastYRef = useRef(0);
  const lunchYRef = useRef(0);

  const toggleBreakfast = () => {
    Keyboard.dismiss();
    setBreakfastOpen((prev) => {
      const next = !prev;
      if (next) {
        // Defer scroll until after expand pushes new content into the layout
        // tree — without the delay scrollTo lands on the pre-expand Y.
        setTimeout(() => {
          scrollRef.current?.scrollTo({
            y: breakfastYRef.current,
            animated: true,
          });
        }, 100);
      }
      return next;
    });
  };

  const toggleLunch = () => {
    Keyboard.dismiss();
    setLunchOpen((prev) => {
      const next = !prev;
      if (next) {
        setTimeout(() => {
          scrollRef.current?.scrollTo({
            y: lunchYRef.current,
            animated: true,
          });
        }, 100);
      }
      return next;
    });
  };

  const onAddMeals = () => {
    setAddMealsVisible(true);
  };

  // WS6 6c-4 Block C — smart grocery list generation. Block B's two-AI-call
  // pipeline (Haiku gap-fill + Sonnet polish) can take 5-15s in the wild;
  // the button shows its loading state for the full duration and guards
  // against double-taps. 409 (list_exists) and 200 (success) both route to
  // the grocery list screen — same UX from the user's perspective.
  // WS9-2 2c Commit 10 — CLOSES D-WS7-144 (open since 2026-06-15).
  //
  // The in-flight guard, the isGeneratingList state and the button's loading
  // treatment stay here — they are this screen's. What LEFT is the six-outcome
  // error ladder that used to be inlined below: it is now
  // dispatchGenerateResult, which resolves the result and delivers it through
  // the sinks this screen supplies.
  //
  // Why it mattered: the inlined ladder was UNTESTED (app/ is outside the
  // mobile test glob) and had already drifted from the shared mapper on two of
  // six outcomes — `unauthenticated` said "Sign-in required" where the rest of
  // the app says the session expired, and the unknown-error case claimed
  // "Could not generate list" for a failure we cannot actually attribute.
  // Both divergences are retired; see lib/groceryHandoff.ts for the canonical
  // copy and lib/__tests__/groceryHandoff.test.ts for the coverage.
  //
  // ⚠️ There is ONE request path (generateGroceryListForPlan) and now ONE
  // mapping (resolveGenerateResult). Do not re-inline a second ladder here.
  const [isGeneratingList, setIsGeneratingList] = useState(false);
  const handleGroceryListPress = async () => {
    if (isGeneratingList) return;
    setIsGeneratingList(true);
    try {
      const result = await generateGroceryListForPlan(planId);
      dispatchGenerateResult(result, {
        // 200-new and 409-exists both land here — same destination, because
        // the user asked for this plan's list and gets this plan's list.
        navigate: (id) =>
          router.push({ pathname: "/grocery-list/[id]", params: { id } }),
        alert: (title, message) => Alert.alert(title, message),
      });
    } finally {
      setIsGeneratingList(false);
    }
  };

  const handleSavePlanName = (newName: string) => {
    setReviewPlan((prev) => (prev ? { ...prev, name: newName } : prev));
    void updatePlanName(planId, newName);
  };

  const handleSaveDateRange = (start: string, end: string) => {
    setReviewPlan((prev) =>
      prev
        ? { ...prev, weekStartDate: start, weekEndDate: end }
        : prev,
    );
    void updatePlanDateRange(planId, { startDate: start, endDate: end });
  };

  // WS7-6 (E) Block 2 §4 — Model 2 activation. Optimistically flip the
  // local chip state so the tap feels instant; the post-mutation refetch
  // re-seeds reviewPlan from the server's resolver-derived value.
  // WS9 3d Part 3c (D-WS9-011a) — when this activation displaces a prior
  // this-week plan, the server response names it; show the informational
  // demotion toast (no confirm — friction priority).
  const handleCookThisWeek = () => {
    setReviewPlan((prev) =>
      prev ? { ...prev, isActiveThisWeek: true } : prev,
    );
    void setPlanActiveThisWeek(planId)
      .then(({ demoted }) => {
        const message = demotionToastMessage(planName, demoted);
        if (message) showToast({ message });
      })
      .catch(() => {
        // Optimistic flip stays; the focus refetch reconciles to server truth.
      });
  };

  // WS9 3d Part 3b-3 (D-WS9-008) — Use again. Copies this plan INSTANCE (its
  // meals + per-plan overrides) into a fresh UNDATED, INACTIVE plan and opens it
  // so the user can date via "Cook This Week" or edit first. Works for any saved
  // plan (drafts never reach here — the action is saved-mode only).
  const handleUseAgainThisPlan = async () => {
    try {
      const { instanceId } = await copyPlan(planId);
      router.push({ pathname: "/plan/[id]", params: { id: instanceId } });
    } catch {
      showToast({ message: "Couldn't copy that plan. Please try again." });
    }
  };

  // WS9 3d Part 3a/3b-2 (D-WS9-001) — Compost from the Plan Review action area.
  // Navigate back to the plans list IMMEDIATELY (don't linger on a plan you just
  // deleted) — the app-level toast rides to the destination and its Undo window
  // keeps ticking above the navigator, so backing out no longer cancels the
  // compost. The shared hook owns the deferred DELETE + optimistic cache removal.
  // The active-this-week plan gets a naming confirm; drafts never reach here (the
  // Compost affordance is saved-mode only).
  const startPlanReviewCompost = () => {
    compostWithUndo(planId, planName);
    router.replace("/(tabs)/plans");
  };
  const handleCompostThisPlan = () => {
    if (needsActiveCompostConfirm(reviewPlan?.isActiveThisWeek ?? false)) {
      Alert.alert(
        "Compost plan",
        `This is your active plan for this week. Compost “${planName}”?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Compost",
            style: "destructive",
            onPress: startPlanReviewCompost,
          },
        ],
      );
      return;
    }
    startPlanReviewCompost();
  };

  // WS9 3d Part 3b-1 (D-WS9-013) — dietary-staleness note. The DECISION is made
  // server-side (GET /plans/:id.dietaryStale, which already accounts for the
  // draft + null-commit cases); the client only renders. Draft mode never has a
  // planQuery payload (usePlan is disabled), so dietaryStale is undefined → false.
  const showDietaryNote = planQuery.data?.dietaryStale ?? false;

  // ── WS9 3c (D-WS9-032, Option A) — draft-state action bar ────────────────
  // The shared action bar shows Save for Later / Use This Week while the plan
  // is an unsaved wizard draft, and flips to the real actions once committed.
  // Labels come from the SAME decider the wizard-plan-details surface uses
  // (decidePlanDetailsCta) — one decider, extended, not a parallel one. On
  // Plan Review we only ever render its pre-save state: a commit navigates away
  // to the freshly-materialized real plan (which then renders in saved mode).
  const draftCta = decidePlanDetailsCta(null, { activateLabel: "Use This Week" });
  const [draftCommit, setDraftCommit] = useState<"idle" | "save" | "use">(
    "idle",
  );
  const [draftCommitError, setDraftCommitError] = useState<string | null>(null);

  // Point 6 — meal edits/adds on an unsaved draft are gated behind this until
  // the user commits. Single-arg Alert (matches the addMealId-fail pattern
  // above): the guard sentence IS the message, no body.
  const showDraftEditGuard = () => {
    Alert.alert(DRAFT_EDIT_GUARD_COPY);
  };

  // "Save for Later" — POST /wizard/drafts/:id/save promotes the hidden draft
  // into a real undated, inactive plan. On success we navigate to the real
  // plan id; the screen re-renders in saved mode with the real actions (point
  // 4: a saved plan never shows the save options again).
  const handleSaveForLater = async () => {
    if (!draftId) return;
    if (draftCommit !== "idle") return;
    setDraftCommit("save");
    setDraftCommitError(null);
    try {
      const result = await saveWizardDraft(draftId);
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
      router.replace({
        pathname: "/plan/[id]",
        params: { id: result.instance.id },
      });
    } catch (err) {
      setDraftCommit("idle");
      if (err instanceof ApiError && err.status === 409) {
        setDraftCommitError(DRAFT_ARCHIVED_COPY);
        return;
      }
      setDraftCommitError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't save this plan.",
      );
    }
  };

  // "Use This Week" — POST /wizard/drafts/:id/activate materializes the draft,
  // demotes prior actives, auto-dates the current week, and lands on the real
  // active plan. Mirrors wizard-results.tsx's "use" chain: 90s client ceiling
  // over the activate leg + the D-WS7-080 404 recovery (a dropped-201 already
  // consumed the draft; the plan is safe — route to it rather than showing red).
  const handleUseThisWeek = async () => {
    if (!draftId) return;
    if (draftCommit !== "idle") return;
    setDraftCommit("use");
    setDraftCommitError(null);
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      ACTIVATE_CLIENT_TIMEOUT_MS,
    );
    try {
      const result = await activateWizardDraft(draftId, {
        signal: controller.signal,
      });
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
      // WS9 3d Part 3b-4 (D-WS9-011a) — if this activation displaced a prior
      // this-week plan, show the demotion toast. The app-level host keeps it
      // alive across the router.replace to the freshly-materialized plan.
      const demotionMsg = demotionToastMessage(planName, result.demoted);
      if (demotionMsg) showToast({ message: demotionMsg });
      router.replace({
        pathname: "/plan/[id]",
        params: { id: result.instance.id },
      });
    } catch (err) {
      // BUG-052 / Part E — the draft was superseded between expand and commit.
      // Distinct from the 404 dropped-201 recovery below: there is no plan to
      // route to, so show the clear "no longer available" message.
      if (err instanceof ApiError && err.status === 409) {
        setDraftCommit("idle");
        setDraftCommitError(DRAFT_ARCHIVED_COPY);
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        try {
          const route = await resolveActivatedPlanRouteAfter404(getPlans);
          queryClient.invalidateQueries({ queryKey: ["plans"] });
          queryClient.invalidateQueries({ queryKey: ["home"] });
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
          // Recovery fetch itself failed — fall through to the error line.
        }
      }
      setDraftCommit("idle");
      setDraftCommitError(
        controller.signal.aborted
          ? "Kiwi is still working on it. Check your plans in a moment — it may have saved."
          : err instanceof Error && err.message
            ? err.message
            : "Couldn't activate this plan.",
      );
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // Block B gate (WS7-3 C4 c1) — server load, error, or adapter-not-yet-seeded
  // states render a loading / error frame. The error branch distinguishes 404
  // (plan not owned / missing) from generic load failure per the same pattern
  // app/dish/[id].tsx adopted in C3 c3.
  // Draft mode with a malformed/absent expanded payload — can't render. Route
  // back to results rather than showing a dead plan screen.
  if (isDraft && !reviewPlan) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title="Plan Review" />
        <View style={s.gateWrap}>
          <Text style={s.gateText}>
            Couldn&apos;t load this plan draft. Head back and pick again.
          </Text>
          <View style={s.gateBtnWrap}>
            <Button
              label="Back to results"
              variant="ghost"
              onPress={() => router.back()}
            />
          </View>
        </View>
      </View>
    );
  }

  if (!isDraft && (planQuery.isLoading || (!reviewPlan && !planQuery.isError))) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title="Plan Review" />
        <View style={s.gateWrap}>
          <LoadingShim variant="screen" />
        </View>
      </View>
    );
  }

  if (!isDraft && (planQuery.isError || !reviewPlan)) {
    const err = planQuery.error;
    const isNotFound = err instanceof ApiError && err.status === 404;
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title="Plan Review" />
        <View style={s.gateWrap}>
          <Text style={s.gateText}>
            {isNotFound
              ? "Plan not found."
              : "Couldn't load this plan. Please try again."}
          </Text>
          <View style={s.gateBtnWrap}>
            {isNotFound ? (
              <Button
                label="Go back"
                variant="ghost"
                onPress={() => router.back()}
              />
            ) : (
              <Button
                label="Try again"
                variant="primary"
                onPress={() => planQuery.refetch()}
              />
            )}
          </View>
        </View>
      </View>
    );
  }

  // Both gate clusters above (draft parse-fail + saved load/error) return when
  // reviewPlan is null, so it is non-null here — this narrows it for TS across
  // the compound isDraft conditions the analyzer can't combine on its own.
  if (!reviewPlan) return null;

  const hasMeals =
    reviewPlan.scheduledMeals.length > 0 ||
    reviewPlan.unscheduledMeals.length > 0;

  // WS9-2 2b Commit 3 — client-derived meal count for the header band. There is
  // no server scalar for this; it is just the two buckets summed.
  const mealCount =
    reviewPlan.scheduledMeals.length + reviewPlan.unscheduledMeals.length;
  const mealCountLabel = `${mealCount} ${mealCount === 1 ? "meal" : "meals"}`;

  // D-WS9-142 — render the unscheduled bucket newest-first (positionIndex desc)
  // so a just-added meal lands at the TOP of Unscheduled. Display-only; the
  // scheduled section keeps its own order untouched.
  const unscheduledSorted = sortUnscheduledNewestFirst(reviewPlan.unscheduledMeals);

  // ── WS9-2 2e — ONE state, ONE surface table (lib/plans/planReviewSurface) ──
  // Every branch below reads a named flag off `surface`. It is deliberately NOT
  // a pile of inline `isDraft ? … : isComposted ? …` ternaries: app/ is outside
  // the test glob, and the inline form is precisely how D-WS9-090's composted
  // guard came to cover the action bar and nothing else. The table is pinned by
  // lib/plans/__tests__/planReviewSurface.test.ts — but only while the screen
  // keeps consuming it. Do not re-derive these locally.
  const state = planReviewState({
    isDraft,
    isComposted,
    isActiveThisWeek: reviewPlan.isActiveThisWeek,
  });
  const surface = planReviewSurface(state);

  // Composted renders the plan's identity as PLAIN TEXT. The date string comes
  // from the shared, tested formatPlanDateRange so it reads identically to the
  // editor's own trigger label — this is a treatment change, not a format fork.
  const staticDateLabel = formatPlanDateRange(
    reviewPlan.weekStartDate ?? null,
    reviewPlan.weekEndDate ?? null,
  );

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      {/* §8.3.1 — Header with back button, page label, and a state-aware pill:
          "Draft" while unsaved (D-WS9-032), the passive "Saved" pill once the
          plan is in the library. Plan name + date range live in the editable
          meta strip below the header (PRD §8 / §11). */}
      <Header
        showBack
        title="Plan Review"
        rightContent={
          isDraft ? (
            <View style={s.draftPill}>
              <Text style={s.draftPillText}>Draft</Text>
            </View>
          ) : (
            <View style={s.savedPill}>
              <Text style={s.savedPillText}>Saved</Text>
            </View>
          )
        }
      />

      <KeyboardAwareScrollViewCompat
        ref={scrollRef}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* WS9-2 2b Commit 3 (D-WS9-133) — sage-tinted header band. Holds the
            plan image (fallback-primary — see Commit 4), the plan name (inline
            tap-to-edit intact), a compact date + meal-count meta row, and the
            "Cook This Week" pill. The band replaces the old flat meta strip. */}
        <View style={s.headerBand}>
          {/* WS9-2 2c Commit 5 (D-WS9-144) — the plan header image is GONE.
              It was a 132px warm-gradient block on ~95% of plans: a
              MealPlanInstance has no image of its own and inherits the backing
              template's, which is null for everything except the six curated
              catalog rows. A placeholder that large, that often, is decoration
              standing in for content the app does not have.

              This is a REMOVAL, not a swap to a different placeholder.

              ⚠️ The Featured-plans rail is the explicit EXCEPTION and keeps its
              images — the distinction is PROVENANCE, not surface: a curated
              MealPlanTemplate carries a real photo someone chose; a generated
              instance has nothing honest to show. Same component, different
              data reality. Do not "restore consistency" by stripping the rail.

              Destination is a collage built from the plan's own meals, gated on
              WS7-10 (unbuilt: Meal.imageUrl is non-null on 0/1471 rows). */}
          {/* Three presentations of the same identity, chosen by the surface
              table: a draft's fixed candidate title, a composted plan's plain
              read-only text, or the live editable meta strip. */}
          {surface.headerBand === "draftTitle" ? (
            <View style={s.headerBandBody}>
              <DisplayTitle
                source={reviewPlan}
                variant="hero"
                style={s.draftTitle}
              />
              <Text style={s.mealCountText}>{mealCountLabel}</Text>
            </View>
          ) : surface.headerBand === "staticMeta" ? (
            /* D-WS9-159 — composted. The EDITORS don't render; the INFORMATION
               does. The plan's name and dates live nowhere else on this screen
               (<Header> carries the static string "Plan Review"), so dropping
               the band outright would leave an unnamed, undated page — which
               defeats the whole reason the meal list stays visible: letting the
               user see what was in the plan before deciding to bring it back. */
            <View style={s.headerBandBody}>
              <DisplayTitle
                source={reviewPlan}
                variant="slim"
                style={s.staticPlanName}
              />
              <View style={s.headerMetaRow}>
                {staticDateLabel && (
                  <>
                    <Text style={s.staticMetaText}>{staticDateLabel}</Text>
                    <Text style={s.headerDot}>·</Text>
                  </>
                )}
                <Text style={s.mealCountText}>{mealCountLabel}</Text>
              </View>
            </View>
          ) : (
            <View style={s.headerBandBody}>
              {/* WS9-2 2e Part 4 Item 1 — THE PLAN NAME GETS ITS OWN FULL-WIDTH
                  ROW. Part 3 Item 4 put it in a row shared with the this-week
                  chip; that bought the band a row of height and cost the title
                  its tail ("Italian Comfort mee…"). The chip moves DOWN into the
                  meta strip instead, so the name is the only thing on its line
                  and is free to wrap.

                  ⚠️ MIRRORS the meal/dish detail hero, which is a REPEATED LOCAL
                  LAYOUT, not a shared component (app/meal/[id].tsx s.hero /
                  s.heroTitle / s.heroQuickStats, duplicated in app/dish/[id].tsx):
                  an uncapped title alone on a full-width row above a "·"-joined
                  meta line. Mirrored, not extracted — the three surfaces do not
                  share typography, and this one is an EDITOR rather than a static
                  title, so the only thing genuinely common is the line policy,
                  which already lives in DisplayTitle.

                  ⚠️ s.headerTitleRow / s.titleCol are GONE with the row they
                  existed for. Their whole job was re-supplying column-stretch to
                  PlanNameEditor's flex:1 TextInput inside a ROW parent;
                  headerBandBody is itself a column, so the editor is a stretched
                  child again by default and the wrapper is dead weight. That
                  invariant is the reason this must not go back into a row. */}
              <PlanNameEditor
                currentName={planName}
                onSave={handleSavePlanName}
              />
              <View style={s.headerMetaRow}>
                <PlanDateRangeEditor
                  startDate={reviewPlan.weekStartDate}
                  endDate={reviewPlan.weekEndDate}
                  onSave={handleSaveDateRange}
                />
                <Text style={s.headerDot}>·</Text>
                <Text style={s.mealCountText}>{mealCountLabel}</Text>
                {/* Part 3 Item 4 — BOTH arms shorten to "This week" and adopt
                    IDENTICAL pill geometry (s.thisWeekPill supplies the box;
                    each arm only adds its own fill/border/ink), so the row
                    height does not change when a plan is activated.

                    Part 4 Item 1 — the slot now rides the META STRIP, pushed
                    right by s.thisWeekPillPushRight (marginLeft:auto). It is the
                    tallest thing on that strip, so it ABSORBS the row the title
                    vacated rather than adding one: the band's content height is
                    now title + max(meta, pill) where it was max(title, pill) +
                    meta. That is why an extra title row costs ~nothing.

                    Active = FILLED sage; inactive = OUTLINED, same footprint.
                    The tap behaviour of the inactive arm is exactly what "Cook
                    This Week" did — handleCookThisWeek is unchanged. */}
                {surface.showThisWeekSlot &&
                  (reviewPlan.isActiveThisWeek ? (
                    <View
                      style={[
                        s.thisWeekPill,
                        s.thisWeekPillPushRight,
                        s.thisWeekPillActive,
                      ]}
                    >
                      <Feather
                        name="check"
                        size={12}
                        color={Palette.text.onSage}
                      />
                      <Text
                        style={[s.thisWeekPillText, s.thisWeekPillTextActive]}
                        numberOfLines={1}
                      >
                        This week
                      </Text>
                    </View>
                  ) : (
                    <Pressable
                      onPress={handleCookThisWeek}
                      hitSlop={8}
                      accessibilityRole="button"
                      style={({ pressed }) => [
                        s.thisWeekPill,
                        s.thisWeekPillPushRight,
                        s.thisWeekPillInactive,
                        pressed && { opacity: 0.7 },
                      ]}
                    >
                      <Feather
                        name="calendar"
                        size={12}
                        color={Colors.sage[600]}
                      />
                      <Text
                        style={[s.thisWeekPillText, s.thisWeekPillTextInactive]}
                        numberOfLines={1}
                      >
                        This week
                      </Text>
                    </Pressable>
                  ))}
              </View>
            </View>
          )}
        </View>

        {/* §8.3.2 — Sticky-near-top action bar. ONE component, TWO states
            (D-WS9-032 point 4), driven by saved-state: an unsaved draft shows
            Save for Later / Use This Week; a saved plan shows the real actions
            and never re-offers the save options. */}
        {surface.showDraftCommitBar ? (
          <View style={s.actionBar}>
            {draftCommitError && (
              <Text style={s.draftCommitError}>{draftCommitError}</Text>
            )}
            <Button
              label={
                draftCommit === "use" ? "Activating…" : draftCta.useButton.label
              }
              variant="primary"
              loading={draftCommit === "use"}
              disabled={draftCommit !== "idle"}
              onPress={handleUseThisWeek}
            />
            <Button
              label={
                draftCommit === "save" ? "Saving…" : draftCta.saveButton.label
              }
              variant="ghost"
              loading={draftCommit === "save"}
              disabled={draftCommit !== "idle"}
              onPress={handleSaveForLater}
            />
            {/* WS9-2 2e (D-WS9-161) — replaces the Add Meals button that used to
                sit below this bar. That button existed only to explain that it
                did not work yet: a fake affordance on the highest-priority path
                in the product. This sentence does the same job honestly.

                ⚠️ NOT a caption, and not fine print. A user looking at generated
                plans who dislikes one meal may conclude the product does not
                understand them and leave, never learning the plan is fully
                editable. This line is the ONLY thing on a draft that says
                otherwise — body copy, neutral[800] at 15px on this card's white
                surface: 10.27:1, well past AA's 4.5:1. */}
            {surface.showDraftCustomizableNote && (
              <Text style={s.draftCustomizableNote}>
                {DRAFT_CUSTOMIZABLE_COPY}
              </Text>
            )}
          </View>
        ) : surface.showCompostedBar ? (
          // WS9 3e Part 3 / D-WS9-159 — a composted (soft-deleted) plan. Every
          // action that would do real work against a dead plan is gone; the
          // meals below stay VISIBLE BUT INERT so the user can see what was in
          // the plan before deciding.
          //
          // ⚠️ "Use again" MUST SURVIVE. Items still exist (soft-delete),
          // copyPlan works against them, and this is the user's ONLY way back
          // from here. It is a standalone button, deliberately NOT part of the
          // ⋯ overflow that 2e removed from this screen.
          <View style={s.actionBar}>
            <Text style={s.compostedNote}>This plan was composted.</Text>
            <View style={s.actionRow}>
              <View style={s.actionCol}>
                <Button
                  label="Use again"
                  variant="ghost"
                  onPress={handleUseAgainThisPlan}
                />
              </View>
            </View>
          </View>
        ) : surface.showActionPanel ? (
          /* WS9-2 2e Part 3 (D-WS9-157 + D-WS9-162) — panel direction B.
             ONE symmetric 2×2 group on a SAGE-TINTED panel, replacing the flat
             white card. "Basically like an action/control panel for the plan."

             ⚠️ Prep and Cook is THE TERRACOTTA FILL — and the only fill on this
             screen (D-WS9-162). Part 1 rendered all four as equal `secondary`
             peers on the reading that "symmetric" forbade a second hierarchy
             distinction; direction B overrules that. The four cells are
             symmetric in GEOMETRY (same grid, same size, same icon treatment)
             while the primary action carries the fill. Symmetry of layout, not
             of emphasis.

             ⚠️ Compost is NOT here any more — BUG-092 moved it out to a quiet
             link below the panel. Do not re-add a fifth cell.

             ⚠️ The panel REUSES the shared Button rather than hand-rolling
             cells: `iconLeft` for the Feather glyph, `variant="primary"` for the
             fill, and a per-cell `style` border override for the other three.
             Do not fork a bespoke Pressable here (§27.2). */
          <View style={s.actionPanel}>
            <View style={s.actionRow}>
              <View style={s.actionCol}>
                <Button
                  label="Prep and Cook"
                  variant="primary"
                  size="sm"
                  iconLeft={
                    <Feather
                      name="play"
                      size={PANEL_ICON_SIZE}
                      color={Palette.button.primary.text}
                    />
                  }
                  onPress={() => {
                    // WS7-8b B2 — plan-context entry: land on the Hub for this plan.
                    router.push({ pathname: "/prep-cook", params: { id: planId } });
                  }}
                />
              </View>
              <View style={s.actionCol}>
                <Button
                  label={isGeneratingList ? "Generating…" : "Grocery List"}
                  variant="secondary"
                  size="sm"
                  style={s.panelCell}
                  loading={isGeneratingList}
                  iconLeft={
                    <Feather
                      name="list"
                      size={PANEL_ICON_SIZE}
                      color={Colors.sage[600]}
                    />
                  }
                  onPress={handleGroceryListPress}
                />
              </View>
            </View>
            <View style={s.actionRow}>
              <View style={s.actionCol}>
                {/* D-WS9-158 — a stub that no-ops behind an Alert. Ruled: style
                    it as a full peer cell, because 2e styles for the destination
                    state (the Instacart work makes it function later).
                    ⚠️ This is the STUB. "Grocery List" above is the working
                    navigation — never conflate them (D-WS9-133). */}
                {/* Item 3 — "Get Groceries Online" → "Order Online".
                    ⚠️ There is no separate accessibility label to change:
                    Button exposes no accessibilityLabel prop, so the accessible
                    name is derived from the rendered label Text. Changing
                    `label` changes what a screen reader announces too. Adding
                    the prop would mean editing components/Button.tsx, which is
                    out of scope for this pass. */}
                <Button
                  label="Order Online"
                  variant="secondary"
                  size="sm"
                  style={s.panelCell}
                  iconLeft={
                    <Feather
                      name="shopping-cart"
                      size={PANEL_ICON_SIZE}
                      color={Colors.sage[600]}
                    />
                  }
                  onPress={() => {
                    Alert.alert(
                      "Coming soon — you'll be able to send this list to a grocery service.",
                    );
                  }}
                />
              </View>
              <View style={s.actionCol}>
                <Button
                  label="Add Meals"
                  variant="secondary"
                  size="sm"
                  style={s.panelCell}
                  iconLeft={
                    <Feather
                      name="plus"
                      size={PANEL_ICON_SIZE}
                      color={Colors.sage[600]}
                    />
                  }
                  onPress={onAddMeals}
                />
              </View>
            </View>
          </View>
        ) : null}

        {/* BUG-092 — Compost LEAVES the action cluster.
            As a Button it rendered full width (Button.fullWidth defaults true,
            and size="sm" only shrinks height and type, not the stretch), so the
            one control ruled "visually smaller" was the widest thing in the
            panel — the exact opposite of its intended weight.

            It is now a quiet right-aligned text link BELOW the panel. Muted
            neutral ink, NOT terracotta: the demotion is the point, and a
            terracotta destructive tint would re-promote it into the loudest
            thing on the screen.

            ⚠️ BEHAVIOUR IS UNCHANGED — same handler, so the active-plan confirm
            (needsActiveCompostConfirm) and the deferred-delete undo toast
            (compostWithUndo) are both still wired. This is a presentation move.
            Render condition is unchanged too: it lives in the same
            showActionPanel branch it always did, so draft and composted states
            are untouched. */}
        {surface.showActionPanel && (
          <Pressable
            onPress={handleCompostThisPlan}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Compost this plan"
            style={({ pressed }) => [
              s.compostLink,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={s.compostLinkText}>Compost</Text>
          </Pressable>
        )}

        {/* §8.3.3 — Prep status indicator (hidden on a draft — prep is a
            saved-plan concept). D-WS9-133: the not_prepped "Start Prep" banner
            is removed entirely — its handler was a dead console.log and the
            live prep entry is the "Prep and Cook" action-bar button above. Only
            the positive prepped / partial badges remain; not_prepped shows
            nothing (recovers the banner's vertical space). */}
        {!isDraft && reviewPlan.prepStatus !== "not_prepped" && (
          <View style={s.section}>
            <View style={s.prepBadge}>
              <Text style={s.prepBadgeText}>
                {reviewPlan.prepStatus === "prepped"
                  ? "Prepped this week ✓"
                  : "Prepped (mostly) ✓"}
              </Text>
            </View>
          </View>
        )}

        {/* §8.3.4 — Smart Optimization Panel (hidden when notes are empty per §8.6) */}
        {reviewPlan.optimizationNotes.length > 0 && (
          <View style={s.section}>
            <Card>
              <Text style={s.cardTitle}>Smart optimization</Text>
              <View style={{ gap: Spacing[2], marginTop: Spacing[2] }}>
                {reviewPlan.optimizationNotes.map((note, i) => (
                  <View key={i} style={s.noteRow}>
                    <Feather
                      name={note.type === "prep" ? "zap" : "dollar-sign"}
                      size={14}
                      color={Colors.sage[700]}
                    />
                    <Text style={s.noteText}>{note.text}</Text>
                  </View>
                ))}
              </View>
            </Card>
          </View>
        )}

        {/* §8.3.5 — Daily macro averages */}
        {/* WS7-4-E c3 — inline-above-row LoadingShim (Q2:A) renders while the
            AppContext hybrid-recalc dispatcher has a recalc-macros POST in
            flight. PRD §8.3.5 redline: "brief loading state while AI
            estimates macros for newly-added uncached dishes." Stale values
            stay visible below the shim per the redline. */}
        <View style={s.section}>
          <Card>
            <Text style={s.cardTitle}>Daily averages</Text>
            {isMacrosRecalcInFlight && (
              <View style={{ marginTop: Spacing[2] }}>
                <LoadingShim variant="inline" label="Updating macros…" />
              </View>
            )}
            <View style={s.macroRow}>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>
                  {formatMacro(reviewPlan.macroDailyAverage.caloriesPerDay)}
                </Text>
                <Text style={s.macroLabel}>cal</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>
                  {formatMacro(reviewPlan.macroDailyAverage.proteinGPerDay)}
                </Text>
                <Text style={s.macroLabel}>g protein</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>
                  {formatMacro(reviewPlan.macroDailyAverage.carbsGPerDay)}
                </Text>
                <Text style={s.macroLabel}>g carbs</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>
                  {formatMacro(reviewPlan.macroDailyAverage.fatGPerDay)}
                </Text>
                <Text style={s.macroLabel}>g fat</Text>
              </View>
            </View>
            {/* D-WS7-060 — divisor disclosure. PRD §8.3.5 is ambiguous about
                the divisor; the ratified rule is days-with-assigned-meals,
                not days-in-range. This copy line makes the rule legible so
                users understand why moving meals around shifts the average.
                PRD §8.3.5 redline is queued for WS7-CLOSE. */}
            <Text style={s.macroFootnote}>
              Macros are calculated only from days with meals assigned
            </Text>
          </Card>
        </View>

        {/* WS9 3d Part 3d (D-WS9-013) — passive dietary-staleness note. Renders
            only when the user's allergy/dietary prefs changed after this plan
            was committed. Non-blocking gold state-chip banner (spec §3); no
            confirm, no dismiss — self-resolves when the plan is regenerated. */}
        {showDietaryNote && (
          <View style={s.section}>
            <View style={s.dietaryNote}>
              <Feather name="alert-circle" size={16} color={Colors.gold.text} />
              <Text style={s.dietaryNoteText}>
                Your dietary preferences or restrictions were updated after this
                plan was created. Double-check your ingredients.
              </Text>
            </View>
          </View>
        )}

        {/* §8.3.6 — Meals list (structure only; rows ship in 5E) */}
        <View style={s.section}>
          <Text style={s.sectionHeader}>Meals</Text>
          {!hasMeals ? (
            <View style={s.emptyMeals}>
              <Text style={s.emptyMealsText}>
                No meals in this plan yet. Add some?
              </Text>
            </View>
          ) : (
            <>
              {reviewPlan.scheduledMeals.map((row) => (
                <PlanReviewMealRow
                  key={row.planItemId}
                  row={row}
                  planId={planId}
                  // D-WS9-159 — REUSED, not rebuilt. PlanReviewMealRow already
                  // owns this mechanism (WS9 3c, for drafts): readOnly hides Cook
                  // Now + the four edit actions, and routes row taps / day pills
                  // to onReadOnlyEdit instead of mutating. Composted simply
                  // becomes its second caller.
                  readOnly={surface.rowsReadOnly}
                  // A draft's guard EXPLAINS why editing is off ("save it to your
                  // library"). A composted plan has nothing to explain and no
                  // action to offer, so the handler is omitted and the row is
                  // genuinely INERT — onReadOnlyEdit?.() no-ops.
                  onReadOnlyEdit={isDraft ? showDraftEditGuard : undefined}
                  onChangeMeal={(planItemId, currentMealId) =>
                    setSwapForRow({
                      planItemId,
                      mode: "different",
                      sourceMealId: currentMealId,
                    })
                  }
                  onFindSimilar={(planItemId, sourceMealId, title) => {
                    setSwapForRow({
                      planItemId,
                      mode: "similar",
                      sourceMealId,
                      sourceMealTitle: title,
                      sourceCuisine: row.cuisine,
                    });
                  }}
                  onAssignDay={handleAssignDay}
                  onCompost={handleCompostFromPlan}
                />
              ))}
              {reviewPlan.unscheduledMeals.length > 0 && (
                <>
                  {/* On a draft every meal is unscheduled (no day assignment
                      until it's saved + activated), so the "Unscheduled"
                      contrast header would be noise — omit it. */}
                  {!isDraft && (
                    <Text style={s.subSectionHeader}>Unscheduled</Text>
                  )}
                  {unscheduledSorted.map((row) => (
                    <PlanReviewMealRow
                      key={row.planItemId}
                      row={row}
                      planId={planId}
                      readOnly={surface.rowsReadOnly}
                      onReadOnlyEdit={isDraft ? showDraftEditGuard : undefined}
                      onChangeMeal={(planItemId, currentMealId) =>
                        setSwapForRow({
                          planItemId,
                          mode: "different",
                          sourceMealId: currentMealId,
                        })
                      }
                      onFindSimilar={(planItemId, sourceMealId, title) => {
                        setSwapForRow({
                          planItemId,
                          mode: "similar",
                          sourceMealId,
                          sourceMealTitle: title,
                          sourceCuisine: row.cuisine,
                        });
                      }}
                      onAssignDay={handleAssignDay}
                      onCompost={handleCompostFromPlan}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </View>

        {/* §8.3.7 — Breakfast & Lunch defaults (collapsed by default).
            Hidden on a draft (per-plan overrides only make sense once the plan
            is saved) and, as of D-WS9-159, on a composted plan: "genuinely
            read-only" cannot mean a screen with two live text fields on it.

            ⚠️ THIS IS A RENDER CONDITION AND NOTHING ELSE. It is NOT a fix for
            BUG-088 — breakfastDraft / lunchDraft are still never seeded from
            reviewPlan.breakfastOverrides and still never persisted, exactly as
            broken on a live plan as they were before. Do not "finish the job"
            here; the persistence path is logged separately and is not 2e's. */}
        {surface.showMealDefaults && (
        <>
        <View
          style={s.section}
          onLayout={(e) => {
            breakfastYRef.current = e.nativeEvent.layout.y;
          }}
        >
          <Pressable
            onPress={toggleBreakfast}
            hitSlop={10}
            style={({ pressed }) => [
              s.collapseHeader,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={s.collapseTitle}>Breakfast defaults</Text>
            <Feather
              name={breakfastOpen ? "chevron-up" : "chevron-down"}
              size={18}
              color={Colors.sage[700]}
            />
          </Pressable>
          {breakfastOpen && (
            <TextInput
              value={breakfastDraft}
              onChangeText={setBreakfastDraft}
              placeholder="Try: eggs, yogurt, oatmeal, fresh fruit"
              placeholderTextColor={Colors.neutral[600]}
              style={s.collapseInput}
              multiline
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={Keyboard.dismiss}
            />
          )}
        </View>

        <View
          style={s.section}
          onLayout={(e) => {
            lunchYRef.current = e.nativeEvent.layout.y;
          }}
        >
          <Pressable
            onPress={toggleLunch}
            hitSlop={10}
            style={({ pressed }) => [
              s.collapseHeader,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={s.collapseTitle}>Lunch defaults</Text>
            <Feather
              name={lunchOpen ? "chevron-up" : "chevron-down"}
              size={18}
              color={Colors.sage[700]}
            />
          </Pressable>
          {lunchOpen && (
            <TextInput
              value={lunchDraft}
              onChangeText={setLunchDraft}
              placeholder="Try: leftovers, sandwiches, salads"
              placeholderTextColor={Colors.neutral[600]}
              style={s.collapseInput}
              multiline
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={Keyboard.dismiss}
            />
          )}
        </View>
        </>
        )}
      </KeyboardAwareScrollViewCompat>

      <SwapMealSheet
        visible={swapForRow !== null}
        mode={swapForRow?.mode ?? "different"}
        sourceMealId={swapForRow?.sourceMealId ?? ""}
        sourceMealTitle={swapForRow?.sourceMealTitle}
        sourceCuisine={swapForRow?.sourceCuisine}
        // WS9 3f-3 (D-WS9-005) — the plan + slot being replaced, so the sheet's
        // "Bring in something new" chooser threads them and an imported/created
        // replacement REPLACES this slot (§8.4.2) instead of abandoning the swap.
        planId={planId}
        planItemId={swapForRow?.planItemId}
        onClose={() => setSwapForRow(null)}
        onPickReplacement={(newMeal) => {
          if (!swapForRow) return;
          // applyMealReplacement handles its own errors (rollback + toast), so
          // the floating promise never rejects — void it explicitly.
          void applyMealReplacement(swapForRow.planItemId, newMeal);
          setSwapForRow(null);
        }}
      />

      <AddMealsSheet
        visible={addMealsVisible}
        planId={planId}
        onClose={() => setAddMealsVisible(false)}
        onPickExistingMeal={addExistingMealToPlan}
      />
    </View>
  );

  // ── Optimistic-update helper shared by both swap modes (Change Meal /
  //    Find Similar, now the one merged SwapMealSheet). Repoints
  //    planItem.mealId to a different Meal and refreshes the row's display.
  //
  //    WS9 3d Part 4 follow-up (P1 fix) — the swap is a server-side delete+
  //    create, so the item id CHANGES. Previously this fired the mutator as a
  //    bare `void ...` with no error handling: a swap that raced a prior swap's
  //    refetch sent the just-deleted planItemId, the server 404'd "item not
  //    found", and the rejection surfaced as an Uncaught (in promise) crash.
  //    Now: (1) on success we converge the optimistic row's planItemId to the
  //    server's new id immediately (not only via the ~200ms refetch re-seed),
  //    so a fast second swap on the same row uses a live id; (2) on failure we
  //    roll back the optimistic display, refetch to reconcile ids to server
  //    truth, and surface a retryable toast instead of crashing. ──
  async function applyMealReplacement(
    targetPlanItemId: string,
    newMeal: MealSummary,
  ) {
    const prevReviewPlan = reviewPlan; // rollback snapshot
    const newMetaLine = `${capitalize(newMeal.difficulty)} · ${newMeal.estimatedTimeMinutes} min · serves ${newMeal.servingsDefault}`;
    const replaceRow = (m: ReviewPlanMealRow): ReviewPlanMealRow =>
      m.planItemId === targetPlanItemId
        ? {
            ...m,
            mealId: newMeal.id,
            title: newMeal.title,
            thumbnailUrl: newMeal.imageUrl,
            cuisine: newMeal.cuisineType,
            metaLine: newMetaLine,
            caloriesPerServing: newMeal.caloriesPerServing,
            proteinGPerServing: newMeal.proteinGPerServing,
            carbsGPerServing: newMeal.carbsGPerServing,
            fatGPerServing: newMeal.fatGPerServing,
          }
        : m;
    setReviewPlan((prev) =>
      prev
        ? {
            ...prev,
            scheduledMeals: prev.scheduledMeals.map(replaceRow),
            unscheduledMeals: prev.unscheduledMeals.map(replaceRow),
          }
        : prev,
    );
    try {
      const { newPlanItemId } = await changeMealForPlanItem(
        planId,
        targetPlanItemId,
        newMeal.id,
      );
      // Converge the row's id to the server's freshly-created item so the next
      // swap on this row targets a live id, not the deleted one.
      const repointRow = (m: ReviewPlanMealRow): ReviewPlanMealRow =>
        m.planItemId === targetPlanItemId
          ? { ...m, planItemId: newPlanItemId }
          : m;
      setReviewPlan((prev) =>
        prev
          ? {
              ...prev,
              scheduledMeals: prev.scheduledMeals.map(repointRow),
              unscheduledMeals: prev.unscheduledMeals.map(repointRow),
            }
          : prev,
      );
    } catch {
      // Revert the optimistic display, then refetch so reviewPlan reconciles to
      // server truth (fixing a stale/deleted id for the retry). No uncaught crash.
      setReviewPlan(prevReviewPlan);
      void planQuery.refetch();
      showToast({ message: "Couldn't swap that meal. Please try again." });
    }
  }

  // ── Day-pill tap (PRD §8.3.6). null = unassign. Configures the
  //    next layout pass so the row's move between scheduled and
  //    unscheduled clusters animates rather than snaps. ──
  function handleAssignDay(planItemId: string, newDay: DayOfWeek | null) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setReviewPlan((prev) =>
      prev ? applyDayAssignment(prev, planItemId, newDay) : prev,
    );
    if (newDay === null) {
      void unassignDayFromPlanItem(planId, planItemId);
    } else {
      void assignDayToPlanItem(planId, planItemId, newDay);
    }
  }

  // ── Compost from plan (PRD §8.4.5). Confirmation alert with a
  //    destructive primary action; on confirm, optimistically drop
  //    the row from whichever cluster holds it. AppContext mutator
  //    is log-only; real persistence lands WS7. ──
  function handleCompostFromPlan(planItemId: string, title: string) {
    Alert.alert(
      "Compost meal",
      `Compost ${title} from your plan? You can add it back later.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Compost",
          style: "destructive",
          onPress: () => {
            LayoutAnimation.configureNext(
              LayoutAnimation.Presets.easeInEaseOut,
            );
            setReviewPlan((prev) =>
              prev
                ? {
                    ...prev,
                    scheduledMeals: prev.scheduledMeals.filter(
                      (m) => m.planItemId !== planItemId,
                    ),
                    unscheduledMeals: prev.unscheduledMeals.filter(
                      (m) => m.planItemId !== planItemId,
                    ),
                  }
                : prev,
            );
            void removeMealFromPlan(planId, planItemId);
          },
        },
      ],
    );
  }

  // ── Add Meals → existing-meal pick (PRD §8.3.8). Lands in the
  //    unscheduled cluster; user can tap a day-pill to schedule.
  //    The planItemId is a stub — WS7 will overwrite with a server
  //    id when the persistence call returns. ──
  function addExistingMealToPlan(meal: MealSummary) {
    const newRow: ReviewPlanMealRow = {
      planItemId: `pi-${Date.now()}`,
      mealId: meal.id,
      title: meal.title,
      thumbnailUrl: meal.imageUrl,
      cuisine: meal.cuisineType,
      metaLine: `${capitalize(meal.difficulty)} · ${meal.estimatedTimeMinutes} min · serves ${meal.servingsDefault}`,
      caloriesPerServing: meal.caloriesPerServing,
      proteinGPerServing: meal.proteinGPerServing,
      carbsGPerServing: meal.carbsGPerServing,
      fatGPerServing: meal.fatGPerServing,
      dayStrip: buildDayStrip(null),
    };
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setReviewPlan((prev) =>
      prev
        ? { ...prev, unscheduledMeals: [...prev.unscheduledMeals, newRow] }
        : prev,
    );
    void addMealToPlan(planId, meal.id);
    setAddMealsVisible(false);
  }
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: 200, // keyboard clearance for bottommost TextInputs
  },
  gateWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing[4],
    gap: Spacing[3],
  },
  gateText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  gateBtnWrap: {
    width: "60%",
  },
  savedPill: {
    backgroundColor: Colors.sage[100],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: Spacing[1],
  },
  savedPillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  draftPill: {
    backgroundColor: Colors.neutral[200],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: Spacing[1],
  },
  draftPillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  draftTitle: {
    fontSize: Typography.fontSize.xxl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
  },
  draftCommitError: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[600],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  // WS9-2 2e Part 4 Item 1 — paddingVertical tightened Spacing[3] (12) → 10 to
  // part-pay for the plan name's own row. HORIZONTAL padding is unchanged: the
  // band's side inset is what keeps it reading as a card rather than a bleed,
  // and narrowing it would push the title toward MORE lines, not fewer.
  //
  // Measured from these style values at a 375pt viewport (band inner width 317,
  // title text width 317 − 8 gap − 14 pencil = 295):
  //   before — max(title 22, pill 32) + 6 + meta 23 = 61 content + 26 chrome = 87
  //   after  — title 22 + 6 + max(meta 23, pill 32) = 60 content + 22 chrome = 82
  //   after, 2-line name — 44 + 6 + 32 = 82 content + 22 chrome = 104
  // So a one-line name is 5px SHORTER than before and a wrapped one is 17px
  // taller. Not flat at two lines, and deliberately not claimed to be: those
  // 17px are the untruncated name, which is the whole point of the item.
  headerBand: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[200],
    paddingHorizontal: Spacing[3],
    paddingVertical: 10,
    gap: Spacing[3],
    marginBottom: Spacing[3],
  },
  headerBandBody: {
    gap: 6,
  },
  // Composted — the plan name as plain text (no editor, no tap target).
  staticPlanName: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  // Composted — the date range, matching the editor trigger's own text
  // treatment so the only difference the user sees is that it isn't tappable.
  staticMetaText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  headerMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  headerDot: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[500],
    fontFamily: Typography.face.sans[400],
  },
  mealCountText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  // Part 3 Item 4 — ONE pill geometry, two skins.
  //
  // ⚠️ The box lives here and NOWHERE else, so the two arms cannot drift apart:
  // a stable footprint across the active/inactive flip is the whole point (the
  // title row must not change height when a plan is activated). Each arm below
  // adds ONLY its fill / border / ink. Both carry a 1px border — transparent on
  // the filled arm — so the outlined arm's border cannot make it taller than
  // the filled one.
  thisWeekPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    flexShrink: 0,
    gap: 6,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  // Part 4 Item 1 — the pill rides the meta strip, hard right. marginLeft:auto
  // rather than justifyContent on the row, because the row's OTHER children
  // (date editor · dot · meal count) must stay packed left against each other;
  // space-between would fan them out. It also survives headerMetaRow's flexWrap
  // — if the strip wraps on a narrow device the pill is still right-aligned on
  // whatever line it lands on.
  thisWeekPillPushRight: {
    marginLeft: "auto",
  },
  thisWeekPillActive: {
    backgroundColor: Colors.sage[600],
    borderColor: Colors.sage[600],
  },
  thisWeekPillInactive: {
    backgroundColor: "transparent",
    borderColor: Colors.sage[400],
  },
  thisWeekPillText: {
    fontSize: Typography.fontSize.sm,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  // Cream on sage[600] — 4.62:1.
  thisWeekPillTextActive: {
    color: Palette.text.onSage,
  },
  // sage[600] on the band's sage[50] tint — 4.70:1.
  thisWeekPillTextInactive: {
    color: Colors.sage[600],
  },
  // The DRAFT commit bar and the COMPOSTED bar. Untouched by Part 3's panel
  // work — direction B restyles the live action panel only.
  actionBar: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    padding: Spacing[3],
    gap: Spacing[2],
  },
  // WS9-2 2e Part 3 (D-WS9-157) — the live action panel, direction B.
  // Deliberately the SAME recipe as s.headerBand directly above it (sage[50]
  // fill, Radius.lg, 1px sage[200], Spacing[3] padding) so the two tinted
  // blocks read as one stacked pair rather than two unrelated surfaces.
  actionPanel: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[200],
    padding: Spacing[3],
    gap: Spacing[2],
  },
  // Per-cell border override for the three UNFILLED cells. Button's `secondary`
  // variant supplies the white surface and the ink label; only the border
  // colour changes, and it changes HERE rather than in the token.
  //
  // ⚠️ Deliberately NOT a retune of Palette.button.secondary.border
  // (neutral[400]) — that token has consumers well beyond this screen, and this
  // is a per-surface composition choice, which is exactly what `style` is for.
  panelCell: {
    borderColor: Colors.sage[400],
  },
  actionRow: {
    flexDirection: "row",
    gap: Spacing[2],
  },
  actionCol: { flex: 1 },
  compostedNote: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  // BUG-092 — the demoted Compost affordance. Follows the app's existing
  // quiet-link shape (app/wizard.tsx cancelLink + cancelText, and the same
  // pattern in deactivate-account / tellkiwi / dish-builder): a Pressable that
  // supplies the tap padding wrapping a small, muted Text.
  //
  // ⚠️ neutral[700], NOT the neutral[600] some of those precedents use.
  // neutral[600] is the LOCKED muted-text token but measures 3.49:1 on this
  // screen's paper background — below AA. neutral[700] is 5.90:1 and still
  // reads as secondary next to the panel above it.
  //
  // No underline: the precedents split on this (grocery-list's unmarkLink
  // underlines, cancelText does not) and an underline would shout for
  // attention, which is the opposite of a demotion.
  compostLink: {
    alignSelf: "flex-end",
    paddingVertical: Spacing[2],
    paddingHorizontal: Spacing[2],
    marginTop: Spacing[1],
  },
  compostLinkText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  // D-WS9-161 — body copy, NOT fine print. Deliberately at the same size and
  // colour role as this file's gateText (fontSize.md / neutral[800] / sans 400),
  // the app's existing "readable sentence on a card" treatment: 10.27:1 on the
  // card's white surface, well past AA 4.5:1 at 15px.
  //
  // Written as its own entry rather than aliasing s.gateText so that retuning
  // the load/error gate copy can never silently restyle this line — the two are
  // unrelated surfaces that happen to share a treatment.
  draftCustomizableNote: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 21,
    textAlign: "center",
    marginTop: Spacing[1],
  },
  section: {
    marginTop: Spacing[4],
  },
  dietaryNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
    backgroundColor: Colors.gold.background,
    borderRadius: Radius.lg,
    padding: Spacing[3],
  },
  dietaryNoteText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.gold.text,
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  prepBadge: {
    alignSelf: "flex-start",
    backgroundColor: Colors.sage[100],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[3],
    paddingVertical: 6,
  },
  prepBadgeText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  cardTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  noteRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
  },
  noteText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  macroRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: Spacing[2],
  },
  macroStat: { alignItems: "center", flex: 1 },
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
  },
  macroFootnote: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[2],
    lineHeight: 16,
  },
  sectionHeader: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[2],
  },
  subSectionHeader: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginTop: Spacing[4],
    marginBottom: Spacing[2],
  },
  placeholder: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    paddingVertical: Spacing[4],
    textAlign: "center",
  },
  emptyMeals: {
    alignItems: "center",
    gap: Spacing[3],
    paddingVertical: Spacing[5],
  },
  emptyMealsText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  collapseHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[3],
  },
  collapseTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  collapseInput: {
    marginTop: Spacing[2],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[3],
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    minHeight: 60,
  },
});
