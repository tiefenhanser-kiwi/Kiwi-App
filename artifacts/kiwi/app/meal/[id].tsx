import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { useApp } from "@/contexts/AppContext";
import { AddMealToPlanSheet } from "@/components/AddMealToPlanSheet";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  Colors,
  Copy,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { useMeal } from "@/hooks/useMeal";
import { ApiError } from "@/lib/api/errors";
import type { MealDetail, MealStep } from "@/lib/api/meals";
import { formatMacro } from "@/lib/format/macros";

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

// WS7-2 Block D (Commit 3): first UI consumer of the favorites API. Block B
// migrated favorites to React Query but nothing toggled them; this heart sits
// in the meal detail Header's rightContent slot. toggleFavorite is optimistic
// with rollback (AppContext), so the icon flips instantly; on API failure the
// mutator rolls the cache back and we surface a brief alert.
function HeartButton({ mealId }: { mealId: string }) {
  const { isFavorite, toggleFavorite } = useApp();
  const favorited = isFavorite(mealId);

  const onToggle = async () => {
    try {
      await toggleFavorite(mealId);
    } catch {
      Alert.alert(
        "Couldn't update favorites",
        "Something went wrong. Please try again.",
      );
    }
  };

  return (
    <Pressable
      onPress={onToggle}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={
        favorited ? "Remove from favorites" : "Add to favorites"
      }
      style={({ pressed }) => [s.heartBtn, pressed && { opacity: 0.6 }]}
    >
      <Ionicons
        name={favorited ? "heart" : "heart-outline"}
        size={24}
        color={favorited ? Colors.terracotta[600] : Colors.sage[700]}
      />
    </Pressable>
  );
}

// WS7-3 Block B: the screen now reads GET /meals/:id via useMeal. This
// component handles the read state machine — loading skeleton, a 404
// "meal not found" view, and a retry-able error banner for everything else —
// and hands the resolved MealDetail to <MealDetailContent>.
export default function MealDetailScreen() {
  const { id, planId, planItemId, servingsOverride } = useLocalSearchParams<{
    id: string;
    planId?: string;
    planItemId?: string;
    servingsOverride?: string;
  }>();
  const mealId = id ?? "";
  const router = useRouter();

  // WS7-7-A B5 (D-WS7-090 read-side) — when opened from a plan item, thread
  // planItemId so the server applies that item's "just this time" override
  // (incl. a removed ingredient) to the detail we render here.
  const mealQuery = useMeal(mealId, planItemId);

  if (mealQuery.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header title="Meal" showBack />
        <View style={s.gateWrap}>
          <ActivityIndicator color={Colors.sage[700]} />
        </View>
      </View>
    );
  }

  const meal = mealQuery.data;
  if (!meal) {
    // An empty id (missing route param) or a 404 → "meal not found";
    // anything else (network, 500, schema mismatch) → retry-able banner.
    const err = mealQuery.error;
    const isNotFound =
      mealId === "" || (err instanceof ApiError && err.status === 404);
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header title="Meal" showBack />
        <View style={s.gateWrap}>
          <Text style={s.gateText}>
            {isNotFound
              ? "Meal not found."
              : "Couldn't load this meal. Please try again."}
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
                onPress={() => mealQuery.refetch()}
              />
            )}
          </View>
        </View>
      </View>
    );
  }

  // WS7-7-A B5 — parse the plan-instance servings override (passed as a string
  // route param). Falsy/NaN → undefined (inherit the meal default).
  const parsedOverride = servingsOverride ? Number(servingsOverride) : NaN;
  const initialServings = Number.isFinite(parsedOverride)
    ? parsedOverride
    : undefined;

  return (
    <MealDetailContent
      meal={meal}
      planId={planId}
      planItemId={planItemId}
      initialServings={initialServings}
    />
  );
}

function MealDetailContent({
  meal,
  planId,
  planItemId,
  initialServings,
}: {
  meal: MealDetail;
  planId?: string;
  planItemId?: string;
  initialServings?: number;
}) {
  const router = useRouter();
  const { setServingsForPlanItem } = useApp();

  // §2.5 banner context — present only when the screen was opened from a plan
  // item. GET /meals/:id has no per-plan override concept, so this is derived
  // from the route params alone (the stub did the same via overrideContext).
  const hasOverride = !!(planId && planItemId);

  const [bannerDismissed, setBannerDismissed] = useState(false);
  // WS7-7-A B5 — in a plan, seed from the instance override; otherwise the
  // meal's own default. The stepper is display-only in the library context
  // (no plan item to persist to) and persists in the plan context.
  const [displayServings, setDisplayServings] = useState(
    initialServings ?? meal.servings,
  );
  const [addToPlanVisible, setAddToPlanVisible] = useState(false);
  const canPersistServings = !!(planId && planItemId);

  const showBanner = hasOverride && !bannerDismissed;
  const servingsMultiplier = displayServings / meal.servings;
  const onlyOneDish = meal.dishes.length === 1;

  // Recipe steps. PRD §10.6 wants steps grouped by sub-dish, mirroring the
  // ingredients section. Steps are genuinely dish-owned only when the
  // top-level meal-owned `steps` array is empty — composeMealDetail copies
  // the meal-owned steps onto every dish as a fallback otherwise, so grouping
  // those would duplicate the same steps under each dish. Group only for a
  // multi-dish meal with empty meal-owned steps and at least one dish that
  // carries steps; every other case renders the existing flat list.
  const stepsAreGrouped =
    meal.dishes.length > 1 &&
    meal.steps.length === 0 &&
    meal.dishes.some((dish) => dish.steps.length > 0);
  const flatSteps =
    meal.steps.length > 0
      ? meal.steps
      : meal.dishes.flatMap((dish) => dish.steps);

  // Renders one numbered step row. `displayNumber` is the 1-based position
  // within its list (flat, or restarting per dish in the grouped layout).
  const renderStepRow = (step: MealStep, displayNumber: number, key: number) => (
    <View key={key} style={s.stepRow}>
      <View
        style={[
          s.stepCircle,
          step.isTimingSensitive ? s.stepCircleTiming : s.stepCircleNormal,
        ]}
      >
        <Text
          style={
            step.isTimingSensitive
              ? s.stepCircleTextTiming
              : s.stepCircleTextNormal
          }
        >
          {displayNumber}
        </Text>
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={s.stepText}>{step.text}</Text>
        {step.estimatedMinutes !== undefined && (
          <Text style={s.stepMeta}>{step.estimatedMinutes} min</Text>
        )}
      </View>
    </View>
  );

  // WS7-7-A B5 — apply a servings delta. In a plan, optimistically update the
  // display and persist the new value as servingsOverride (which bumps the plan
  // revision → the grocery list reconciles to the new quantities). On failure
  // we revert the display and surface the error. In the library context there's
  // no plan item to write to, so the stepper stays display-only.
  const applyServings = (next: number) => {
    const clamped = Math.max(SERVINGS_MIN, Math.min(SERVINGS_MAX, next));
    if (clamped === displayServings) return;
    const prev = displayServings;
    setDisplayServings(clamped);
    if (canPersistServings) {
      void setServingsForPlanItem(planId!, planItemId!, clamped).catch(() => {
        setDisplayServings(prev);
        Alert.alert(
          "Couldn't update servings",
          "We couldn't save that change. Please try again.",
        );
      });
    }
  };
  const decrementServings = () => applyServings(displayServings - 1);
  const incrementServings = () => applyServings(displayServings + 1);

  const onSaveGlobally = () => {
    console.log("[meal-detail] save-globally tapped", {
      mealId: meal.id,
      planId,
      planItemId,
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
    // Forward plan context (when present) so Meal Builder's Save flow can
    // surface the §2.5 prompt for edit-from-plan vs. global save.
    router.push({
      pathname: "/meal-builder",
      params: {
        mealId: meal.id,
        ...(planId && planItemId ? { planId, planItemId } : {}),
      },
    });
  };

  const onCookNow = () => {
    console.log("[meal-detail] cook-now tapped", { mealId: meal.id });
    // WS7-8b B2 — meal-context "Cook Now" → temporary /cook-session stub (the
    // Hub took over /prep-cook). Block 3 owns the real single-meal Cook session.
    router.push({ pathname: "/cook-session", params: { mealId: meal.id } });
  };

  const onAddToPlan = () => {
    console.log("[meal-detail] add-to-plan tapped", { mealId: meal.id });
    setAddToPlanVisible(true);
  };

  const onCompost = () => {
    console.log("[meal-detail] compost tapped", { mealId: meal.id });
    Alert.alert(
      "Compost meal",
      `Compost ${meal.title}? It'll be removed from your meals and any plans it's in.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Compost",
          style: "destructive",
          onPress: () => {
            // For WS5: confirmation flow only — real soft-delete +
            // active-plan cleanup requires the API client (WS7).
            // The double-alert pattern keeps the flow feeling real
            // for smoke testing. WS7 reviewer: replace the inner
            // "Coming in WS7" alert with deleteMealAndCleanup() →
            // router.back().
            console.log("[meal-detail] compost confirmed", {
              mealId: meal.id,
            });
            Alert.alert(
              "Coming in WS7",
              "Soft-deleting the meal record and removing from active plans requires the API client. The action will fully wire in WS7.",
              [{ text: "OK", onPress: () => router.back() }],
            );
          },
        },
      ],
    );
  };

  const difficultyLabel =
    meal.difficulty === "easy"
      ? "Easy"
      : meal.difficulty === "medium"
        ? "Medium"
        : "Hard";

  const quickStatsParts = [
    meal.cuisine,
    difficultyLabel,
    `${meal.minutes} min`,
    // WS7-7-A B5 (Issue C) — hero quick-stats track the live (possibly
    // overridden) servings, matching the stepper + ingredient scaling, not
    // the static server default `meal.servings`.
    `${displayServings} servings`,
  ].filter(Boolean) as string[];

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <AddMealToPlanSheet
        visible={addToPlanVisible}
        mealId={meal.id}
        mealTitle={meal.title}
        onClose={() => setAddToPlanVisible(false)}
        onPickExistingPlan={(plan) => {
          console.log("[meal-detail] add-to-plan picked", {
            planId: plan.id,
            mealId: meal.id,
          });
          Alert.alert(
            "Coming in WS7",
            `When the API client lands, ${meal.title} will be added to "${plan.name}".`,
          );
          setAddToPlanVisible(false);
        }}
      />
      <Header
        showBack
        title={meal.title}
        rightContent={<HeartButton mealId={meal.id} />}
      />
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
          {meal.image ? (
            <Image source={{ uri: meal.image }} style={s.heroImage} />
          ) : (
            <View style={[s.heroImage, s.heroFallback]} />
          )}
          <Text style={s.heroTitle}>{meal.title}</Text>
          {meal.description && (
            <Text style={s.heroDescription}>{meal.description}</Text>
          )}
          <Text style={s.heroQuickStats}>{quickStatsParts.join(" · ")}</Text>
        </View>

        {/* Primary actions per PRD §10.6: Cook Now (most prominent),
            then Add to Plan. Secondary library actions (Edit, Compost)
            sit below as a row. */}
        <View style={s.primaryActionStack}>
          <Button label="Cook Now" variant="primary" onPress={onCookNow} />
          <Button label="Add to Plan" variant="primary" onPress={onAddToPlan} />
        </View>
        <View style={s.actionRow}>
          <View style={{ flex: 1 }}>
            <Button label="Edit" variant="ghost" onPress={onEdit} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={Copy.delete} variant="ghost" onPress={onCompost} />
          </View>
        </View>

        {/* Per-serving macros */}
        <View style={s.section}>
          <Card>
            <Text style={s.cardTitle}>Per serving</Text>
            <View style={s.macroRow}>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{formatMacro(meal.calories)}</Text>
                <Text style={s.macroLabel}>cal</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{formatMacro(meal.protein)}</Text>
                <Text style={s.macroLabel}>g protein</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{formatMacro(meal.carbs)}</Text>
                <Text style={s.macroLabel}>g carbs</Text>
              </View>
              <View style={s.macroStat}>
                <Text style={s.macroValue}>{formatMacro(meal.fat)}</Text>
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
                <Feather name="minus" size={16} color={Colors.sage[700]} />
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
                <Feather name="plus" size={16} color={Colors.sage[700]} />
              </Pressable>
            </View>
            <Text style={s.servingsLabel}>servings</Text>
          </View>

          {meal.dishes.map((dish) => (
            <View key={dish.dishId} style={s.dishBlock}>
              {!onlyOneDish && (
                <Text style={s.dishHeader}>For the {dish.title}:</Text>
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

        {/* Recipe steps — grouped by sub-dish for multi-dish meals
            (PRD §10.6, mirroring the ingredients section); one flat
            numbered list otherwise. */}
        <View style={s.section}>
          <Text style={s.sectionHeader}>Recipe steps</Text>
          {stepsAreGrouped
            ? meal.dishes
                .filter((dish) => dish.steps.length > 0)
                .map((dish) => (
                  <View key={dish.dishId} style={s.dishBlock}>
                    <Text style={s.dishHeader}>For the {dish.title}:</Text>
                    {dish.steps.map((step, i) =>
                      renderStepRow(step, i + 1, i),
                    )}
                  </View>
                ))
            : flatSteps.map((step, i) => renderStepRow(step, i + 1, i))}
        </View>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: 200,
  },
  gateWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing[5],
    gap: Spacing[3],
  },
  gateText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  gateBtnWrap: {
    minWidth: 160,
  },
  banner: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
    gap: Spacing[2],
    marginBottom: Spacing[4],
  },
  bannerText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  bannerBtnRow: {
    flexDirection: "row",
    gap: Spacing[2],
  },
  hero: {
    gap: Spacing[2],
  },
  heroImage: {
    width: "100%",
    height: 200,
    borderRadius: Radius.lg,
    backgroundColor: Colors.neutral[200],
  },
  heroFallback: {
    backgroundColor: Colors.sage[100],
  },
  heroTitle: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[600],
    marginTop: Spacing[2],
  },
  heroDescription: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    lineHeight: 18,
  },
  heroQuickStats: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  primaryActionStack: {
    gap: Spacing[2],
    marginTop: Spacing[4],
  },
  actionRow: {
    flexDirection: "row",
    gap: Spacing[2],
    marginTop: Spacing[2],
  },
  section: {
    marginTop: Spacing[4],
  },
  cardTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
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
  sectionHeader: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[3],
  },
  servingsAdjuster: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    marginBottom: Spacing[3],
  },
  servingsLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  stepperBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperValue: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    minWidth: 20,
    textAlign: "center",
  },
  dishBlock: {
    marginTop: Spacing[3],
    gap: 4,
  },
  dishHeader: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: 4,
  },
  ingredientLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  stepRow: {
    flexDirection: "row",
    gap: Spacing[3],
    marginBottom: Spacing[3],
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
    backgroundColor: Colors.sage[100],
  },
  stepCircleTiming: {
    backgroundColor: Colors.terracotta[200],
  },
  stepCircleTextNormal: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  stepCircleTextTiming: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  stepText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  stepMeta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  heartBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
