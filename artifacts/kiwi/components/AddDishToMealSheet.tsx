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
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
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
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + Spacing[3] }]}>
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
            <Feather name="x" size={22} color={Colors.neutral[800]} />
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
                      numberOfLines={2}
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
                    color={Colors.neutral[600]}
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
                color={Colors.sage[700]}
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
              color={Colors.neutral[600]}
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
    gap: Spacing[2],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    fontWeight: Typography.fontWeight.bold,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[700],
  },
  subtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  scrollContent: {
    padding: Spacing[4],
    paddingBottom: Spacing[8],
  },
  sectionTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  sectionGap: {
    marginTop: Spacing[4],
  },
  filterWrap: {
    marginTop: Spacing[2],
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: Spacing[2],
  },
  chipLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
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
  mealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  mealName: {
    fontSize: Typography.fontSize.md,
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
  newMealCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
    marginTop: Spacing[2],
  },
  newMealIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Colors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  newMealTitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  newMealSubtitle: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
});
