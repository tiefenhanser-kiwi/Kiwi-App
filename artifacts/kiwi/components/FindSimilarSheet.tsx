import React, { useMemo, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { findSimilarMealsByCuisine } from "@/lib/stubs";
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

const FALLBACK_DATE = "1970-01-01T00:00:00.000Z";

// Duplicated from ChangeMealSheet — see WS5-5K-bis report. Two
// consumers is the threshold for extraction in stable code, but
// SortKey lives in components/ and the helper would invert layering
// if pulled into lib/. Revisit when a third picker (Add Meals) lands.
function sortMeals(list: MealSummary[], key: SortKey): MealSummary[] {
  const out = [...list];
  switch (key) {
    case "last_cooked":
      out.sort((a, b) => {
        const av = a.lastCookedAt ?? "";
        const bv = b.lastCookedAt ?? "";
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return bv.localeCompare(av);
      });
      return out;
    case "times_cooked":
      out.sort((a, b) => (b.timesCooked ?? 0) - (a.timesCooked ?? 0));
      return out;
    case "date_created":
      out.sort((a, b) =>
        (b.createdAt ?? FALLBACK_DATE).localeCompare(
          a.createdAt ?? FALLBACK_DATE,
        ),
      );
      return out;
    case "alpha":
      out.sort((a, b) => a.title.localeCompare(b.title));
      return out;
    case "cook_time":
      out.sort((a, b) => a.estimatedTimeMinutes - b.estimatedTimeMinutes);
      return out;
  }
  return out;
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

  const matches = useMemo(() => {
    if (!sourceMealId) return [];
    return sortMeals(findSimilarMealsByCuisine(sourceMealId), sortKey);
  }, [sourceMealId, sortKey]);

  const handlePick = (meal: MealSummary) => {
    onPickReplacement(meal);
    onClose();
  };

  const handleAskKiwi = () => {
    Alert.alert(
      "Coming in WS6 — AI orchestration",
      "Kiwi will suggest similar meals when AI orchestration ships. For now, similar meals are matched by cuisine.",
    );
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
          {/* Section 1: Cuisine-matched meals */}
          <View style={s.sectionTitleRow}>
            <Text style={s.sectionTitle}>Similar meals</Text>
            <SortDropdown value={sortKey} onChange={setSortKey} />
          </View>

          {matches.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyTitle}>No similar meals saved yet.</Text>
              <Text style={s.emptyBody}>
                Try asking Kiwi to find one for you below, or use Change Meal
                to browse all your options.
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

          {/* Section 2: Ask Kiwi (premium-locked) */}
          <Pressable
            onPress={handleAskKiwi}
            style={({ pressed }) => [
              s.askSection,
              s.sectionGap,
              pressed && { opacity: 0.85 },
            ]}
          >
            <View style={s.askHeader}>
              <Text style={s.sectionTitle}>Ask Kiwi for a similar meal</Text>
              <View style={s.premiumPill}>
                <Feather
                  name="lock"
                  size={10}
                  color={KColors.terracotta[700]}
                />
                <Text style={s.premiumPillText}>Premium</Text>
              </View>
            </View>
            <Text style={s.sectionSubtitle}>
              Premium · coming in WS6 — Kiwi will find similar meals based on
              this meal's flavor profile, ingredients, and your preferences
            </Text>
          </Pressable>
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
  sectionSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 4,
  },
  sectionGap: {
    marginTop: KSpacing.lg,
  },
  list: {
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
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
    backgroundColor: KColors.neutral[0],
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
  askSection: {
    backgroundColor: KColors.neutral[50],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    opacity: 0.95,
  },
  askHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
  },
  premiumPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: KColors.terracotta[100],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
  },
  premiumPillText: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
