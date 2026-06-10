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
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { useApp } from "@/contexts/AppContext";
import { useMeal } from "@/hooks/useMeal";
import { usePlan } from "@/hooks/usePlan";
import { ApiError } from "@/lib/api/errors";
import { buildDayStrip } from "@/lib/domain";
import { formatMacro } from "@/lib/format/macros";
import { generateGroceryListForPlan } from "@/lib/api/grocery";
import {
  mealDetailToRow,
  planDetailToReviewPlan,
} from "@/lib/plans/reviewPlanAdapter";
import type {
  DayOfWeek,
  MealSummary,
  ReviewPlan,
  ReviewPlanMealRow,
} from "@/lib/types";

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
  const planQuery = usePlan(planId);
  const [reviewPlan, setReviewPlan] = useState<ReviewPlan | null>(null);

  useEffect(() => {
    if (planQuery.data) {
      setReviewPlan(planDetailToReviewPlan(planQuery.data));
    }
  }, [planQuery.data]);

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

  // Ruling 9 — deep-link error UX. No toast component exists in the codebase
  // today (verified via grep across artifacts/kiwi); Alert.alert is the
  // fallback per the prompt. Flagged in the Phase 3 report so chat-Claude
  // can decide whether to add a toast component or accept Alert long-term.
  useEffect(() => {
    if (injectMealQuery.isError) {
      console.warn("[plan/id] addMealId fetch failed", {
        addMealId,
        error: injectMealQuery.error,
      });
      Alert.alert("Couldn't add that meal.");
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

  // Block B gate (WS7-3 C4 c1) — server load, error, or adapter-not-yet-seeded
  // states render a loading / error frame. The error branch distinguishes 404
  // (plan not owned / missing) from generic load failure per the same pattern
  // app/dish/[id].tsx adopted in C3 c3.
  if (planQuery.isLoading || (!reviewPlan && !planQuery.isError)) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
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
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
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

  const hasMeals =
    reviewPlan.scheduledMeals.length > 0 ||
    reviewPlan.unscheduledMeals.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      {/* §8.3.1 — Header with back button, page label, passive Saved pill.
          Plan name + date range live in the editable meta strip below the
          header (PRD §8 / §11). */}
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
        <View style={s.planMetaSection}>
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
              strip (NOT the §8.3.2 action bar — that's locked to 3 CTAs).
              When this plan IS the winner: passive "This Week's Plan" badge.
              Otherwise: tappable chip activates the plan (resolver demotes
              prior winner silently — no constraint to reject). */}
          {reviewPlan.isActiveThisWeek ? (
            <View style={s.cookThisWeekBadge}>
              <Feather name="check" size={12} color={KColors.sage[700]} />
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
              <Feather name="calendar" size={12} color={KColors.neutral[100]} />
              <Text style={s.cookThisWeekChipText}>Cook This Week</Text>
            </Pressable>
          )}
        </View>

        {/* §8.3.2 — Sticky-near-top action bar (1+2 stack) */}
        <View style={s.actionBar}>
          <Button
            label="Prep and Cook"
            variant="primary"
            onPress={() => {
              console.log("[plan-review] prep-and-cook tapped", { planId });
              router.push("/prep-cook");
            }}
          />
          <View style={s.actionRow}>
            <View style={s.actionCol}>
              <Button
                label="Get Groceries Online"
                variant="terra"
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

        {/* §8.3.2 (cont.) — single Add Meals affordance */}
        <View style={s.addMealsWrap}>
          <Button label="Add Meals" variant="ghost" onPress={onAddMeals} />
        </View>

        {/* §8.3.3 — Prep status indicator */}
        <View style={s.section}>
          {reviewPlan.prepStatus === "not_prepped" ? (
            <View style={s.prepBanner}>
              <Feather name="zap" size={16} color={KColors.sage[700]} />
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

        {/* §8.3.4 — Smart Optimization Panel (hidden when notes are empty per §8.6) */}
        {reviewPlan.optimizationNotes.length > 0 && (
          <View style={s.section}>
            <Card>
              <Text style={s.cardTitle}>Smart optimization</Text>
              <View style={{ gap: KSpacing.sm, marginTop: KSpacing.sm }}>
                {reviewPlan.optimizationNotes.map((note, i) => (
                  <View key={i} style={s.noteRow}>
                    <Feather
                      name={note.type === "prep" ? "zap" : "dollar-sign"}
                      size={14}
                      color={KColors.sage[700]}
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
              <View style={{ marginTop: KSpacing.sm }}>
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
                  <Text style={s.subSectionHeader}>Unscheduled</Text>
                  {reviewPlan.unscheduledMeals.map((row) => (
                    <PlanReviewMealRow
                      key={row.planItemId}
                      row={row}
                      planId={planId}
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

        {/* §8.3.7 — Breakfast & Lunch defaults (collapsed by default) */}
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
              color={KColors.sage[700]}
            />
          </Pressable>
          {breakfastOpen && (
            <TextInput
              value={breakfastDraft}
              onChangeText={setBreakfastDraft}
              placeholder="Try: eggs, yogurt, oatmeal, fresh fruit"
              placeholderTextColor={KColors.neutral[600]}
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
              color={KColors.sage[700]}
            />
          </Pressable>
          {lunchOpen && (
            <TextInput
              value={lunchDraft}
              onChangeText={setLunchDraft}
              placeholder="Try: leftovers, sandwiches, salads"
              placeholderTextColor={KColors.neutral[600]}
              style={s.collapseInput}
              multiline
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={Keyboard.dismiss}
            />
          )}
        </View>
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
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.md,
    paddingBottom: 200, // keyboard clearance for bottommost TextInputs
  },
  gateWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: KSpacing.lg,
    gap: KSpacing.md,
  },
  gateText: {
    fontSize: KType.size.md,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  gateBtnWrap: {
    width: "60%",
  },
  savedPill: {
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: KSpacing.xs,
  },
  savedPillText: {
    fontSize: KType.size.xs,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  planMetaSection: {
    gap: 4,
    marginBottom: KSpacing.md,
  },
  cookThisWeekChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    borderRadius: KRadius.pill,
    backgroundColor: KColors.sage[700],
    marginTop: KSpacing.xs,
  },
  cookThisWeekChipText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[100],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  cookThisWeekBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    borderRadius: KRadius.pill,
    borderWidth: 1,
    borderColor: KColors.sage[700],
    backgroundColor: KColors.sage[100],
    marginTop: KSpacing.xs,
  },
  cookThisWeekBadgeText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  actionBar: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    padding: KSpacing.md,
    gap: KSpacing.sm,
  },
  actionRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
  },
  actionCol: { flex: 1 },
  addMealsWrap: {
    marginTop: KSpacing.sm,
  },
  section: {
    marginTop: KSpacing.lg,
  },
  prepBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: KSpacing.sm,
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
  },
  prepBannerText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  prepLink: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  prepBadge: {
    alignSelf: "flex-start",
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.md,
    paddingVertical: 6,
  },
  prepBadgeText: {
    fontSize: KType.size.xs,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  cardTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  noteRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: KSpacing.sm,
  },
  noteText: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  macroRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: KSpacing.sm,
  },
  macroStat: { alignItems: "center", flex: 1 },
  macroValue: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  macroLabel: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  macroFootnote: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.sm,
    lineHeight: 16,
  },
  sectionHeader: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
  },
  subSectionHeader: {
    fontSize: KType.size.md,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginTop: KSpacing.lg,
    marginBottom: KSpacing.sm,
  },
  placeholder: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    paddingVertical: KSpacing.lg,
    textAlign: "center",
  },
  emptyMeals: {
    alignItems: "center",
    gap: KSpacing.md,
    paddingVertical: KSpacing.xl,
  },
  emptyMealsText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  collapseHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.md,
  },
  collapseTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  collapseInput: {
    marginTop: KSpacing.sm,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.md,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    minHeight: 60,
  },
});
