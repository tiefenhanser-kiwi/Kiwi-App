import React, { useEffect, useRef, useState } from "react";
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
import { usePlanWrite } from "@/hooks/usePlanWrite";
import { ApiError } from "@/lib/api/errors";
import { buildDayStrip } from "@/lib/domain";
import { formatMacro } from "@/lib/format/macros";
import { generateGroceryListForPlan } from "@/lib/api/grocery";
import { dispatchGenerateResult } from "@/lib/groceryHandoff";
import {
  mealDetailToRow,
  planDetailToReviewPlan,
  sortUnscheduledNewestFirst,
} from "@/lib/plans/reviewPlanAdapter";
import {
  addItemToDetail,
  applyDayAssignmentToDetail,
  buildOptimisticPlanItem,
  removeItemFromDetail,
  repointItemIdInDetail,
  replaceItemMealInDetail,
  setPlanActiveThisWeekInDetail,
  setPlanDateRangeInDetail,
  setPlanNameInDetail,
} from "@/lib/plans/planDetailOptimistic";
import {
  demotionToastMessage,
  needsActiveCompostConfirm,
} from "@/lib/plans/planLifecycleActions";
import { planReviewState, planReviewSurface } from "@/lib/plans/planReviewSurface";
import { formatPlanDateRange } from "@/lib/cooking/hubModel";
import type {
  DayOfWeek,
  MealSummary,
  ReviewPlan,
  ReviewPlanMealRow,
} from "@/lib/types";

// D-WS9-191 §4.7 / lane-pfc Part C.3 — the unsaved-draft branch (D-WS9-032
// Option A: `?draftId=&expanded=` params, the Draft pill, the Save for Later /
// Use This Week commit bar, the edit guard, the 90s activate ceiling and the
// 404/409 recoveries) is GONE from this screen. A plan is only ever reviewed
// here AFTER it is saved; the chooser (app/plan-options.tsx) owns save /
// activate on a candidate. Nothing routes here with a draftId any more — the
// only builder of those params was lib/wizard/openDraftPlanRoute.ts, deleted
// in the same part.

// Android requires opt-in for LayoutAnimation. One-time global flag —
// this is the only file that opts in today; safe no-op if set elsewhere.
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// WS9-2 2e Part 3 — action-panel cell icon size. 18 is the app's most common
// in-control Feather size (16 of 41 call sites across app/ + components/,
// including PlanCardOverflowMenu's sheet items), so the panel inherits the
// existing sizing convention rather than introducing a new one.
const PANEL_ICON_SIZE = 18;

// BUG-104 — the local applyDayAssignment(ReviewPlan) helper was REMOVED here.
// Its superseded reasoning, kept because it explains why the replacement lives
// where it does: it rewrote the row's dayStrip and moved the row between the
// scheduled / unscheduled clusters, and the caller wrapped it in setReviewPlan.
// That made component state the home of optimism — and the day pill then read
// its NEXT value back out of that same state, so any GET landing mid-write
// produced a wrong write rather than a stale render. The equivalent transform
// is now applyDayAssignmentToDetail in lib/plans/planDetailOptimistic.ts: it
// edits the PlanDetail in the query cache and lets planDetailToReviewPlan
// re-derive both the dayStrip and the cluster split.

export default function PlanReviewScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id, addMealId } = useLocalSearchParams<{
    id: string;
    addMealId?: string;
  }>();
  const planId = id ?? "";
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
  const planQuery = usePlan(planId);
  // BUG-104 — every plan write on this screen goes through here: cancel the
  // in-flight detail GET, apply the optimistic edit to the CACHE, roll the
  // cache back on failure, and invalidate once when the burst of writes drains.
  const planWrite = usePlanWrite(planId);
  // reviewPlan starts null and is seeded by the effect once planQuery resolves.
  const [reviewPlan, setReviewPlan] = useState<ReviewPlan | null>(null);

  useEffect(() => {
    if (planQuery.data) {
      setReviewPlan(planDetailToReviewPlan(planQuery.data));
    }
  }, [planQuery.data]);

  // WS9 3e Part 3 (D-WS9-090 guard) — composted (soft-deleted) plan. Read
  // straight off the server payload: compost is terminal (no optimistic
  // mutation flips it back). Drives the composted action-bar branch below.
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
      const action = dispatchGenerateResult(result, {
        // 200-new and 409-exists both land here — same destination, because
        // the user asked for this plan's list and gets this plan's list.
        navigate: (id) =>
          router.push({ pathname: "/grocery-list/[id]", params: { id } }),
        alert: (title, message) => Alert.alert(title, message),
      });
      // BUG-111 — a successful generate used to invalidate NOTHING. The
      // Groceries tab's useRefetchOnFocus is gated on isStale and the default
      // staleTime is 60s, so a user who generated a list and switched tabs
      // within a minute did not see it; Home carries activePlan.groceryListId
      // and was equally stale. Gated on the navigate outcome (a list really
      // exists) so an error alert does not trigger two pointless refetches.
      if (action.kind === "navigate") {
        queryClient.invalidateQueries({ queryKey: ["groceries"] });
        queryClient.invalidateQueries({ queryKey: ["home"] });
      }
    } finally {
      setIsGeneratingList(false);
    }
  };

  // BUG-104 / BUG-112 — optimism moved into the query cache (planWrite) and the
  // rejection is caught. Previously these set local state and fired the mutator
  // as a bare `void`: a failed PATCH left the edit on screen with nothing to
  // reconcile it, and the rejection surfaced as an uncaught-in-promise.
  const handleSavePlanName = (newName: string) => {
    void planWrite
      .write(
        (prev) => setPlanNameInDetail(prev, newName),
        () => updatePlanName(planId, newName),
      )
      .catch(() => {
        showToast({ message: "Couldn't rename that plan. Please try again." });
      });
  };

  const handleSaveDateRange = (start: string, end: string) => {
    void planWrite
      .write(
        (prev) => setPlanDateRangeInDetail(prev, start, end),
        () => updatePlanDateRange(planId, { startDate: start, endDate: end }),
      )
      .catch(() => {
        showToast({ message: "Couldn't update those dates. Please try again." });
      });
  };

  // WS7-6 (E) Block 2 §4 — Model 2 activation. Optimistically flip the
  // local chip state so the tap feels instant; the post-mutation refetch
  // re-seeds reviewPlan from the server's resolver-derived value.
  // WS9 3d Part 3c (D-WS9-011a) — when this activation displaces a prior
  // this-week plan, the server response names it; show the informational
  // demotion toast (no confirm — friction priority).
  const handleCookThisWeek = () => {
    void planWrite
      .write(
        (prev) => setPlanActiveThisWeekInDetail(prev, true),
        () => setPlanActiveThisWeek(planId),
      )
      .then(({ demoted }) => {
        const message = demotionToastMessage(planName, demoted);
        if (message) showToast({ message });
      })
      .catch(() => {
        // BUG-104 — the runner has already rolled the cache back to pre-flip and
        // scheduled the reconciling refetch, so the chip un-flips on its own.
        // Previously the optimistic flip STAYED on a failure and only a focus
        // refetch corrected it, so the plan read as active when it was not.
        showToast({ message: "Couldn't set this week's plan. Please try again." });
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
  // draft + null-commit cases); the client only renders.
  const showDietaryNote = planQuery.data?.dietaryStale ?? false;

  // Block B gate (WS7-3 C4 c1) — server load, error, or adapter-not-yet-seeded
  // states render a loading / error frame. The error branch distinguishes 404
  // (plan not owned / missing) from generic load failure per the same pattern
  // app/dish/[id].tsx adopted in C3 c3.
  if (planQuery.isLoading || (!reviewPlan && !planQuery.isError)) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title="Plan Review" />
        <View style={s.gateWrap}>
          <LoadingShim variant="screen" />
        </View>
      </View>
    );
  }

  if (planQuery.isError || !reviewPlan) {
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

  // The load/error gates above return when reviewPlan is null, so it is
  // non-null here — this narrows it for TS.
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
  // a pile of inline `isComposted ? … : …` ternaries: app/ is outside
  // the test glob, and the inline form is precisely how D-WS9-090's composted
  // guard came to cover the action bar and nothing else. The table is pinned by
  // lib/plans/__tests__/planReviewSurface.test.ts — but only while the screen
  // keeps consuming it. Do not re-derive these locally.
  const state = planReviewState({
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
      {/* §8.3.1 — Header with back button, page label, and the passive "Saved"
          pill (a plan is only reviewed here once it is in the library). Plan
          name + date range live in the editable meta strip below the header
          (PRD §8 / §11). */}
      <Header
        showBack
        title="Plan Review"
        rightContent={
          <View style={s.savedPill}>
            <Text style={s.savedPillText}>Saved</Text>
          </View>
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
          {/* Two presentations of the same identity, chosen by the surface
              table: a composted plan's plain read-only text, or the live
              editable meta strip. */}
          {surface.headerBand === "staticMeta" ? (
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
                        color={Colors.sage[700]}
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

        {/* §8.3.2 — Sticky-near-top action bar, driven by the surface table. */}
        {surface.showCompostedBar ? (
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
          /* WS9-2 2e Part 3 (D-WS9-157 + D-WS9-162) — panel direction B, as
             amended by Part 4 Item 2.
             ONE symmetric 2×2 group on a SAGE-TINTED panel, replacing the flat
             white card. "Basically like an action/control panel for the plan."

             ⚠️ THIS SCREEN NOW HAS ZERO TERRACOTTA FILLS. That is the amendment
             and it is intended, not an oversight. Part 3 made Prep and Cook a
             terracotta FILL and called it "the only fill on this screen"; a
             solid terracotta[400] block inside a tinted panel reads as the
             loudest object on the page and flattens the panel's own tint
             underneath it. The primary is now carried by TINT — pale surface,
             full-strength edge, dark ink (Button variant="tint"). Do not add a
             fill back to satisfy the earlier wording.

             The four cells stay symmetric in GEOMETRY (same grid, same size,
             same icon size) while the primary carries the tint. Symmetry of
             layout, not of emphasis.

             ⚠️ Part 4 Item 2 — Compost is back INSIDE the panel, but as the
             quiet corner LINK BUG-092 made it, not as a fifth cell. Do not
             promote it back to a Button.

             ⚠️ The panel REUSES the shared Button rather than hand-rolling
             cells: `iconLeft` for the Feather glyph, `variant="tint"` for the
             primary, and a per-cell `style` border override for the other three.
             Do not fork a bespoke Pressable here (§27.2). */
          <View style={s.actionPanel}>
            <View style={s.actionRow}>
              <View style={s.actionCol}>
                <Button
                  label="Prep and Cook"
                  variant="tint"
                  size="sm"
                  iconLeft={
                    <Feather
                      name="play"
                      size={PANEL_ICON_SIZE}
                      color={Palette.button.tint.text}
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
                      color={Colors.terracotta[400]}
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
                      color={Colors.terracotta[400]}
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
                      color={Colors.terracotta[400]}
                    />
                  }
                  onPress={onAddMeals}
                />
              </View>
            </View>

            {/* The panel's FOOTER ROW — status on the left, the quiet
                destructive link on the right.

                Part 4 fix pass Item 2 — the prepped badge moved in here from
                the strip between the panel and the cards below, where it read
                as unattached to anything. It is STATE, not an action: bottom
                left, opposite Compost, in a warm neutral so it cannot be
                mistaken for a fifth cell.

                ⚠️ Compost keeps marginLeft:auto rather than the row's
                justifyContent, so it stays hard right whether or not the badge
                renders beside it. Its position is unchanged in both cases. */}
            <View style={s.panelFooterRow}>
              {/* §8.3.3 — Prep status indicator (positive states only).

                  D-WS9-133: the not_prepped "Start Prep" banner was removed
                  entirely — its handler was a dead console.log and the live
                  prep entry is the "Prep and Cook" cell above. Only the
                  positive prepped / partial badges remain. */}
              {reviewPlan.prepStatus !== "not_prepped" ? (
                <View style={s.prepBadge}>
                  <Text style={s.prepBadgeText}>
                    {reviewPlan.prepStatus === "prepped"
                      ? "Prepped this week ✓"
                      : "Prepped (mostly) ✓"}
                  </Text>
                </View>
              ) : null}

              {/* BUG-092 — Compost is a quiet right-aligned text LINK, not a
                cell. As a Button it rendered full width (Button.fullWidth
                defaults true, and size="sm" only shrinks height and type, not
                the stretch), so the one control ruled "visually smaller" was
                the widest thing in the panel — the exact opposite of its
                intended weight.

                Part 4 Item 2 — it moves back INSIDE the panel, bottom-right,
                below the 2×2 grid. It is a plan-level action like the other
                four, and sitting outside the panel made it read as belonging to
                whatever came next down the page. It stays a LINK: the demotion
                BUG-092 bought is the point, and re-promoting it to a cell would
                undo that. Muted neutral ink, NOT terracotta — a destructive
                tint would make it the loudest thing on the screen.

                ⚠️ neutral[700] now sits on the panel's sage[100] rather than on
                paper: 5.06:1, down from 5.90:1 but still past AA 4.5:1.

                ⚠️ BEHAVIOUR IS BYTE-UNCHANGED — same handler, so the
                active-plan confirm (needsActiveCompostConfirm) and the
                deferred-delete undo toast (compostWithUndo) are both still
                wired. Render condition is unchanged too: it was gated on
                showActionPanel and is now a child of the panel that flag
                renders, which is the same condition expressed structurally. */}
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
            </View>
          </View>
        ) : null}

        {/* ⚠️ §8.3.3's prep badge USED TO SIT HERE, in its own s.section between
            the action panel and the cards below. It moved INSIDE the panel's
            footer row (Part 4 fix pass Item 2) — as a free-standing chip out
            here it read as unattached to anything, since the panel above it
            owns the plan's actions and the card below it owns the numbers. Its
            render condition travelled with it, unchanged. */}

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
                  // A composted plan has nothing to explain and no action to
                  // offer, so no onReadOnlyEdit handler: the row is genuinely
                  // INERT — onReadOnlyEdit?.() no-ops.
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
                  <Text style={s.subSectionHeader}>Unscheduled</Text>
                  {unscheduledSorted.map((row) => (
                    <PlanReviewMealRow
                      key={row.planItemId}
                      row={row}
                      planId={planId}
                      readOnly={surface.rowsReadOnly}
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
            Hidden, as of D-WS9-159, on a composted plan: "genuinely
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
              placeholderTextColor={Palette.text.placeholder}
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
              placeholderTextColor={Palette.text.placeholder}
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
  //    BUG-104 — this handler already had the right SHAPE (snapshot →
  //    optimistic → rollback → toast); it just kept its snapshot in component
  //    state, where an in-flight GET could land between the optimistic write
  //    and the rollback and make the rollback restore a payload that had itself
  //    already been clobbered. It now runs on the shared cache-backed runner,
  //    so the snapshot, the rollback and the id repoint are all cache-level and
  //    the burst-wide invalidation is deferred until the last write settles.
  //    The explicit `planQuery.refetch()` is gone because the runner's
  //    invalidate does it — and does it ONCE per burst rather than per failure.
  async function applyMealReplacement(
    targetPlanItemId: string,
    newMeal: MealSummary,
  ) {
    try {
      const { newPlanItemId } = await planWrite.write(
        (prev) => replaceItemMealInDetail(prev, targetPlanItemId, newMeal),
        () => changeMealForPlanItem(planId, targetPlanItemId, newMeal.id),
      );
      // Converge the row's id to the server's freshly-created item so the next
      // swap on this row targets a live id, not the deleted one.
      planWrite.patchCache((prev) =>
        repointItemIdInDetail(prev, targetPlanItemId, newPlanItemId),
      );
    } catch {
      showToast({ message: "Couldn't swap that meal. Please try again." });
    }
  }

  // ── Day-pill tap (PRD §8.3.6). null = unassign. Configures the
  //    next layout pass so the row's move between scheduled and
  //    unscheduled clusters animates rather than snaps. ──
  //    BUG-104 — optimism now lands in the QUERY CACHE, not in `reviewPlan`.
  //    The mirror is re-seeded wholesale from planQuery.data, so local-state
  //    optimism was erased by any GET that resolved mid-write — and because the
  //    day pill computes its next value from that mirror
  //    (`row.dayStrip.find(d => d.isAssigned)`), a clobbered mirror produced a
  //    WRONG WRITE, not merely a display revert. Server UserActivity showed
  //    four A→B→A oscillations with each PATCH's `from` equal to the previous
  //    `to`. Writing through the cache makes the mirror a pure derivation of
  //    something already correct.
  //
  //    BUG-112 — the rejection is caught and surfaced. It was two bare `void`
  //    calls, so a failed PATCH left the pill looking assigned with nothing to
  //    reconcile it and the rejection went uncaught-in-promise.
  function handleAssignDay(planItemId: string, newDay: DayOfWeek | null) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    void planWrite
      .write(
        (prev) => applyDayAssignmentToDetail(prev, planItemId, newDay),
        () =>
          newDay === null
            ? unassignDayFromPlanItem(planId, planItemId)
            : assignDayToPlanItem(planId, planItemId, newDay),
      )
      .catch(() => {
        showToast({ message: "Couldn't move that meal. Please try again." });
      });
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
            // BUG-104 / BUG-112 — cache-backed optimism + a caught rejection.
            // A failed remove used to leave the row gone from the screen while
            // it still existed on the server.
            void planWrite
              .write(
                (prev) => removeItemFromDetail(prev, planItemId),
                () => removeMealFromPlan(planId, planItemId),
              )
              .catch(() => {
                showToast({
                  message: "Couldn't compost that meal. Please try again.",
                });
              });
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
    // BUG-104 — the optimistic row is built as a PlanDetailItem and written to
    // the cache, so the adapter derives the ReviewPlan row from it exactly as
    // it will derive the real one after the refetch. Same stub-id invention as
    // before, one layer down.
    const stubItem = buildOptimisticPlanItem(meal, `pi-${Date.now()}`);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    void planWrite
      .write(
        (prev) => addItemToDetail(prev, stubItem),
        () => addMealToPlan(planId, meal.id),
      )
      .catch(() => {
        showToast({ message: "Couldn't add that meal. Please try again." });
      });
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
  // ⚠️ Part 4 Item 2 — sage[50] → sage[100], FOLLOWING the action panel below
  // it. Part 3 made the band and the panel a deliberate byte-copy of each other
  // so the two tinted blocks read as one stacked pair; deepening only the panel
  // would leave them 1.16:1 apart, which is the worst available outcome — too
  // close to read as hierarchy, far enough to read as a rendering bug.
  headerBand: {
    backgroundColor: Colors.sage[100],
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
  // ⚠️ Part 4 Item 2 — sage[400] → sage[500], forced by the band going sage[100].
  // The outline measured 2.45:1 on sage[50] and would have DROPPED to 2.19:1 on
  // the deeper tint; sage[500] restores it to 3.29:1, which is the first value
  // in the scale that clears the 3:1 non-text bar on this surface. Not a
  // free-standing restyle — the same number the panel's cell borders take, for
  // the same reason, on the same background.
  thisWeekPillInactive: {
    backgroundColor: "transparent",
    borderColor: Colors.sage[500],
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
  // ⚠️ Part 4 Item 2 — sage[600] → sage[700], forced by the band going sage[100].
  // sage[600] measured 4.70:1 on sage[50] and falls to 4.20:1 on sage[100],
  // which is BELOW AA for this 12px label. sage[700] is 6.92:1. Deepening the
  // band without this would have shipped a text-contrast regression caused by a
  // colour change made two styles away.
  thisWeekPillTextInactive: {
    color: Colors.sage[700],
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
  // Deliberately the SAME recipe as s.headerBand directly above it (Radius.lg,
  // 1px sage[200], Spacing[3] padding) so the two tinted blocks read as one
  // stacked pair rather than two unrelated surfaces. If one moves, the other
  // moves — Part 4 Item 2 deepened both together for exactly that reason.
  //
  // ⚠️ Part 4 Item 2 — sage[50] → sage[100]. The panel is the frame the cells
  // are read against, and against sage[50] a white cell separated by only
  // 1.28:1; at sage[100] it is 1.24:1 on the surface alone, so the CELL BORDER
  // is what carries the boundary — which is why it moves in the same breath.
  actionPanel: {
    backgroundColor: Colors.sage[100],
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
  //
  // ⚠️ Part 4 Item 2 — sage[400] → sage[500]. Part 3 shipped sage[400] believing
  // it measured 3.1:1 against the panel; it was 2.45:1 on sage[50] and would be
  // 2.19:1 on sage[100] — below the 3:1 non-text bar on both. sage[500] is
  // 3.29:1 against the sage[100] panel (outer edge) and 4.09:1 against the
  // cell's own white surface (inner edge). A border has two sides and both have
  // to clear the bar; sage[500] is the first stop in the scale that does.
  panelCell: {
    borderColor: Colors.sage[500],
  },
  actionRow: {
    flexDirection: "row",
    gap: Spacing[2],
  },
  actionCol: { flex: 1 },
  compostedNote: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  // BUG-092 — the demoted Compost affordance. Follows the app's existing
  // quiet-link shape (app/wizard.tsx cancelLink + cancelText, and the same
  // pattern in deactivate-account / tellkiwi / dish-builder): a Pressable that
  // supplies the tap padding wrapping a small, muted Text.
  //
  // ⚠️ neutral[700], NOT the neutral[600] some of those precedents use.
  // neutral[600] is the LOCKED muted-text token but measures 3.49:1 on this
  // screen's paper background — below AA.
  //
  // ⚠️ Part 4 Item 2 — the link now sits INSIDE the panel, so its background is
  // sage[100], not paper: neutral[700] measures 5.06:1 there (it was 5.90:1 on
  // paper, and that figure in this comment was stale the moment it moved).
  // Still past AA 4.5:1, and still reads as secondary next to the cells.
  //
  // No underline: the precedents split on this (grocery-list's unmarkLink
  // underlines, cancelText does not) and an underline would shout for
  // attention, which is the opposite of a demotion.
  //
  // Geometry: marginTop is GONE — the panel's own `gap: Spacing[2]` now supplies
  // the separation from the grid, and keeping both would double it. Padding is
  // tightened so the link sits in the panel's corner rather than floating in
  // it; hitSlop={12} at the call site keeps the tap target honest.
  // ⚠️ Part 4 fix pass Item 2 — alignSelf:"flex-end" → marginLeft:"auto". The
  // link now shares a ROW with the prepped badge, where a cross-axis alignSelf
  // no longer pushes it right. marginLeft:auto is the main-axis equivalent and
  // holds it hard right whether or not the badge renders. Rendered position is
  // unchanged in both cases; padding, ink and hit target are untouched.
  compostLink: {
    marginLeft: "auto",
    paddingVertical: 6,
    paddingHorizontal: Spacing[1],
  },
  compostLinkText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
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
  // Part 4 fix pass Item 2 — RE-TREATED as a warm-neutral status marker, because
  // it now lives inside the sage[100] action panel.
  //
  // ⚠️ IT WAS sage[100] ON sage[100] — 1.00:1. Moving it in without re-treating
  // it would have made the chip literally invisible: same token, same surface.
  //
  // ⚠️ THE BORDER IS DOING ALL THE WORK, and that is why it is stronger than the
  // action cells'. Measured against the panel: this chip's neutral[200] surface
  // is 1.04:1, where the cells' white is 1.24:1 — the surface contributes
  // essentially nothing, so the outline is the only thing defining the shape.
  //
  // ⚠️ neutral[600] was REJECTED at 2.9966:1 — it rounds to "3.00" and reads as
  // passing, but it is under the 3:1 non-text bar. neutral[700] is 5.06:1
  // against the panel and 5.26:1 against the chip's own fill, and it is the same
  // ink as the Compost link sharing this row, so the footer reads as one quiet
  // neutral band beneath the sage cells rather than as a second palette.
  //
  // Hue keeps it out of the fight: warm neutral, no sage (the cells), no
  // terracotta (the tinted primary), no gold (this screen's warning banner).
  // Text neutral[800] on neutral[200] is 8.58:1.
  prepBadge: {
    alignSelf: "flex-start",
    backgroundColor: Colors.neutral[200],
    borderWidth: 1,
    borderColor: Colors.neutral[700],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[3],
    paddingVertical: 5,
  },
  prepBadgeText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  // Status left, destructive link right. `justifyContent` is deliberately NOT
  // used: the badge is conditional, and space-between would slide Compost to
  // the left edge on every plan that has not been prepped. compostLink's
  // marginLeft:auto pins it right in both cases.
  panelFooterRow: {
    flexDirection: "row",
    alignItems: "center",
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
  // WS9 BUG-157 — STAYS at neutral[600]: this style has NO consumer (grep for
  // s.placeholder in this file returns nothing). Left rather than edited, so the
  // sweep's diff carries no dead code.
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
