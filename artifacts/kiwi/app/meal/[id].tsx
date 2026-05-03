import React, { useMemo, useState } from "react";
import {
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  KColors,
  KCopy,
  KRadius,
  KSpacing,
  KType,
} from "@/constants/tokens";
import { getMealById } from "@/lib/stubs";

const SERVINGS_MIN = 1;
const SERVINGS_MAX = 12;

// PRD §11.3 — quantity rounding for ingredient display.
// Approximate; per-unit precision is a polish pass (WS9).
function formatQuantity(qty: number, unit: string): string {
  const wholeUnits = ["whole", "clove"];
  if (wholeUnits.includes(unit.toLowerCase())) {
    return String(Math.ceil(qty));
  }
  // Round to nearest 1/8 for cooking measures.
  const rounded = Math.round(qty * 8) / 8;
  const whole = Math.floor(rounded);
  const frac = rounded - whole;
  const fracMap: Record<string, string> = {
    "0.125": "⅛",
    "0.250": "¼",
    "0.375": "⅜",
    "0.500": "½",
    "0.625": "⅝",
    "0.750": "¾",
    "0.875": "⅞",
  };
  const fracKey = frac.toFixed(3);
  const fracStr = fracMap[fracKey] ?? "";
  if (whole === 0 && fracStr) return fracStr;
  if (whole > 0 && fracStr) return `${whole}${fracStr}`;
  if (whole > 0 && !fracStr) return String(whole);
  // Fallback: tiny non-mappable fraction (shouldn't happen after 1/8 rounding).
  return rounded.toFixed(2);
}

export default function MealDetailScreen() {
  const router = useRouter();
  const { id, planId, planItemId } = useLocalSearchParams<{
    id: string;
    planId?: string;
    planItemId?: string;
  }>();
  const mealId = id ?? "";

  const meal = useMemo(
    () =>
      getMealById(
        mealId,
        planId && planItemId ? { planId, planItemId } : undefined,
      ),
    [mealId, planId, planItemId],
  );

  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [displayServings, setDisplayServings] = useState(
    meal?.servingsDefault ?? 4,
  );

  if (!meal) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header title="Meal" showBack />
        <View style={s.notFoundWrap}>
          <Text style={s.notFoundText}>Meal not found.</Text>
        </View>
      </View>
    );
  }

  const showBanner = meal.hasActivePlanOverride && !bannerDismissed;
  const servingsMultiplier = displayServings / meal.servingsDefault;
  const onlyOneDish = meal.dishes.length === 1;

  const decrementServings = () => {
    setDisplayServings((n) => Math.max(SERVINGS_MIN, n - 1));
  };
  const incrementServings = () => {
    setDisplayServings((n) => Math.min(SERVINGS_MAX, n + 1));
  };

  const onSaveGlobally = () => {
    console.log("[meal-detail] save-globally tapped", {
      mealId: meal.id,
      ...meal.overrideContext,
    });
    Alert.alert(
      "Coming in WS7",
      "Saving changes globally requires the API client. This action will be wired in WS7.",
    );
  };

  const onKeepPlanOnly = () => {
    console.log("[meal-detail] keep-plan-only tapped", { mealId: meal.id });
    setBannerDismissed(true);
  };

  const onEdit = () => {
    console.log("[meal-detail] edit tapped", { mealId: meal.id });
    router.push({
      pathname: "/meal-builder",
      params: { mealId: meal.id },
    });
  };

  const onCompost = () => {
    console.log("[meal-detail] compost tapped", { mealId: meal.id });
    Alert.alert(
      "Coming in WS5-5M",
      "Compost-from-Meal-Detail confirmation modal lands in 5M.",
    );
  };

  const difficultyLabel =
    meal.difficulty === "easy"
      ? "Easy"
      : meal.difficulty === "medium"
        ? "Medium"
        : "Hard";

  const quickStatsParts = [
    meal.cuisineType,
    difficultyLabel,
    `${meal.estimatedTimeMinutes} min`,
    `${meal.servingsDefault} servings`,
  ].filter(Boolean) as string[];

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header showBack title={meal.title} />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* §2.5 — Save Globally banner (only when accessed from a plan with active override) */}
        {showBanner && (
          <View style={s.banner}>
            <Text style={s.bannerText}>
              This recipe is customized for this plan. Save these changes to
              your saved meal so future plans use them too?
            </Text>
            <View style={s.bannerBtnRow}>
              <View style={{ flex: 1 }}>
                <Button
                  label="Save to my meal forever"
                  variant="primary"
                  onPress={onSaveGlobally}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="Keep plan-only"
                  variant="ghost"
                  onPress={onKeepPlanOnly}
                />
              </View>
            </View>
          </View>
        )}

        {/* Hero — image + title + description + quick stats */}
        <View style={s.hero}>
          {meal.imageUrl ? (
            <Image source={{ uri: meal.imageUrl }} style={s.heroImage} />
          ) : (
            <View style={[s.heroImage, s.heroFallback]} />
          )}
          <Text style={s.heroTitle}>{meal.title}</Text>
          {meal.description && (
            <Text style={s.heroDescription}>{meal.description}</Text>
          )}
          <Text style={s.heroQuickStats}>{quickStatsParts.join(" · ")}</Text>
        </View>

        {/* Library-context actions: Edit / Compost */}
        <View style={s.actionRow}>
          <View style={{ flex: 1 }}>
            <Button label="Edit" variant="primary" onPress={onEdit} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={KCopy.delete} variant="ghost" onPress={onCompost} />
          </View>
        </View>

        {/* Per-serving macros */}
        <View style={s.section}>
          <Card>
            <Text style={s.cardTitle}>Per serving</Text>
            <View style={s.macroRow}>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{meal.caloriesPerServing}</Text>
                <Text style={s.macroLabel}>cal</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{meal.proteinGPerServing}</Text>
                <Text style={s.macroLabel}>g protein</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{meal.carbsGPerServing}</Text>
                <Text style={s.macroLabel}>g carbs</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{meal.fatGPerServing}</Text>
                <Text style={s.macroLabel}>g fat</Text>
              </View>
            </View>
          </Card>
        </View>

        {/* Ingredients */}
        <View style={s.section}>
          <Text style={s.sectionHeader}>Ingredients</Text>
          <View style={s.servingsAdjuster}>
            <Text style={s.servingsLabel}>Adjust for</Text>
            <View style={s.stepperRow}>
              <Pressable
                onPress={decrementServings}
                disabled={displayServings <= SERVINGS_MIN}
                hitSlop={6}
                style={({ pressed }) => [
                  s.stepperBtn,
                  displayServings <= SERVINGS_MIN && { opacity: 0.4 },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Feather name="minus" size={16} color={KColors.sage[700]} />
              </Pressable>
              <Text style={s.stepperValue}>{displayServings}</Text>
              <Pressable
                onPress={incrementServings}
                disabled={displayServings >= SERVINGS_MAX}
                hitSlop={6}
                style={({ pressed }) => [
                  s.stepperBtn,
                  displayServings >= SERVINGS_MAX && { opacity: 0.4 },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Feather name="plus" size={16} color={KColors.sage[700]} />
              </Pressable>
            </View>
            <Text style={s.servingsLabel}>servings</Text>
          </View>

          {meal.dishes.map((dish, dishIdx) => (
            <View key={`${dish.name}-${dishIdx}`} style={s.dishBlock}>
              {!onlyOneDish && (
                <Text style={s.dishHeader}>For the {dish.name}:</Text>
              )}
              {dish.ingredients.map((ing, i) => (
                <Text key={i} style={s.ingredientLine}>
                  {formatQuantity(ing.quantity * servingsMultiplier, ing.unit)}{" "}
                  {ing.unit} {ing.name}
                </Text>
              ))}
            </View>
          ))}
        </View>

        {/* Recipe steps */}
        <View style={s.section}>
          <Text style={s.sectionHeader}>Recipe steps</Text>
          {meal.steps.map((step) => (
            <View key={step.stepNumber} style={s.stepRow}>
              <View
                style={[
                  s.stepCircle,
                  step.isTimingSensitive
                    ? s.stepCircleTiming
                    : s.stepCircleNormal,
                ]}
              >
                <Text
                  style={
                    step.isTimingSensitive
                      ? s.stepCircleTextTiming
                      : s.stepCircleTextNormal
                  }
                >
                  {step.stepNumber}
                </Text>
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={s.stepText}>{step.text}</Text>
                {step.estimatedMinutes !== undefined && (
                  <Text style={s.stepMeta}>{step.estimatedMinutes} min</Text>
                )}
              </View>
            </View>
          ))}
        </View>

        {/* Notes (read-only in 5F) */}
        {meal.notes && (
          <View style={s.section}>
            <Text style={s.sectionHeader}>Notes</Text>
            <Text style={s.notesText}>{meal.notes}</Text>
          </View>
        )}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.md,
    paddingBottom: 200,
  },
  notFoundWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: KSpacing.xl,
  },
  notFoundText: {
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  banner: {
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
    gap: KSpacing.sm,
    marginBottom: KSpacing.lg,
  },
  bannerText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  bannerBtnRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
  },
  hero: {
    gap: KSpacing.sm,
  },
  heroImage: {
    width: "100%",
    height: 200,
    borderRadius: KRadius.lg,
    backgroundColor: KColors.neutral[200],
  },
  heroFallback: {
    backgroundColor: KColors.sage[100],
  },
  heroTitle: {
    fontSize: KType.size.xl,
    color: KColors.neutral[900],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
    marginTop: KSpacing.sm,
  },
  heroDescription: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    lineHeight: 18,
  },
  heroQuickStats: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  actionRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    marginTop: KSpacing.lg,
  },
  section: {
    marginTop: KSpacing.lg,
  },
  cardTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
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
    marginBottom: KSpacing.md,
  },
  servingsAdjuster: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    marginBottom: KSpacing.md,
  },
  servingsLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
  },
  stepperBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperValue: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    minWidth: 20,
    textAlign: "center",
  },
  dishBlock: {
    marginTop: KSpacing.md,
    gap: 4,
  },
  dishHeader: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  ingredientLine: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  stepRow: {
    flexDirection: "row",
    gap: KSpacing.md,
    marginBottom: KSpacing.md,
    alignItems: "flex-start",
  },
  stepCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  stepCircleNormal: {
    backgroundColor: KColors.sage[100],
  },
  stepCircleTiming: {
    backgroundColor: KColors.terracotta[200],
  },
  stepCircleTextNormal: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  stepCircleTextTiming: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  stepText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  stepMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  notesText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
});
