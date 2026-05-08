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
import { PlanDateRangeEditor } from "@/components/PlanDateRangeEditor";
import { PlanNameEditor } from "@/components/PlanNameEditor";
import { PlanReviewMealRow } from "@/components/PlanReviewMealRow";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { useApp } from "@/contexts/AppContext";
import { buildDayStrip } from "@/lib/domain";
import { getMealById, getReviewPlan } from "@/lib/stubs";
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
    plans,
    changeMealForPlanItem,
    assignDayToPlanItem,
    unassignDayFromPlanItem,
    addMealToPlan,
    removeMealFromPlan,
    updatePlanName,
    updatePlanDateRange,
  } = useApp();
  // Option A (locked): screen owns the ReviewPlan in local state.
  // Future action sheets (5J/5K/5L/5M) optimistically update via setReviewPlan;
  // AppContext mutators stay log-only stubs until WS7 wires real persistence.
  const [reviewPlan, setReviewPlan] = useState(() => getReviewPlan(planId));

  // Tracks addMealId values already injected into unscheduled so a
  // re-render or re-navigate with the same param doesn't double-add.
  const [consumedAddMealIds, setConsumedAddMealIds] = useState<Set<string>>(
    () => new Set(),
  );

  // PRD §9.4 — when launched from AddMealToPlanSheet's "Create new plan"
  // card, the meal id arrives as a route param. Inject the row into
  // unscheduled on mount. Idempotent via consumedAddMealIds.
  useEffect(() => {
    if (!addMealId) return;
    if (consumedAddMealIds.has(addMealId)) return;

    const meal = getMealById(addMealId);
    if (!meal) {
      console.warn(
        "[plan/id] addMealId param present but getMealById returned null",
        { addMealId },
      );
      return;
    }

    const newRow: ReviewPlanMealRow = {
      planItemId: `pi-${Date.now()}`,
      mealId: meal.id,
      title: meal.title,
      thumbnailUrl: meal.imageUrl,
      metaLine: `${capitalize(meal.difficulty)} · ${meal.estimatedTimeMinutes} min · serves ${meal.servingsDefault}`,
      caloriesPerServing: meal.caloriesPerServing,
      proteinGPerServing: meal.proteinGPerServing,
      carbsGPerServing: meal.carbsGPerServing,
      fatGPerServing: meal.fatGPerServing,
      dayStrip: buildDayStrip(null),
      hasRecipeOverride: false,
    };

    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setReviewPlan((prev) => ({
      ...prev,
      unscheduledMeals: [...prev.unscheduledMeals, newRow],
    }));
    setConsumedAddMealIds((prev) => {
      const next = new Set(prev);
      next.add(addMealId);
      return next;
    });

    console.log("[plan/id] addMealId consumed, meal injected", {
      addMealId,
      title: meal.title,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMealId]);

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

  // Until WS7 wires real ReviewPlan data, the authoritative plan name lives
  // on the legacy MealPlan in AppContext.plans (recipe-id-based per WS5-5A).
  const plan = plans.find((p) => p.id === planId);
  const planName = plan?.name ?? reviewPlan.name ?? "Untitled plan";

  const [breakfastOpen, setBreakfastOpen] = useState(false);
  const [breakfastDraft, setBreakfastDraft] = useState(
    reviewPlan.breakfastDefaults,
  );
  const [lunchOpen, setLunchOpen] = useState(false);
  const [lunchDraft, setLunchDraft] = useState(reviewPlan.lunchDefaults);

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

  const handleSavePlanName = (newName: string) => {
    setReviewPlan((prev) => ({ ...prev, name: newName }));
    void updatePlanName(planId, newName);
  };

  const handleSaveDateRange = (start: string, end: string) => {
    setReviewPlan((prev) => ({
      ...prev,
      weekStartDate: start,
      weekEndDate: end,
    }));
    void updatePlanDateRange(planId, start, end);
  };

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
                label="Grocery List"
                variant="ghost"
                onPress={() => {
                  console.log("[plan-review] grocery-list tapped", {
                    planId,
                  });
                  // WS5-5S-fix-1 — single Grocery List entry. Real
                  // smart-list logic (D-WS5-038) generates a fresh
                  // list, or routes to an existing list if the plan
                  // hasn't changed; updates only on add/remove. WS5
                  // stubs the alert; WS6/WS7 wires the API client.
                  Alert.alert(
                    "Coming in WS6 — smart grocery list",
                    "Generates a fresh list, or routes to your existing list if the plan hasn't changed. Updates only when meals are added or removed. Logged as D-WS5-038 for full spec.",
                  );
                }}
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
        <View style={s.section}>
          <Card>
            <Text style={s.cardTitle}>Daily averages</Text>
            <View style={s.macroRow}>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>
                  {reviewPlan.macroDailyAverage.caloriesPerDay}
                </Text>
                <Text style={s.macroLabel}>cal</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>
                  {reviewPlan.macroDailyAverage.proteinGPerDay}
                </Text>
                <Text style={s.macroLabel}>g protein</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>
                  {reviewPlan.macroDailyAverage.carbsGPerDay}
                </Text>
                <Text style={s.macroLabel}>g carbs</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>
                  {reviewPlan.macroDailyAverage.fatGPerDay}
                </Text>
                <Text style={s.macroLabel}>g fat</Text>
              </View>
            </View>
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
                    const meal = getMealById(sourceMealId);
                    setFindSimilarForRow({
                      planItemId,
                      sourceMealId,
                      sourceMealTitle: title,
                      sourceCuisine: meal?.cuisineType,
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
                        const meal = getMealById(sourceMealId);
                        setFindSimilarForRow({
                          planItemId,
                          sourceMealId,
                          sourceMealTitle: title,
                          sourceCuisine: meal?.cuisineType,
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
            metaLine: newMetaLine,
            caloriesPerServing: newMeal.caloriesPerServing,
            proteinGPerServing: newMeal.proteinGPerServing,
            carbsGPerServing: newMeal.carbsGPerServing,
            fatGPerServing: newMeal.fatGPerServing,
            hasRecipeOverride: false,
          }
        : m;
    setReviewPlan((prev) => ({
      ...prev,
      scheduledMeals: prev.scheduledMeals.map(replaceRow),
      unscheduledMeals: prev.unscheduledMeals.map(replaceRow),
    }));
    void changeMealForPlanItem(planId, targetPlanItemId, newMeal.id);
  }

  // ── Day-pill tap (PRD §8.3.6). null = unassign. Configures the
  //    next layout pass so the row's move between scheduled and
  //    unscheduled clusters animates rather than snaps. ──
  function handleAssignDay(planItemId: string, newDay: DayOfWeek | null) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setReviewPlan((prev) => applyDayAssignment(prev, planItemId, newDay));
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
            setReviewPlan((prev) => ({
              ...prev,
              scheduledMeals: prev.scheduledMeals.filter(
                (m) => m.planItemId !== planItemId,
              ),
              unscheduledMeals: prev.unscheduledMeals.filter(
                (m) => m.planItemId !== planItemId,
              ),
            }));
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
      metaLine: `${capitalize(meal.difficulty)} · ${meal.estimatedTimeMinutes} min · serves ${meal.servingsDefault}`,
      caloriesPerServing: meal.caloriesPerServing,
      proteinGPerServing: meal.proteinGPerServing,
      carbsGPerServing: meal.carbsGPerServing,
      fatGPerServing: meal.fatGPerServing,
      dayStrip: buildDayStrip(null),
      hasRecipeOverride: false,
    };
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setReviewPlan((prev) => ({
      ...prev,
      unscheduledMeals: [...prev.unscheduledMeals, newRow],
    }));
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
