import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FilterChipRow } from "@/components/FilterChipRow";
import { ImportSourceCards } from "@/components/ImportSourceCards";
import { sortMeals } from "@/components/mealSort";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useMeals } from "@/hooks/useMeals";
import type { MealFilterKey } from "@/lib/api/meals";
import { mealListItemToSummary } from "@/lib/plans/mealListItemToSummary";
import type { MealSummary } from "@/lib/types";

export interface AddMealsSheetProps {
  visible: boolean;
  /** Current plan id — passed through to import/builder flows via
   *  addToPlanId so WS7 can auto-add the saved meal to this plan. */
  planId: string;
  onClose: () => void;
  /** Called when user picks an existing meal from the list. The
   *  parent screen handles the optimistic add to the unscheduled
   *  cluster (PRD §8.3.8 — new meals land unscheduled). */
  onPickExistingMeal: (meal: MealSummary) => void;
}

const FILTER_OPTIONS: { key: MealFilterKey; label: string }[] = [
  { key: "featured", label: "Featured" },
  { key: "my_meals", label: "My Meals" },
  { key: "top_rated", label: "Top Rated" },
  { key: "hosting", label: "Hosting & Events" },
];

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function AddMealsSheet({
  visible,
  planId,
  onClose,
  onPickExistingMeal,
}: AddMealsSheetProps) {
  const insets = useSafeAreaInsets();
  const [activeFilter, setActiveFilter] =
    useState<MealFilterKey>("my_meals");
  const [sortKey, setSortKey] = useState<SortKey>("alpha");

  // WS7-3 C4 c2 — single-filter useMeals call; adapter widens MealListItem
  // back to the MealSummary shape the existing row + sortMeals consume.
  const mealsQuery = useMeals([activeFilter]);

  const visibleMeals = useMemo(() => {
    const adapted = (mealsQuery.data?.meals ?? []).map((m) =>
      mealListItemToSummary(m, activeFilter),
    );
    return sortMeals(adapted, sortKey);
  }, [mealsQuery.data, activeFilter, sortKey]);

  const handlePick = (meal: MealSummary) => {
    onPickExistingMeal(meal);
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
      <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <Text style={s.title}>Add a meal</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Feather name="x" size={22} color={Colors.neutral[800]} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Section 1: Bring in something new — the shared import-entry chooser
              (WS9 3f-3 dedup). APPEND context: planId threads as addToPlanId so
              the saved meal returns to THIS plan. includeAskKiwi renders the live
              Mode-A "Ask Kiwi for a meal" card on top (WS7-6 G3 Scope A ordering). */}
          <ImportSourceCards
            context={{ kind: "append", planId }}
            includeAskKiwi
            onClose={onClose}
          />

          {/* Section 2: Pick from your meals — the saved-meals list scrolls at
              the BOTTOM (WS7-6 G3 Scope A: list-below-create contract). */}
          <Text style={[s.sectionTitle, s.sectionGap]}>Pick from your meals</Text>
          <View style={{ marginTop: Spacing[2] }}>
            <FilterChipRow<MealFilterKey>
              options={FILTER_OPTIONS}
              selected={[activeFilter]}
              onToggle={(key) => setActiveFilter(key)}
            />
          </View>
          <View style={[s.sectionTitleRow, { marginTop: Spacing[2] }]}>
            <Text style={s.sectionLabel}>
              {FILTER_OPTIONS.find((o) => o.key === activeFilter)?.label}
            </Text>
            <SortDropdown value={sortKey} onChange={setSortKey} />
          </View>
          <View style={s.list}>
            {mealsQuery.isLoading ? (
              <View style={s.loadingRow}>
                <ActivityIndicator color={Colors.sage[700]} />
              </View>
            ) : mealsQuery.isError ? (
              <Pressable
                onPress={() => mealsQuery.refetch()}
                style={({ pressed }) => [
                  s.errorRow,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={s.errorText}>
                  Couldn&apos;t load meals. Tap to retry.
                </Text>
              </Pressable>
            ) : visibleMeals.length === 0 ? (
              <Text style={s.emptyText}>No meals here yet.</Text>
            ) : (
              visibleMeals.map((meal) => (
                <MealRow
                  key={meal.id}
                  meal={meal}
                  onPress={() => handlePick(meal)}
                />
              ))
            )}
          </View>
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
    backgroundColor: Palette.background.overlay,
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "85%",
    backgroundColor: Colors.neutral[100],
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.neutral[400],
    alignSelf: "center",
    marginTop: Spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[300],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    fontWeight: Typography.fontWeight.bold,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[700],
  },
  scrollContent: {
    padding: Spacing[4],
    paddingBottom: Spacing[8],
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
  },
  sectionTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  sectionLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  sectionSubtitle: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 4,
  },
  sectionGap: {
    marginTop: Spacing[4],
  },
  list: {
    gap: Spacing[2],
    marginTop: Spacing[2],
  },
  emptyText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    textAlign: "center",
    paddingVertical: Spacing[3],
  },
  loadingRow: {
    alignItems: "center",
    paddingVertical: Spacing[4],
  },
  errorRow: {
    backgroundColor: Colors.terracotta[100],
    borderRadius: Radius.sm,
    padding: Spacing[3],
  },
  errorText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[500],
    textAlign: "center",
  },
  mealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[2],
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: Radius.sm,
    backgroundColor: Colors.neutral[200],
  },
  thumbFallback: {
    backgroundColor: Colors.sage[100],
  },
  mealTitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  mealMeta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  mealMacros: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  useCount: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  askSection: {
    backgroundColor: Colors.neutral[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
    opacity: 0.95,
  },
  askHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
  },
  premiumPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.terracotta[100],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  premiumPillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  sourceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  sourceIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Colors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  sourceTitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  sourceSubtitle: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  premiumCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
  },
  premiumIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Palette.background.card,
    alignItems: "center",
    justifyContent: "center",
  },
  premiumTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
  },
});
