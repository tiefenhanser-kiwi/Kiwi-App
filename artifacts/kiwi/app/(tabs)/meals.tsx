import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { AddDishChooserSheet } from "@/components/AddDishChooserSheet";
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
import { useInfiniteMeals } from "@/hooks/useMeals";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";
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
import {
  MEAL_DISABLED_SORT_KEYS,
  toMealSortKey,
} from "@/lib/meals/sortMapping";

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

// WS7-6 G2 scope (iii): the Meals sub-tab now sorts SERVER-side too (the
// dropdown drives ?sort= and the keyset-paginated list re-queries) — the old
// client-side sortMealsClient was killed because re-sorting only the cached
// first page hid newly-saved meals (Hans device-confirmed). Meals support
// alpha / date_created / cook_time; the dish-only keys stay greyed.
//
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

  // WS7-6 G3 Scope A — surface #3 "+ Add Dish" now opens a create-mode chooser
  // (Ask Kiwi / Create manually) instead of jumping straight to the builder.
  const [addDishOpen, setAddDishOpen] = useState(false);

  // WS7-6 G2 scope (iii) — server-sorted + keyset-paginated Meals list (the
  // dropdown's key maps to ?sort=; changing it re-queries since the key is
  // part of the React Query key). `meals` is the flattened page chain.
  const mealsQuery = useInfiniteMeals([mealFilter], toMealSortKey(mealSort));
  const visibleMeals: MealListItem[] = mealsQuery.meals;

  // WS7-6 G1 — focus-driven refetch backstop for the Meals list. The (E)
  // Block 2 useRefetchOnFocus rollout covered Home/Plans/Grocery but missed
  // this tab. saveMeal already invalidates ["meals","list"] precisely, so a
  // meal saved while this screen is mounted appears on return; this closes the
  // gap for the stale-after-unmount path (honors the 60s staleTime gate, so a
  // re-focus inside the window costs nothing).
  useRefetchOnFocus(mealsQuery);

  const toggleMealFilter = (key: MealFilterKey) => {
    setMealFilter(key);
    setUiState({ lastMealsFilters: [key] });
  };

  // Server-side sort + infinite scroll (WS7-6 B-fix Block 3). The dropdown's
  // key maps 1:1 to the server ?sort= param; changing it re-queries (the key
  // is part of the React Query key). `dishes` is the flattened page chain.
  const dishesQuery = useDishes([dishFilter], toDishSortKey(dishSortKey));
  const visibleDishes: DishListItem[] = dishesQuery.dishes;

  const handleAddMeal = () => {
    router.push("/meal-builder");
  };

  const handleAddDish = () => {
    // WS7-6 G3 Scope A — open the create-mode chooser sheet. (Pre-G3 this
    // jumped straight to /dish-builder; "Create manually" inside the sheet
    // preserves that path, and Ask Kiwi adds the dish-side Mode-A entry.)
    setAddDishOpen(true);
  };

  const handleOpenMeal = (mealId: string) => {
    router.push({ pathname: "/meal/[id]", params: { id: mealId } });
  };

  const handleOpenDish = (dishId: string) => {
    router.push({ pathname: "/dish/[id]", params: { id: dishId } });
  };

  // WS7-8b B2 — meal-context "Cook Now". The Hub took over /prep-cook, so this
  // points at the temporary /cook-session stub (Block 3 replaces it with the
  // real single-meal Cook session and owns the proper rewire).
  const handleCookNow = () => {
    router.push("/cook-session");
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
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
      <AddDishChooserSheet
        visible={addDishOpen}
        onClose={() => setAddDishOpen(false)}
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
          <FlatList<MealListItem>
            style={s.flex1}
            contentContainerStyle={s.scroll}
            data={visibleMeals}
            keyExtractor={(m) => m.id}
            ListHeaderComponent={
              <View>
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

                <View style={[s.controlsRow, s.controlsRowList]}>
                  <Text style={s.sectionLabel}>
                    {MEALS_CHIPS.find((c) => c.key === mealFilter)?.label}
                  </Text>
                  <SortDropdown
                    value={mealSort}
                    onChange={setMealSort}
                    disabledKeys={MEAL_DISABLED_SORT_KEYS}
                  />
                </View>
              </View>
            }
            renderItem={({ item }) => (
              <MealRow
                meal={item}
                onPress={() => handleOpenMeal(item.id)}
                onCookNow={handleCookNow}
                onAddToPlan={(mealId, mealTitle) =>
                  setAddToPlanFor({ mealId, mealTitle })
                }
                sortKey={mealSort}
              />
            )}
            ItemSeparatorComponent={() => <View style={s.rowGap} />}
            // Prefetch-ahead while still 50% of a viewport from the end
            // (matches the Dishes sub-tab; Hans-ruled threshold).
            onEndReachedThreshold={0.5}
            onEndReached={() => {
              if (mealsQuery.hasNextPage && !mealsQuery.isFetchingNextPage) {
                void mealsQuery.fetchNextPage();
              }
            }}
            ListEmptyComponent={
              mealsQuery.isLoading ? (
                <Text style={s.loadingText}>Loading…</Text>
              ) : mealsQuery.isError ? (
                <Text style={s.loadingText}>
                  Couldn’t load meals right now. Try again in a moment.
                </Text>
              ) : (
                <View style={s.empty}>
                  <Text style={s.emptyText}>{mealsEmptyCopy(mealFilter)}</Text>
                </View>
              )
            }
            ListFooterComponent={
              mealsQuery.isFetchingNextPage ? (
                <View style={s.footerLoading}>
                  <ActivityIndicator size="small" color={Colors.sage[700]} />
                </View>
              ) : null
            }
          />
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
                  <ActivityIndicator size="small" color={Colors.sage[700]} />
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
    backgroundColor: Colors.neutral[200],
    borderRadius: Radius.md,
    padding: 4,
    marginTop: Spacing[3],
    gap: 4,
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: Radius.md,
    alignItems: "center",
  },
  toggleBtnActive: {
    backgroundColor: Colors.sage[700],
  },
  toggleText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  toggleTextActive: {
    color: Colors.neutral[0],
  },
  scroll: {
    paddingTop: Spacing[3],
    paddingBottom: Spacing[8],
  },
  addBtn: {
    backgroundColor: Colors.sage[700],
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: 12,
    alignItems: "center",
  },
  addBtnText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  filterWrap: { marginTop: Spacing[2] },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
    marginTop: Spacing[3],
  },
  sectionLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  list: {
    marginTop: Spacing[3],
    gap: Spacing[2],
  },
  flex1: { flex: 1 },
  // FlatList header's controls row needs the bottom gap the old `s.list`
  // marginTop used to provide before the first row.
  controlsRowList: { marginBottom: Spacing[3] },
  rowGap: { height: Spacing[2] },
  footerLoading: { paddingVertical: Spacing[3], alignItems: "center" },
  loadingText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    paddingVertical: Spacing[4],
  },
  empty: {
    paddingVertical: Spacing[6],
    paddingHorizontal: Spacing[4],
    alignItems: "center",
  },
  emptyText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    lineHeight: 20,
  },
});
