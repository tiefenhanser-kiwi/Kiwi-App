import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DisplayTitle } from "@/components/DisplayTitle";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useInfiniteMeals } from "@/hooks/useMeals";
import { MEAL_DISABLED_SORT_KEYS, toMealSortKey } from "@/lib/meals/sortMapping";
import { mealListItemToSummary } from "@/lib/plans/mealListItemToSummary";
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

export function AddDishToMealSheet({
  visible,
  dishId,
  dishName,
  onClose,
  onPickExistingMeal,
}: AddDishToMealSheetProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [sortKey, setSortKey] = useState<SortKey>("alpha");

  // WS9-2 BUG-073 — the user's OWN saved meals only. The Featured / Top Rated /
  // Hosting chips were removed: Meal carries no featuring flags at all
  // (D-WS7-039), so those chips would return empty arrays forever, and catalog
  // meals (userId null) can't be mutated by a user anyway. Keyset-paginated +
  // server-sorted (useInfiniteMeals), load-on-scroll — mirrors SwapMealSheet.
  const mealsQuery = useInfiniteMeals(["my_meals"], toMealSortKey(sortKey));
  const meals = useMemo<MealSummary[]>(
    () => mealsQuery.meals.map((m) => mealListItemToSummary(m, "my_meals")),
    [mealsQuery.meals],
  );

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const distanceFromBottom =
      contentSize.height - contentOffset.y - layoutMeasurement.height;
    if (
      distanceFromBottom < 240 &&
      mealsQuery.hasNextPage &&
      !mealsQuery.isFetchingNextPage
    ) {
      void mealsQuery.fetchNextPage();
    }
  };

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
          onScroll={onScroll}
          scrollEventThrottle={32}
        >
          {/* Section 1: pick an existing meal */}
          <Text style={s.sectionTitle}>Pick a meal</Text>

          {/* WS9-2 BUG-073 — one source (your meals); the Featured / Top Rated /
              Hosting chips were removed (see the useInfiniteMeals note above). */}
          <View style={s.controlsRow}>
            <Text style={s.chipLabel}>My Meals</Text>
            {/* WS9-2 BUG-075 — grey the cook-stat keys with no backing meal field. */}
            <SortDropdown
              value={sortKey}
              onChange={setSortKey}
              disabledKeys={MEAL_DISABLED_SORT_KEYS}
            />
          </View>

          <View style={s.list}>
            {mealsQuery.isLoading ? (
              <Text style={s.emptyText}>Loading…</Text>
            ) : mealsQuery.isError ? (
              <Text style={s.emptyText}>
                Couldn't load meals right now. Try again in a moment.
              </Text>
            ) : meals.length === 0 ? (
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
                    <DisplayTitle
                      source={meal}
                      variant="row"
                      style={s.mealName}
                    />
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
          {mealsQuery.isFetchingNextPage && (
            <View style={s.footerLoading}>
              <ActivityIndicator size="small" color={Colors.sage[700]} />
            </View>
          )}

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
  footerLoading: {
    paddingVertical: Spacing[3],
    alignItems: "center",
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
