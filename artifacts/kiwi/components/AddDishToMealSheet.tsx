import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  FilterChipRow,
  type FilterChipOption,
} from "@/components/FilterChipRow";
import { sortMeals } from "@/components/mealSort";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  getFeaturedMeals,
  getHostingMeals,
  getSavedMeals,
  getTopRatedMeals,
} from "@/lib/stubs";
import type { MealSummary } from "@/lib/types";

export interface AddDishToMealSheetProps {
  visible: boolean;
  /** The dish being added. */
  dishId: string;
  dishName?: string;
  onClose: () => void;
  /** Called when user picks an existing meal. */
  onPickExistingMeal: (meal: MealSummary) => void;
}

type MealsChip = "featured" | "my_meals" | "top_rated" | "hosting";

const MEALS_CHIPS: FilterChipOption<MealsChip>[] = [
  { key: "featured", label: "Featured" },
  { key: "my_meals", label: "My Meals" },
  { key: "top_rated", label: "Top Rated" },
  { key: "hosting", label: "Hosting & Events" },
];

export function AddDishToMealSheet({
  visible,
  dishId,
  dishName,
  onClose,
  onPickExistingMeal,
}: AddDishToMealSheetProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [chip, setChip] = useState<MealsChip>("my_meals");
  const [sortKey, setSortKey] = useState<SortKey>("alpha");

  const meals = useMemo<MealSummary[]>(() => {
    let source: MealSummary[];
    switch (chip) {
      case "my_meals":
        source = getSavedMeals();
        break;
      case "featured":
        source = getFeaturedMeals();
        break;
      case "top_rated":
        source = getTopRatedMeals();
        break;
      case "hosting":
        source = getHostingMeals();
        break;
    }
    return sortMeals(source, sortKey);
  }, [chip, sortKey]);

  const handleCreateNewMeal = () => {
    onClose();
    // Defer push so the sheet's slide-out completes before mount.
    setTimeout(() => {
      router.push({
        pathname: "/meal-builder",
        params: { addDishId: dishId },
      });
    }, 150);
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
            <Text style={s.title}>Add to meal</Text>
            {dishName && (
              <Text style={s.subtitle} numberOfLines={1}>
                {dishName}
              </Text>
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
          {/* Section 1: pick an existing meal */}
          <Text style={s.sectionTitle}>Pick a meal</Text>

          <View style={s.filterWrap}>
            <FilterChipRow<MealsChip>
              options={MEALS_CHIPS}
              selected={[chip]}
              onToggle={(key) => setChip(key)}
            />
          </View>

          <View style={s.controlsRow}>
            <Text style={s.chipLabel}>
              {MEALS_CHIPS.find((c) => c.key === chip)?.label}
            </Text>
            <SortDropdown value={sortKey} onChange={setSortKey} />
          </View>

          <View style={s.list}>
            {meals.length === 0 ? (
              <Text style={s.emptyText}>No meals here yet.</Text>
            ) : (
              meals.map((meal) => (
                <Pressable
                  key={meal.id}
                  onPress={() => {
                    onPickExistingMeal(meal);
                    onClose();
                  }}
                  style={({ pressed }) => [
                    s.mealRow,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text
                      style={s.mealName}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {meal.title}
                    </Text>
                    <Text style={s.mealMeta} numberOfLines={1}>
                      {[
                        meal.cuisineType,
                        `${meal.estimatedTimeMinutes} min`,
                        `serves ${meal.servingsDefault}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                  <Feather
                    name="chevron-right"
                    size={18}
                    color={KColors.neutral[600]}
                  />
                </Pressable>
              ))
            )}
          </View>

          {/* Section 2: create a new meal */}
          <Text style={[s.sectionTitle, s.sectionGap]}>Create a new meal</Text>
          <Pressable
            onPress={handleCreateNewMeal}
            style={({ pressed }) => [
              s.newMealCard,
              pressed && { opacity: 0.85 },
            ]}
          >
            <View style={s.newMealIcon}>
              <Feather
                name="plus-square"
                size={20}
                color={KColors.sage[700]}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.newMealTitle}>Create a new meal</Text>
              <Text style={s.newMealSubtitle}>
                Build a fresh meal with this dish included
              </Text>
            </View>
            <Feather
              name="chevron-right"
              size={18}
              color={KColors.neutral[600]}
            />
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
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
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: KColors.neutral[300],
    gap: KSpacing.sm,
  },
  title: {
    fontSize: KType.size.xl,
    fontWeight: KType.weight.bold,
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
  },
  subtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  scrollContent: {
    padding: KSpacing.lg,
    paddingBottom: KSpacing.xxxl,
  },
  sectionTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  sectionGap: {
    marginTop: KSpacing.lg,
  },
  filterWrap: {
    marginTop: KSpacing.sm,
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: KSpacing.sm,
  },
  chipLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  list: {
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
  },
  emptyText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    textAlign: "center",
    paddingVertical: KSpacing.md,
  },
  mealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
  },
  mealName: {
    fontSize: KType.size.md,
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
  newMealCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    marginTop: KSpacing.sm,
  },
  newMealIcon: {
    width: 36,
    height: 36,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  newMealTitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  newMealSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
