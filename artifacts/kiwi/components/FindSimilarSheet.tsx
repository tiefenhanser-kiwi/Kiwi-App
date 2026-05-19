import React, { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LoadingShim } from "@/components/LoadingShim";
import { sortMeals } from "@/components/mealSort";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { useFindSimilarMeals } from "@/hooks/useFindSimilarMeals";
import { mealSummaryToCandidate } from "@/lib/api/meals";
import {
  findSimilarMealsByCuisine,
  getFeaturedMeals,
  getHostingMeals,
  getMealById,
  getSavedMeals,
  getTopRatedMeals,
} from "@/lib/stubs";
import type { MealSummary } from "@/lib/types";

export interface FindSimilarSheetProps {
  visible: boolean;
  /** The source meal being matched against. */
  sourceMealId: string;
  /** Display name for the sheet header subtitle. */
  sourceMealTitle?: string;
  /** Source cuisine for the sheet header subtitle. */
  sourceCuisine?: string;
  onClose: () => void;
  /** Called when user picks a similar meal. */
  onPickReplacement: (newMeal: MealSummary) => void;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function FindSimilarSheet({
  visible,
  sourceMealId,
  sourceCuisine,
  onClose,
  onPickReplacement,
}: FindSimilarSheetProps) {
  const insets = useSafeAreaInsets();
  const [sortKey, setSortKey] = useState<SortKey>("alpha");
  const [aiOrderedIds, setAiOrderedIds] = useState<string[] | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);

  const findSimilarMutation = useFindSimilarMeals();

  // Build the candidate pool from all four buckets per PRD §8.4. WS7 replaces
  // these stubs with real catalog fetches.
  const candidatePool = useMemo<MealSummary[]>(() => {
    if (!sourceMealId) return [];
    const all = [
      ...getSavedMeals(),
      ...getFeaturedMeals(),
      ...getTopRatedMeals(),
      ...getHostingMeals(),
    ];
    return all.filter((m) => m.id !== sourceMealId);
  }, [sourceMealId]);

  const sourceMeal = useMemo(
    () => (sourceMealId ? getMealById(sourceMealId) : undefined),
    [sourceMealId],
  );

  // Fire the AI call when the sheet opens with a fresh source. Reset state
  // each time so re-opening for a different meal doesn't leak prior matches.
  useEffect(() => {
    if (!visible || !sourceMeal) {
      setAiOrderedIds(null);
      setUsedFallback(false);
      findSimilarMutation.reset();
      return;
    }
    setAiOrderedIds(null);
    setUsedFallback(false);
    findSimilarMutation.mutate(
      {
        source: {
          id: sourceMeal.id,
          title: sourceMeal.title,
          cuisine: sourceMeal.cuisineType ?? null,
          mealType: "dinner",
          tags: sourceMeal.tags,
        },
        candidates: candidatePool.map(mealSummaryToCandidate),
        limit: 10,
      },
      {
        onSuccess: (data) => {
          setAiOrderedIds(data.matches.map((m) => m.mealId));
          setUsedFallback(false);
        },
        onError: () => {
          setUsedFallback(true);
        },
      },
    );
    // We intentionally only re-fire when the visible/source changes — not on
    // candidatePool churn, which would loop in an effect that owns the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sourceMealId]);

  // Build the rendered list. AI path: respect AI's score order unless the
  // user picked a different sort. Fallback path: cuisine-only filter from
  // the existing stub helper.
  const matches = useMemo<MealSummary[]>(() => {
    if (!sourceMealId) return [];
    if (aiOrderedIds) {
      const byId = new Map(candidatePool.map((m) => [m.id, m]));
      const ordered = aiOrderedIds
        .map((id) => byId.get(id))
        .filter((m): m is MealSummary => !!m);
      // Default sort = AI order (we treat "alpha" as "AI order" here so the
      // existing dropdown still works for any of the explicit sort keys).
      return sortKey === "alpha" ? ordered : sortMeals(ordered, sortKey);
    }
    if (usedFallback) {
      return sortMeals(findSimilarMealsByCuisine(sourceMealId), sortKey);
    }
    return [];
  }, [sourceMealId, aiOrderedIds, usedFallback, sortKey, candidatePool]);

  const isLoading = findSimilarMutation.isPending;

  const handlePick = (meal: MealSummary) => {
    onPickReplacement(meal);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + KSpacing.md }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Find similar</Text>
            {sourceCuisine && (
              <Text style={s.subtitle}>Cuisine: {sourceCuisine}</Text>
            )}
          </View>
          <Pressable onPress={onClose} hitSlop={12}>
            <Feather name="x" size={22} color={KColors.neutral[800]} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {usedFallback && (
            <View style={s.fallbackBanner}>
              <Feather
                name="alert-circle"
                size={14}
                color={KColors.terracotta[700]}
              />
              <Text style={s.fallbackBannerText}>
                Showing cuisine matches — couldn&apos;t reach Kiwi
              </Text>
            </View>
          )}

          <View style={s.sectionTitleRow}>
            <Text style={s.sectionTitle}>Similar meals</Text>
            <SortDropdown value={sortKey} onChange={setSortKey} />
          </View>

          {isLoading ? (
            <View style={s.loadingCard}>
              <LoadingShim variant="inline" />
            </View>
          ) : matches.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyTitle}>No similar meals found.</Text>
              <Text style={s.emptyBody}>
                Try Change Meal to browse all your options.
              </Text>
            </View>
          ) : (
            <View style={s.list}>
              {matches.map((meal) => (
                <MealRow
                  key={meal.id}
                  meal={meal}
                  onPress={() => handlePick(meal)}
                />
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function MealRow({
  meal,
  onPress,
}: {
  meal: MealSummary;
  onPress: () => void;
}) {
  const metaParts = [
    meal.cuisineType,
    capitalize(meal.difficulty),
    `${meal.estimatedTimeMinutes} min`,
  ].filter(Boolean);
  const macrosLine = `${meal.caloriesPerServing} cal · ${meal.proteinGPerServing}g P · ${meal.carbsGPerServing}g C · ${meal.fatGPerServing}g F`;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.mealRow, pressed && { opacity: 0.7 }]}
    >
      <View style={[s.thumb, !meal.imageUrl && s.thumbFallback]} />
      <View style={{ flex: 1 }}>
        <Text style={s.mealTitle} numberOfLines={1} ellipsizeMode="tail">
          {meal.title}
        </Text>
        <Text style={s.mealMeta} numberOfLines={1} ellipsizeMode="tail">
          {metaParts.join(" · ")}
        </Text>
        <Text style={s.mealMacros} numberOfLines={1} ellipsizeMode="tail">
          {macrosLine}
        </Text>
      </View>
      {meal.timesCooked !== undefined && meal.timesCooked > 0 && (
        <Text style={s.useCount}>Cooked {meal.timesCooked}×</Text>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(20,35,18,0.5)",
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "85%",
    backgroundColor: KColors.neutral[100],
    borderTopLeftRadius: KRadius.xl,
    borderTopRightRadius: KRadius.xl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: KColors.neutral[400],
    alignSelf: "center",
    marginTop: KSpacing.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: KColors.neutral[300],
  },
  title: {
    fontSize: KType.size.xl,
    fontWeight: KType.weight.bold,
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
  },
  subtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  scrollContent: {
    padding: KSpacing.lg,
    paddingBottom: KSpacing.xxxl,
  },
  fallbackBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.xs,
    backgroundColor: KColors.terracotta[100],
    borderRadius: KRadius.sm,
    paddingVertical: KSpacing.xs,
    paddingHorizontal: KSpacing.sm,
    marginBottom: KSpacing.sm,
  },
  fallbackBannerText: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[700],
    fontFamily: "Inter_500Medium",
    flex: 1,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
  },
  sectionTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  list: {
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
  },
  loadingCard: {
    marginTop: KSpacing.lg,
    alignItems: "center",
    gap: KSpacing.sm,
    padding: KSpacing.lg,
  },
  loadingText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  emptyCard: {
    marginTop: KSpacing.sm,
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
    gap: KSpacing.xs,
  },
  emptyTitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  emptyBody: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  mealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.sm,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.neutral[200],
  },
  thumbFallback: {
    backgroundColor: KColors.sage[100],
  },
  mealTitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  mealMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  mealMacros: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  useCount: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
});
