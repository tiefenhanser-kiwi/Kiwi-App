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
import { ChangeMealSheet } from "@/components/ChangeMealSheet";
import { FindSimilarSheet } from "@/components/FindSimilarSheet";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { LoadingShim } from "@/components/LoadingShim";
import { PlanDateRangeEditor } from "@/components/PlanDateRangeEditor";
import { PlanNameEditor } from "@/components/PlanNameEditor";
import { PlanReviewMealRow } from "@/components/PlanReviewMealRow";
import { Toast } from "@/components/Toast";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useApp } from "@/contexts/AppContext";
import { useMeal } from "@/hooks/useMeal";
import { usePlan } from "@/hooks/usePlan";
import { ApiError } from "@/lib/api/errors";
import { buildDayStrip } from "@/lib/domain";
import { formatMacro } from "@/lib/format/macros";
import { generateGroceryListForPlan } from "@/lib/api/grocery";
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
} from "@/lib/plans/reviewPlanAdapter";
import { wizardExpandedPlanToReviewPlan } from "@/lib/plans/wizardDraftReviewAdapter";
import { decidePlanDetailsCta } from "@/lib/plans/wizardPostSaveCta";
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
    isMacrosRecalcInFlight,
  } = useApp();

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

    console.log("[plan/id] addMealId consumed, meal injected", {
      addMealId,
      title: injectMealQuery.data.title,
    });
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
      setToast({ message: "Couldn't add that meal." });
    }
  }, [injectMealQuery.isError, injectMealQuery.error, addMealId]);

  // Sheet state for §8.4.2 Change Meal flow.
  const [changeMealForRow, setChangeMealForRow] = useState<{
    planItemId: string;
    currentMealId: string;
  } | null>(null);

  // Sheet state for §8.4.x Find Similar flow (WS5 amendment).
  const [findSimilarForRow, setFindSimilarForRow] = useState<{
    planItemId: string;
    sourceMealId: string;
    sourceMealTitle?: string;
    sourceCuisine?: string;
  } | null>(null);

  // Sheet state for §8.3.8 Add Meals flow.
  const [addMealsVisible, setAddMealsVisible] = useState(false);

  // WS9 3d Part 1 — the screen's single toast slot. Replaces the Ruling-9
  // Alert fallback (Part 1b) and hosts the Compost-undo (Part 3a) and demotion
  // (Part 3c) toasts. Each entry carries its own onDismiss (fired on timeout /
  // dismiss-without-action) and optional onAction (Undo) so a deferred-
  // destructive caller can distinguish "expired → commit" from "user undid".
  const [toast, setToast] = useState<{
    message: string;
    actionLabel?: string;
    onAction?: () => void;
    onDismiss?: () => void;
  } | null>(null);

  const planName = reviewPlan?.name || "Untitled plan";

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
    console.log("[plan-review] add-meals tapped", { planId });
    setAddMealsVisible(true);
  };

  // WS6 6c-4 Block C — smart grocery list generation. Block B's two-AI-call
  // pipeline (Haiku gap-fill + Sonnet polish) can take 5-15s in the wild;
  // the button shows its loading state for the full duration and guards
  // against double-taps. 409 (list_exists) and 200 (success) both route to
  // the grocery list screen — same UX from the user's perspective.
  const [isGeneratingList, setIsGeneratingList] = useState(false);
  const handleGroceryListPress = async () => {
    if (isGeneratingList) return;
    console.log("[plan-review] grocery-list tapped", { planId });
    setIsGeneratingList(true);
    try {
      const result = await generateGroceryListForPlan(planId);
      if (result.success) {
        router.push({
          pathname: "/grocery-list/[id]",
          params: { id: result.groceryListId },
        });
      } else if (result.error === "list_exists") {
        router.push({
          pathname: "/grocery-list/[id]",
          params: { id: result.existingListId },
        });
      } else if (result.error === "ai_failed") {
        Alert.alert(
          "Could not generate list",
          "Our AI hit a hiccup. Please try again in a moment.",
        );
      } else if (result.error === "plan_not_found") {
        Alert.alert(
          "Plan not found",
          "We couldn't find this plan. Try reloading.",
        );
      } else if (result.error === "unauthenticated") {
        Alert.alert("Sign-in required", "Please sign in and try again.");
      } else {
        Alert.alert("Could not generate list", "Please try again in a moment.");
      }
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
  const handleCookThisWeek = () => {
    setReviewPlan((prev) =>
      prev ? { ...prev, isActiveThisWeek: true } : prev,
    );
    void setPlanActiveThisWeek(planId);
  };

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
        <View style={s.planMetaSection}>
          {/* Draft: name is fixed (the candidate title) and there is no week
              yet — no name/date editors, no Cook This Week chip (the action bar
              owns the commit). Saved: the full editable meta strip. */}
          {isDraft ? (
            <Text style={s.draftTitle}>{planName}</Text>
          ) : (
            <>
              <PlanNameEditor
                currentName={planName}
                onSave={handleSavePlanName}
              />
              <PlanDateRangeEditor
                startDate={reviewPlan.weekStartDate}
                endDate={reviewPlan.weekEndDate}
                onSave={handleSaveDateRange}
              />
              {/* WS7-6 (E) Block 2 §4 — Cook This Week chip. Lives in the meta
                  strip (NOT the §8.3.2 action bar). When this plan IS the
                  winner: passive "This Week's Plan" badge. Otherwise: tappable
                  chip activates the plan (resolver demotes prior winner). */}
              {reviewPlan.isActiveThisWeek ? (
                <View style={s.cookThisWeekBadge}>
                  <Feather name="check" size={12} color={Colors.sage[700]} />
                  <Text style={s.cookThisWeekBadgeText}>This Week's Plan</Text>
                </View>
              ) : (
                <Pressable
                  onPress={handleCookThisWeek}
                  hitSlop={6}
                  style={({ pressed }) => [
                    s.cookThisWeekChip,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Feather
                    name="calendar"
                    size={12}
                    color={Colors.neutral[100]}
                  />
                  <Text style={s.cookThisWeekChipText}>Cook This Week</Text>
                </Pressable>
              )}
            </>
          )}
        </View>

        {/* §8.3.2 — Sticky-near-top action bar. ONE component, TWO states
            (D-WS9-032 point 4), driven by saved-state: an unsaved draft shows
            Save for Later / Use This Week; a saved plan shows the real actions
            and never re-offers the save options. */}
        {isDraft ? (
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
          </View>
        ) : (
          <View style={s.actionBar}>
            <Button
              label="Prep and Cook"
              variant="primary"
              onPress={() => {
                console.log("[plan-review] prep-and-cook tapped", { planId });
                // WS7-8b B2 — plan-context entry: land on the Hub for this plan.
                router.push({ pathname: "/prep-cook", params: { id: planId } });
              }}
            />
            <View style={s.actionRow}>
              <View style={s.actionCol}>
                <Button
                  label="Get Groceries Online"
                  variant="primary"
                  onPress={() => {
                    console.log("[plan-review] get-groceries-online tapped", {
                      planId,
                    });
                    Alert.alert(
                      "Coming in WS6 — retailer integration",
                      "Online ordering requires the retailer adapter pattern from PRD §12.12.",
                    );
                  }}
                />
              </View>
              <View style={s.actionCol}>
                <Button
                  label={isGeneratingList ? "Generating…" : "Grocery List"}
                  variant="ghost"
                  loading={isGeneratingList}
                  onPress={handleGroceryListPress}
                />
              </View>
            </View>
          </View>
        )}

        {/* §8.3.2 (cont.) — single Add Meals affordance. On a draft it's
            guarded (point 6): adding a meal requires saving first. */}
        <View style={s.addMealsWrap}>
          <Button
            label="Add Meals"
            variant="ghost"
            onPress={isDraft ? showDraftEditGuard : onAddMeals}
          />
        </View>

        {/* §8.3.3 — Prep status indicator (hidden on a draft — prep is a
            saved-plan concept). */}
        {!isDraft && (
        <View style={s.section}>
          {reviewPlan.prepStatus === "not_prepped" ? (
            <View style={s.prepBanner}>
              <Feather name="zap" size={16} color={Colors.sage[700]} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={s.prepBannerText}>
                  Prep these meals with Kiwi to save time during the week
                </Text>
                <Pressable
                  onPress={() => {
                    console.log("[plan-review] start-prep tapped", { planId });
                  }}
                  hitSlop={8}
                >
                  <Text style={s.prepLink}>Start Prep</Text>
                </Pressable>
              </View>
            </View>
          ) : reviewPlan.prepStatus === "prepped" ? (
            <View style={s.prepBadge}>
              <Text style={s.prepBadgeText}>Prepped this week ✓</Text>
            </View>
          ) : (
            <View style={s.prepBadge}>
              <Text style={s.prepBadgeText}>Prepped (mostly) ✓</Text>
            </View>
          )}
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
                  readOnly={isDraft}
                  onReadOnlyEdit={showDraftEditGuard}
                  onChangeMeal={(planItemId, currentMealId) =>
                    setChangeMealForRow({ planItemId, currentMealId })
                  }
                  onFindSimilar={(planItemId, sourceMealId, title) => {
                    setFindSimilarForRow({
                      planItemId,
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
                  {reviewPlan.unscheduledMeals.map((row) => (
                    <PlanReviewMealRow
                      key={row.planItemId}
                      row={row}
                      planId={planId}
                      readOnly={isDraft}
                      onReadOnlyEdit={showDraftEditGuard}
                      onChangeMeal={(planItemId, currentMealId) =>
                        setChangeMealForRow({ planItemId, currentMealId })
                      }
                      onFindSimilar={(planItemId, sourceMealId, title) => {
                        setFindSimilarForRow({
                          planItemId,
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
            Hidden on a draft: these are per-plan overrides that only make sense
            once the plan is saved. */}
        {!isDraft && (
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

      <ChangeMealSheet
        visible={changeMealForRow !== null}
        currentMealId={changeMealForRow?.currentMealId ?? ""}
        onClose={() => setChangeMealForRow(null)}
        onPickReplacement={(newMeal) => {
          if (!changeMealForRow) return;
          applyMealReplacement(changeMealForRow.planItemId, newMeal);
          setChangeMealForRow(null);
        }}
      />

      <FindSimilarSheet
        visible={findSimilarForRow !== null}
        sourceMealId={findSimilarForRow?.sourceMealId ?? ""}
        sourceMealTitle={findSimilarForRow?.sourceMealTitle}
        sourceCuisine={findSimilarForRow?.sourceCuisine}
        onClose={() => setFindSimilarForRow(null)}
        onPickReplacement={(newMeal) => {
          if (!findSimilarForRow) return;
          applyMealReplacement(findSimilarForRow.planItemId, newMeal);
          setFindSimilarForRow(null);
        }}
      />

      <AddMealsSheet
        visible={addMealsVisible}
        planId={planId}
        onClose={() => setAddMealsVisible(false)}
        onPickExistingMeal={addExistingMealToPlan}
      />

      {/* WS9 3d Part 1 — single toast slot (informational + Undo variants). */}
      <Toast
        visible={toast !== null}
        message={toast?.message ?? ""}
        actionLabel={toast?.actionLabel}
        onAction={
          toast?.onAction
            ? () => {
                const act = toast.onAction!;
                setToast(null);
                act();
              }
            : undefined
        }
        onDismiss={() => {
          const dismiss = toast?.onDismiss;
          setToast(null);
          dismiss?.();
        }}
      />
    </View>
  );

  // ── Optimistic-update helper shared by Change Meal (5J) and Find
  //    Similar (5K-bis). Both repoint planItem.mealId to a different
  //    Meal record and refresh the row's display copy + macros. The
  //    AppContext mutator stays log-only until WS7. ──
  function applyMealReplacement(
    targetPlanItemId: string,
    newMeal: MealSummary,
  ) {
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
    void changeMealForPlanItem(planId, targetPlanItemId, newMeal.id);
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
  planMetaSection: {
    gap: 4,
    marginBottom: Spacing[3],
  },
  cookThisWeekChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    borderRadius: Radius.full,
    backgroundColor: Colors.sage[700],
    marginTop: Spacing[1],
  },
  cookThisWeekChipText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[100],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  cookThisWeekBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.sage[700],
    backgroundColor: Colors.sage[100],
    marginTop: Spacing[1],
  },
  cookThisWeekBadgeText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  actionBar: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    padding: Spacing[3],
    gap: Spacing[2],
  },
  actionRow: {
    flexDirection: "row",
    gap: Spacing[2],
  },
  actionCol: { flex: 1 },
  addMealsWrap: {
    marginTop: Spacing[2],
  },
  section: {
    marginTop: Spacing[4],
  },
  prepBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
  },
  prepBannerText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  prepLink: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
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
