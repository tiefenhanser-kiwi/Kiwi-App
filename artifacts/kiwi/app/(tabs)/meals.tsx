import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  FilterChipRow,
  type FilterChipOption,
} from "@/components/FilterChipRow";
import { Header } from "@/components/Header";
import { MealRow } from "@/components/MealRow";
import { Screen } from "@/components/Screen";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { useAuth } from "@/contexts/AuthContext";
import { type MealsFilter } from "@/lib/auth";
import { getMealsPayload, type MealRowData } from "@/lib/stubs";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

const MEALS_FILTER_KEYS: readonly MealsFilter[] = ["my_meals", "all_meals"];

const MEALS_FILTER_OPTIONS: FilterChipOption<MealsFilter>[] = [
  { key: "my_meals", label: "My Meals" },
  { key: "all_meals", label: "All Meals" },
];

function asMealsFilters(arr: string[] | undefined): MealsFilter[] {
  if (!arr) return [];
  return arr.filter((x): x is MealsFilter =>
    (MEALS_FILTER_KEYS as readonly string[]).includes(x),
  );
}

export default function MealsTab() {
  const { user, setUiState } = useAuth();

  // Single-select (4H-2): always exactly one filter active. Persisted user
  // value first, else PRD §9.3.2 default ("All Meals" for users with no
  // saved meals; "My Meals" otherwise). Take the first element of any
  // persisted multi-select array as a graceful migration. Stub data is
  // empty so we always default to "all_meals" today; WS7 wires a real
  // saved-meals count here.
  const initialFilters = useMemo<MealsFilter[]>(() => {
    const persisted = asMealsFilters(user?.lastMealsFilters);
    if (persisted.length > 0) return [persisted[0]];
    return ["all_meals"];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [filters, setFilters] = useState<MealsFilter[]>(initialFilters);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("last_cooked");
  const [rows, setRows] = useState<MealRowData[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedQuery(query.trim().toLowerCase()),
      250,
    );
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const payload = await getMealsPayload();
        if (!cancelled) setRows(payload.meals);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleFilter = (key: MealsFilter) => {
    const next: MealsFilter[] = [key];
    setFilters(next);
    setUiState({ lastMealsFilters: next });
  };

  // "All Meals" matches everything; otherwise filter to my_meals only.
  // Stub data is empty so this has no observable effect today.
  const visibleRows = useMemo(() => {
    if (filters.length === 0) return [];
    let out = filters.includes("all_meals")
      ? rows
      : rows.filter((r) => r.filterGroup === "my_meals");
    if (debouncedQuery) {
      out = out.filter((r) => {
        const hay = `${r.title} ${r.cuisineTag ?? ""}`.toLowerCase();
        return hay.includes(debouncedQuery);
      });
    }
    return out;
  }, [rows, filters, debouncedQuery, sortKey]);

  // Add Meal flow ships in WS6 per PRD §10. Route stub for now.
  const handleAddMeal = () => {
    Alert.alert(
      "Add Meal",
      "Add Meal flow ships in WS6 (import a recipe or build from scratch).",
    );
  };
  const handleImportRecipe = () => {
    Alert.alert("Import a Recipe", "Recipe import ships in WS6.");
  };
  const handleCreateManually = () => {
    Alert.alert("Create Manually", "Manual meal creation ships in WS6.");
  };
  const handleOpenMeal = () => {
    Alert.alert(
      "Meal Detail",
      "Meal Detail page ships in WS6 alongside Cook Mode.",
    );
  };
  const handleCookNow = () => {
    Alert.alert("Cook Now", "Cook Mode ships in WS6.");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="My Meals" />
      <Screen>
        <View style={s.topSection}>
          <Pressable
            onPress={handleAddMeal}
            style={({ pressed }) => [
              s.addBtn,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={s.addBtnText}>+ Add Meal</Text>
          </Pressable>
          <Text style={s.topSubText}>
            Add by importing a recipe or building one from scratch
          </Text>
        </View>

        <View style={s.filterWrap}>
          <FilterChipRow
            options={MEALS_FILTER_OPTIONS}
            selected={filters}
            onToggle={toggleFilter}
          />
        </View>

        <View style={s.controlsRow}>
          <View style={s.searchWrap}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search meals…"
              placeholderTextColor={KColors.neutral[600]}
              style={s.searchInput}
            />
          </View>
          <SortDropdown value={sortKey} onChange={setSortKey} />
        </View>

        <View style={s.list}>
          {loading ? (
            <Text style={s.loadingText}>Loading…</Text>
          ) : visibleRows.length === 0 ? (
            <View style={s.empty}>
              <Text style={s.emptyText}>
                Your meals show up here. Add one by importing a recipe,
                building from scratch, or saving from public meals.
              </Text>
              <View style={s.emptyButtons}>
                <Pressable
                  onPress={handleImportRecipe}
                  style={({ pressed }) => [
                    s.btnPrimary,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={s.btnPrimaryText}>Import a Recipe</Text>
                </Pressable>
                <Pressable
                  onPress={handleCreateManually}
                  style={({ pressed }) => [
                    s.btnSecondary,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={s.btnSecondaryText}>Create Manually</Text>
                </Pressable>
                <Pressable
                  onPress={() => setFilters(["all_meals"])}
                  style={({ pressed }) => [
                    s.btnSecondary,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={s.btnSecondaryText}>Browse All Meals</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            visibleRows.map((row) => (
              <MealRow
                key={row.id}
                meal={row}
                onPress={handleOpenMeal}
                onViewDetails={handleOpenMeal}
                onCookNow={handleCookNow}
              />
            ))
          )}
        </View>
      </Screen>
    </View>
  );
}

const s = StyleSheet.create({
  topSection: {
    marginTop: KSpacing.md,
    marginBottom: KSpacing.md,
    gap: 6,
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
  topSubText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  filterWrap: { marginTop: KSpacing.sm },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    marginTop: KSpacing.md,
  },
  searchWrap: {
    flex: 1,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.md,
    paddingVertical: 4,
  },
  searchInput: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    paddingVertical: 6,
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
    alignItems: "center",
    gap: KSpacing.lg,
  },
  emptyText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: KSpacing.lg,
  },
  emptyButtons: {
    gap: KSpacing.sm,
    width: "100%",
    paddingHorizontal: KSpacing.lg,
  },
  btnPrimary: {
    backgroundColor: KColors.sage[700],
    paddingHorizontal: KSpacing.md,
    paddingVertical: 12,
    borderRadius: KRadius.md,
    alignItems: "center",
  },
  btnPrimaryText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  btnSecondary: {
    backgroundColor: KColors.neutral[0],
    paddingHorizontal: KSpacing.md,
    paddingVertical: 12,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    alignItems: "center",
  },
  btnSecondaryText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
