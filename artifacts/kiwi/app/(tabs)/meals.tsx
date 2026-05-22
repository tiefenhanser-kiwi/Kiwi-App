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

import { AddDishToMealSheet } from "@/components/AddDishToMealSheet";
import { AddMealToPlanSheet } from "@/components/AddMealToPlanSheet";
import { DishRow } from "@/components/DishRow";
import { sortDishes } from "@/components/dishSort";
import {
  FilterChipRow,
  type FilterChipOption,
} from "@/components/FilterChipRow";
import { Header } from "@/components/Header";
import { MealRow } from "@/components/MealRow";
import { Screen } from "@/components/Screen";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { useAuth } from "@/contexts/AuthContext";
import { useMeals } from "@/hooks/useMeals";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  getFeaturedDishes,
  getSavedDishes,
  getTopRatedDishes,
} from "@/lib/stubs";
import {
  asMealsFilters,
  type MealFilterKey,
  type MealListItem,
} from "@/lib/api/meals";
import { mealsEmptyCopy } from "@/lib/meals/emptyStateCopy";
import { mealsFilterDefault } from "@/lib/meals/filterDefault";
import type { SavedDish } from "@/lib/types";

type SubTab = "meals" | "dishes";
type DishesChip = "featured" | "my_dishes" | "top_rated";
type DishTypeFilter = "all" | "side" | "main";

const MEALS_CHIPS: FilterChipOption<MealFilterKey>[] = [
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

const DISH_TYPE_CHIPS: FilterChipOption<DishTypeFilter>[] = [
  { key: "all", label: "All" },
  { key: "side", label: "Sides" },
  { key: "main", label: "Mains" },
];

const DISH_SORT_LABEL_OVERRIDES = { times_cooked: "Most used" };

// Client-side meal sort. Only `alpha` and `cook_time` have backing fields on
// MealListItem today; the cook-stat sort keys (last_cooked / times_cooked /
// date_created) are no-ops until WS9 lands server-side params (D-WS7-048
// extended). Local helper — kept inline to avoid a 12-line module.
function sortMealsClient(
  list: readonly MealListItem[],
  key: SortKey,
): MealListItem[] {
  const out = [...list];
  if (key === "alpha") {
    out.sort((a, b) => a.title.localeCompare(b.title));
  } else if (key === "cook_time") {
    out.sort((a, b) => a.minutes - b.minutes);
  }
  return out;
}

export default function MealsTab() {
  const router = useRouter();
  const { user, setUiState } = useAuth();
  const [subTab, setSubTab] = useState<SubTab>("meals");

  // Per-tab filter + sort state — chip selection should not bleed
  // across tabs. Meals chip seeded from a persisted lastMealsFilters (single
  // key — Phase 1 R1 / D-WS7-049 carryover) else my_meals.
  const [mealFilter, setMealFilter] = useState<MealFilterKey>(() => {
    const seed = mealsFilterDefault(asMealsFilters(user?.lastMealsFilters));
    return seed[0];
  });
  const [dishFilter, setDishFilter] = useState<DishesChip>("my_dishes");
  const [dishTypeFilter, setDishTypeFilter] = useState<DishTypeFilter>("all");
  const [mealSort, setMealSort] = useState<SortKey>("alpha");
  const [dishSortKey, setDishSortKey] = useState<SortKey>("alpha");

  const [addToPlanFor, setAddToPlanFor] = useState<{
    mealId: string;
    mealTitle: string;
  } | null>(null);

  const [addDishToMealFor, setAddDishToMealFor] = useState<{
    dishId: string;
    dishName: string;
  } | null>(null);

  const mealsQuery = useMeals([mealFilter]);

  const toggleMealFilter = (key: MealFilterKey) => {
    setMealFilter(key);
    setUiState({ lastMealsFilters: [key] });
  };

  // Server already filtered by the selected chip; sort runs client-side
  // (D-WS7-048 extended — A–Z + cook-time work locally, cook-stat keys are
  // no-ops until WS9 lands server-side sort params).
  const visibleMeals = useMemo<MealListItem[]>(
    () => sortMealsClient(mealsQuery.data?.meals ?? [], mealSort),
    [mealsQuery.data, mealSort],
  );

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
    const typeFiltered =
      dishTypeFilter === "all"
        ? source
        : source.filter((d) => d.type === dishTypeFilter);
    return sortDishes(typeFiltered, dishSortKey);
  }, [dishFilter, dishTypeFilter, dishSortKey]);

  const handleAddMeal = () => {
    router.push("/meal-builder");
  };

  const handleAddDish = () => {
    // Per WS5-5O-fix-2: drop the 3-button picker; the Kiwi-assist
    // checkboxes inside Dish Builder already cover the AI path.
    router.push("/dish-builder");
  };

  const handleOpenMeal = (mealId: string) => {
    router.push({ pathname: "/meal/[id]", params: { id: mealId } });
  };

  const handleOpenDish = (dishId: string) => {
    router.push({ pathname: "/dish/[id]", params: { id: dishId } });
  };

  const handleCookNow = () => {
    router.push("/prep-cook");
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
      <AddDishToMealSheet
        visible={addDishToMealFor !== null}
        dishId={addDishToMealFor?.dishId ?? ""}
        dishName={addDishToMealFor?.dishName}
        onClose={() => setAddDishToMealFor(null)}
        onPickExistingMeal={(meal) => {
          console.log("[recipes-tab] add-dish-to-meal", {
            dishId: addDishToMealFor?.dishId,
            mealId: meal.id,
          });
          Alert.alert(
            "Coming in WS7",
            `When the API client lands, ${addDishToMealFor?.dishName} will be added to "${meal.title}".`,
          );
          setAddDishToMealFor(null);
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
              <FilterChipRow<MealFilterKey>
                options={MEALS_CHIPS}
                selected={[mealFilter]}
                onToggle={toggleMealFilter}
              />
            </View>

            <View style={s.controlsRow}>
              <Text style={s.sectionLabel}>
                {MEALS_CHIPS.find((c) => c.key === mealFilter)?.label}
              </Text>
              <SortDropdown value={mealSort} onChange={setMealSort} />
            </View>

            <View style={s.list}>
              {mealsQuery.isLoading ? (
                <Text style={s.loadingText}>Loading…</Text>
              ) : mealsQuery.isError ? (
                <Text style={s.loadingText}>
                  Couldn’t load meals right now. Try again in a moment.
                </Text>
              ) : visibleMeals.length === 0 ? (
                <View style={s.empty}>
                  <Text style={s.emptyText}>{mealsEmptyCopy(mealFilter)}</Text>
                </View>
              ) : (
                visibleMeals.map((meal) => (
                  <MealRow
                    key={meal.id}
                    meal={meal}
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

            <View style={s.filterWrap}>
              <FilterChipRow<DishTypeFilter>
                options={DISH_TYPE_CHIPS}
                selected={[dishTypeFilter]}
                onToggle={(key) => setDishTypeFilter(key)}
              />
            </View>

            <View style={s.controlsRow}>
              <Text style={s.sectionLabel}>
                {DISHES_CHIPS.find((c) => c.key === dishFilter)?.label}
              </Text>
              <SortDropdown
                value={dishSortKey}
                onChange={setDishSortKey}
                labelOverrides={DISH_SORT_LABEL_OVERRIDES}
              />
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
                    onCookNow={handleCookNow}
                    onAddToMeal={(dishId, dishName) =>
                      setAddDishToMealFor({ dishId, dishName })
                    }
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
  loadingText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    paddingVertical: KSpacing.lg,
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
