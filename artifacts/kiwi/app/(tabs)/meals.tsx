import React, { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { AddMealToPlanSheet } from "@/components/AddMealToPlanSheet";
import { DishRow } from "@/components/DishRow";
import { sortDishes } from "@/components/dishSort";
import {
  FilterChipRow,
  type FilterChipOption,
} from "@/components/FilterChipRow";
import { Header } from "@/components/Header";
import { MealRow } from "@/components/MealRow";
import { sortMeals } from "@/components/mealSort";
import { Screen } from "@/components/Screen";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  getFeaturedDishes,
  getFeaturedMeals,
  getHostingMeals,
  getSavedDishes,
  getSavedMeals,
  getTopRatedDishes,
  getTopRatedMeals,
  type MealRowData,
} from "@/lib/stubs";
import type { MealSummary, SavedDish } from "@/lib/types";

type SubTab = "meals" | "dishes";
type MealsChip = "featured" | "my_meals" | "top_rated" | "hosting";
type DishesChip = "featured" | "my_dishes" | "top_rated";

const MEALS_CHIPS: FilterChipOption<MealsChip>[] = [
  { key: "featured", label: "Featured" },
  { key: "my_meals", label: "My Meals" },
  { key: "top_rated", label: "Top Rated" },
  { key: "hosting", label: "Hosting & Events" },
];

const DISHES_CHIPS: FilterChipOption<DishesChip>[] = [
  { key: "featured", label: "Featured" },
  { key: "my_dishes", label: "My Dishes" },
  { key: "top_rated", label: "Top Rated" },
];

const capitalize = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1);

// Adapter: render MealSummary through the existing WS4 MealRow
// component (which expects MealRowData). filterGroup is presentational
// dead-code in MealRow today; "my_meals" satisfies the type. WS7 cleanup
// can either retire MealRow in favor of a MealSummary-native row or
// migrate MealRow to MealSummary directly.
function summaryToRowData(meal: MealSummary): MealRowData {
  return {
    id: meal.id,
    title: meal.title,
    thumbnailUrl: meal.imageUrl ?? null,
    meta: `${capitalize(meal.difficulty)} · ${meal.estimatedTimeMinutes} min · serves ${meal.servingsDefault}`,
    cuisineTag: meal.cuisineType ?? null,
    filterGroup: "my_meals",
    lastCookedAt: meal.lastCookedAt,
    timesCooked: meal.timesCooked,
    createdAt: meal.createdAt,
  };
}

export default function MealsTab() {
  const router = useRouter();
  const [subTab, setSubTab] = useState<SubTab>("meals");

  // Per-tab filter + sort state — chip selection should not bleed
  // across tabs and per-tab persistence feels more correct.
  const [mealFilter, setMealFilter] = useState<MealsChip>("my_meals");
  const [dishFilter, setDishFilter] = useState<DishesChip>("my_dishes");
  const [mealSort, setMealSort] = useState<SortKey>("alpha");
  const [dishSortKey, setDishSortKey] = useState<SortKey>("alpha");

  const [addToPlanFor, setAddToPlanFor] = useState<{
    mealId: string;
    mealTitle: string;
  } | null>(null);

  const visibleMeals = useMemo<MealSummary[]>(() => {
    let source: MealSummary[];
    switch (mealFilter) {
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
    return sortMeals(source, mealSort);
  }, [mealFilter, mealSort]);

  const visibleDishes = useMemo<SavedDish[]>(() => {
    let source: SavedDish[];
    switch (dishFilter) {
      case "my_dishes":
        source = getSavedDishes();
        break;
      case "featured":
        source = getFeaturedDishes();
        break;
      case "top_rated":
        source = getTopRatedDishes();
        break;
    }
    return sortDishes(source, dishSortKey);
  }, [dishFilter, dishSortKey]);

  const handleAddMeal = () => {
    router.push("/meal-builder");
  };

  const handleAddDish = () => {
    router.push("/dish-builder");
  };

  const handleOpenMeal = (mealId: string) => {
    router.push({ pathname: "/meal/[id]", params: { id: mealId } });
  };

  const handleOpenDish = (dishId: string) => {
    router.push({ pathname: "/dish/[id]", params: { id: dishId } });
  };

  const handleCookNow = () => {
    Alert.alert(
      "Coming with Prep & Cook Hub",
      "Cook Now lands when the Prep & Cook Hub workstream ships.",
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <AddMealToPlanSheet
        visible={addToPlanFor !== null}
        mealId={addToPlanFor?.mealId ?? ""}
        mealTitle={addToPlanFor?.mealTitle}
        onClose={() => setAddToPlanFor(null)}
        onPickExistingPlan={(plan) => {
          console.log("[meals] add-to-plan picked", {
            planId: plan.id,
            mealId: addToPlanFor?.mealId,
          });
          Alert.alert(
            "Coming in WS7",
            `When the API client lands, ${addToPlanFor?.mealTitle} will be added to "${plan.name}".`,
          );
          setAddToPlanFor(null);
        }}
      />
      <Header title="Recipes" />
      <Screen>
        {/* Sub-tab toggle */}
        <View style={s.toggleRow}>
          <Pressable
            onPress={() => setSubTab("meals")}
            style={({ pressed }) => [
              s.toggleBtn,
              subTab === "meals" && s.toggleBtnActive,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text
              style={[
                s.toggleText,
                subTab === "meals" && s.toggleTextActive,
              ]}
            >
              Meals
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setSubTab("dishes")}
            style={({ pressed }) => [
              s.toggleBtn,
              subTab === "dishes" && s.toggleBtnActive,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text
              style={[
                s.toggleText,
                subTab === "dishes" && s.toggleTextActive,
              ]}
            >
              Dishes
            </Text>
          </Pressable>
        </View>

        {subTab === "meals" ? (
          <ScrollView contentContainerStyle={s.scroll}>
            <Pressable
              onPress={handleAddMeal}
              style={({ pressed }) => [
                s.addBtn,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={s.addBtnText}>+ Add Meal</Text>
            </Pressable>

            <View style={s.filterWrap}>
              <FilterChipRow<MealsChip>
                options={MEALS_CHIPS}
                selected={[mealFilter]}
                onToggle={(key) => setMealFilter(key)}
              />
            </View>

            <View style={s.controlsRow}>
              <Text style={s.sectionLabel}>
                {MEALS_CHIPS.find((c) => c.key === mealFilter)?.label}
              </Text>
              <SortDropdown value={mealSort} onChange={setMealSort} />
            </View>

            <View style={s.list}>
              {visibleMeals.length === 0 ? (
                <View style={s.empty}>
                  <Text style={s.emptyText}>
                    Your saved meals will appear here. Tap + Add Meal to get
                    started.
                  </Text>
                </View>
              ) : (
                visibleMeals.map((meal) => (
                  <MealRow
                    key={meal.id}
                    meal={summaryToRowData(meal)}
                    onPress={() => handleOpenMeal(meal.id)}
                    onCookNow={handleCookNow}
                    onAddToPlan={(mealId, mealTitle) =>
                      setAddToPlanFor({ mealId, mealTitle })
                    }
                    sortKey={mealSort}
                  />
                ))
              )}
            </View>
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={s.scroll}>
            <Pressable
              onPress={handleAddDish}
              style={({ pressed }) => [
                s.addBtn,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={s.addBtnText}>+ Add Dish</Text>
            </Pressable>

            <View style={s.filterWrap}>
              <FilterChipRow<DishesChip>
                options={DISHES_CHIPS}
                selected={[dishFilter]}
                onToggle={(key) => setDishFilter(key)}
              />
            </View>

            <View style={s.controlsRow}>
              <Text style={s.sectionLabel}>
                {DISHES_CHIPS.find((c) => c.key === dishFilter)?.label}
              </Text>
              <SortDropdown value={dishSortKey} onChange={setDishSortKey} />
            </View>

            <View style={s.list}>
              {visibleDishes.length === 0 ? (
                <View style={s.empty}>
                  <Text style={s.emptyText}>
                    Save dishes to reuse them across meals. Tap + Add Dish to
                    get started.
                  </Text>
                </View>
              ) : (
                visibleDishes.map((dish) => (
                  <DishRow
                    key={dish.id}
                    dish={dish}
                    onPress={() => handleOpenDish(dish.id)}
                    sortKey={dishSortKey}
                  />
                ))
              )}
            </View>
          </ScrollView>
        )}
      </Screen>
    </View>
  );
}

const s = StyleSheet.create({
  toggleRow: {
    flexDirection: "row",
    backgroundColor: KColors.neutral[200],
    borderRadius: KRadius.md,
    padding: 4,
    marginTop: KSpacing.md,
    gap: 4,
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: KRadius.md,
    alignItems: "center",
  },
  toggleBtnActive: {
    backgroundColor: KColors.sage[700],
  },
  toggleText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  toggleTextActive: {
    color: KColors.neutral[0],
  },
  scroll: {
    paddingTop: KSpacing.md,
    paddingBottom: KSpacing.xxxl,
  },
  addBtn: {
    backgroundColor: KColors.sage[700],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: 12,
    alignItems: "center",
  },
  addBtnText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  filterWrap: { marginTop: KSpacing.sm },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
    marginTop: KSpacing.md,
  },
  sectionLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  list: {
    marginTop: KSpacing.md,
    gap: KSpacing.sm,
  },
  empty: {
    paddingVertical: KSpacing.xxl,
    paddingHorizontal: KSpacing.lg,
    alignItems: "center",
  },
  emptyText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
});
