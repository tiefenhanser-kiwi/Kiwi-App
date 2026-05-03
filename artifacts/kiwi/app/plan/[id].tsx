import React, { useRef, useState } from "react";
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";

import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { PlanReviewMealRow } from "@/components/PlanReviewMealRow";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { useApp } from "@/contexts/AppContext";
import { getReviewPlan } from "@/lib/stubs";

export default function PlanReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const planId = id ?? "";
  const { plans } = useApp();
  // Option A (locked): screen owns the ReviewPlan in local state.
  // Future action sheets (5J/5K/5L/5M) optimistically update via setReviewPlan;
  // AppContext mutators stay log-only stubs until WS7 wires real persistence.
  const [reviewPlan, _setReviewPlan] = useState(() => getReviewPlan(planId));

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
  };

  const hasMeals =
    reviewPlan.scheduledMeals.length > 0 ||
    reviewPlan.unscheduledMeals.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      {/* §8.3.1 — Header with back button, plan name, passive Saved pill */}
      <Header
        showBack
        title={planName}
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
        {/* §8.3.2 — Sticky-near-top action bar (1+2 stack) */}
        <View style={s.actionBar}>
          <Button
            label="Prep and Cook"
            variant="primary"
            onPress={() => {
              console.log("[plan-review] prep-and-cook tapped", { planId });
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
                }}
              />
            </View>
            <View style={s.actionCol}>
              <Button
                label="Generate Grocery List"
                variant="ghost"
                onPress={() => {
                  console.log("[plan-review] generate-grocery-list tapped", {
                    planId,
                  });
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
                <PlanReviewMealRow key={row.planItemId} row={row} planId={planId} />
              ))}
              {reviewPlan.unscheduledMeals.length > 0 && (
                <>
                  <Text style={s.subSectionHeader}>Unscheduled</Text>
                  {reviewPlan.unscheduledMeals.map((row) => (
                    <PlanReviewMealRow key={row.planItemId} row={row} planId={planId} />
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
    </View>
  );
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
  actionBar: {
    backgroundColor: KColors.neutral[0],
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
    backgroundColor: KColors.neutral[0],
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
    backgroundColor: KColors.neutral[0],
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
