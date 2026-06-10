import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
import {
  FilterChipRow,
  type FilterChipOption,
} from "@/components/FilterChipRow";
import { Header } from "@/components/Header";
import { MealRow } from "@/components/MealRow";
import { Screen } from "@/components/Screen";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { useAuth } from "@/contexts/AuthContext";
import { useDishes } from "@/hooks/useDishes";
import { useMeals } from "@/hooks/useMeals";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  asMealsFilters,
  type MealFilterKey,
  type MealListItem,
} from "@/lib/api/meals";
import {
  type DishFilterKey,
  type DishListItem,
} from "@/lib/api/dishes";
import { dishesEmptyCopy } from "@/lib/dishes/emptyStateCopy";
import { dishesFilterDefault } from "@/lib/dishes/filterDefault";
import {
  DISH_DISABLED_SORT_KEYS,
  DISH_SORT_LABEL_OVERRIDES,
  toDishSortKey,
} from "@/lib/dishes/sortMapping";
import { mealsEmptyCopy } from "@/lib/meals/emptyStateCopy";
import { mealsFilterDefault } from "@/lib/meals/filterDefault";

type SubTab = "meals" | "dishes";

const MEALS_CHIPS: FilterChipOption<MealFilterKey>[] = [
  { key: "featured", label: "Featured" },
  { key: "my_meals", label: "My Meals" },
  { key: "top_rated", label: "Top Rated" },
  { key: "hosting", label: "Hosting & Events" },
];

const DISHES_CHIPS: FilterChipOption<DishFilterKey>[] = [
  { key: "featured", label: "Featured" },
  { key: "my_dishes", label: "My Dishes" },
  { key: "top_rated", label: "Top Rated" },
];

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

// WS7-6 B-fix Block 3: dishes sort SERVER-side (the dropdown drives ?sort= and
// the list re-queries). WS7-6 C-fix Block 4 — toDishSortKey +
// DISH_SORT_LABEL_OVERRIDES + DISH_DISABLED_SORT_KEYS now live in the shared
// lib/dishes/sortMapping (Recipes→Dishes, Mode-C, and the Meal→Add-Dish sheet
// all import them).

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
  // Dishes filter: persistence channel exists in spirit (mirror Meals tab)
  // but User.lastDishesFilters is not in schema (D-WS7-051). Local-only.
  const [dishFilter, setDishFilter] = useState<DishFilterKey>(
    () => dishesFilterDefault([])[0],
  );
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

  // Server-side sort + infinite scroll (WS7-6 B-fix Block 3). The dropdown's
  // key maps 1:1 to the server ?sort= param; changing it re-queries (the key
  // is part of the React Query key). `dishes` is the flattened page chain.
  const dishesQuery = useDishes([dishFilter], toDishSortKey(dishSortKey));
  const visibleDishes: DishListItem[] = dishesQuery.dishes;

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
      {/* WS7-6 B-fix Block 3: Screen is non-scroll so the Dishes tab can host
          its own FlatList (infinite scroll). Each sub-tab owns its scrolling
          container — nesting a VirtualizedList inside a ScrollView would break
          onEndReached. */}
      <Screen scroll={false}>
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
          <ScrollView style={s.flex1} contentContainerStyle={s.scroll}>
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
          <FlatList<DishListItem>
            style={s.flex1}
            contentContainerStyle={s.scroll}
            data={visibleDishes}
            keyExtractor={(d) => d.id}
            ListHeaderComponent={
              <View>
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
                  <FilterChipRow<DishFilterKey>
                    options={DISHES_CHIPS}
                    selected={[dishFilter]}
                    onToggle={(key) => setDishFilter(key)}
                  />
                </View>

                <View style={[s.controlsRow, s.controlsRowList]}>
                  <Text style={s.sectionLabel}>
                    {DISHES_CHIPS.find((c) => c.key === dishFilter)?.label}
                  </Text>
                  <SortDropdown
                    value={dishSortKey}
                    onChange={setDishSortKey}
                    labelOverrides={DISH_SORT_LABEL_OVERRIDES}
                    disabledKeys={DISH_DISABLED_SORT_KEYS}
                  />
                </View>
              </View>
            }
            renderItem={({ item }) => (
              <DishRow
                dish={item}
                onPress={() => handleOpenDish(item.id)}
                onCookNow={handleCookNow}
                onAddToMeal={(dishId, dishName) =>
                  setAddDishToMealFor({ dishId, dishName })
                }
                sortKey={dishSortKey}
              />
            )}
            ItemSeparatorComponent={() => <View style={s.rowGap} />}
            // Prefetch-ahead: fire while the user is still 50% of a viewport
            // from the end so the next page is usually in before they reach it
            // (Hans-ruled threshold).
            onEndReachedThreshold={0.5}
            onEndReached={() => {
              if (dishesQuery.hasNextPage && !dishesQuery.isFetchingNextPage) {
                void dishesQuery.fetchNextPage();
              }
            }}
            ListEmptyComponent={
              dishesQuery.isLoading ? (
                <Text style={s.loadingText}>Loading…</Text>
              ) : dishesQuery.isError ? (
                <Text style={s.loadingText}>
                  Couldn’t load dishes right now. Try again in a moment.
                </Text>
              ) : (
                <View style={s.empty}>
                  <Text style={s.emptyText}>{dishesEmptyCopy(dishFilter)}</Text>
                </View>
              )
            }
            // Footer spinner for next-page fetches only — the first-page load
            // shows in ListEmptyComponent, so the list is never replaced by a
            // spinner mid-scroll.
            ListFooterComponent={
              dishesQuery.isFetchingNextPage ? (
                <View style={s.footerLoading}>
                  <ActivityIndicator size="small" color={KColors.sage[700]} />
                </View>
              ) : null
            }
          />
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
  flex1: { flex: 1 },
  // FlatList header's controls row needs the bottom gap the old `s.list`
  // marginTop used to provide before the first row.
  controlsRowList: { marginBottom: KSpacing.md },
  rowGap: { height: KSpacing.sm },
  footerLoading: { paddingVertical: KSpacing.md, alignItems: "center" },
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
