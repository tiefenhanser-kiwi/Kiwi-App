// BOOK-1C1 (D-WS9-312) — the in-app Kiwi Cookbook: its own full screen (a
// stack route, no tab bar), live by November 16.
//
// Top to bottom: the header ("Cookbook" / "N meals that fit your allergies"),
// the search field, the seasonal band (useSeasonBand), the chip row (Filters + the
// quick chips), the count and the sort, then the cards (CookbookResults).
//
// State lives HERE and nowhere else: the search text (debounced 250 ms, the
// Plans tab's pattern), the filters (a browse, not a preference — they reset
// when the screen closes) and the sort. Every rule about turning that state
// into a request is in lib/cookbook/query.ts, which is tested; app/** is not
// (D-WS9-164).
//
// Members only (GET /cookbook/* refuses a guest token); a lapsed account
// browses (D-WS9-270) — only the Ask Kiwi helper is an AI call.

import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";

import { Chip } from "@/components/Chip";
import { CookbookFilterSheet } from "@/components/CookbookFilterSheet";
import { CookbookResults, UPDATING_OPACITY } from "@/components/CookbookResults";
import { Header } from "@/components/Header";
import { SeasonBand } from "@/components/SeasonBand";
import { SortDropdown } from "@/components/SortDropdown";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useCookbookCount, useCookbookMeals } from "@/hooks/useCookbook";
import { useSeasonBand } from "@/hooks/useSeasonBand";
import { getPreferences, type UserPreferences } from "@/lib/api/me";
import {
  activeFilterCount,
  COOKBOOK_SORT_OPTIONS,
  cuisineQuickChips,
  EMPTY_FILTERS,
  FIXED_QUICK_CHIPS,
  hasAnyFilter,
  isQuickOn,
  mealCountLabel,
  toggleQuick,
  type CookbookFilters,
  type CookbookSort,
} from "@/lib/cookbook/query";

export default function CookbookScreen() {
  const router = useRouter();

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  // 250ms debounce on the search input (app/(tabs)/plans.tsx's pattern).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const [filters, setFilters] = useState<CookbookFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<CookbookSort>("popular");
  const [sheetOpen, setSheetOpen] = useState(false);

  const results = useCookbookMeals({ q: debounced, filters, sort });
  // The header's N: every meal this user can see, no query, no filter.
  const eligible = useCookbookCount({}, true);
  const prefsQuery = useQuery<UserPreferences>({
    queryKey: ["me", "preferences"],
    queryFn: getPreferences,
  });

  const band = useSeasonBand();

  const cuisineFacet = results.facets?.cuisines ?? [];
  const quickChips = useMemo(
    () => [...FIXED_QUICK_CHIPS, ...cuisineQuickChips(cuisineFacet, filters.cuisines)],
    [cuisineFacet, filters.cuisines],
  );
  const badge = activeFilterCount(filters);

  const header = (
    <View style={s.headerBlock}>
      <View style={s.searchWrap}>
        <Feather name="search" size={18} color={Colors.neutral[700]} />
        <TextInput
          style={s.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search meals or ingredients"
          placeholderTextColor={Palette.text.placeholder}
          returnKeyType="search"
          autoCorrect={false}
          accessibilityLabel="Search meals or ingredients"
        />
        {search.length > 0 ? (
          <Pressable
            onPress={() => setSearch("")}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Feather name="x-circle" size={18} color={Colors.neutral[600]} />
          </Pressable>
        ) : null}
      </View>

      {/* Part C — the seasonal band: a promotion that opens its collection,
          never a filter on this list. */}
      {band.season ? (
        <SeasonBand
          season={band.season}
          onOpen={() =>
            router.push({ pathname: "/cookbook-season", params: { tag: band.season!.tag } })
          }
          onDismiss={band.dismiss}
        />
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.chipRow}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={() => setSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={badge > 0 ? `Filters, ${badge} on` : "Filters"}
          style={({ pressed }) => [s.filtersBtn, badge > 0 && s.filtersBtnOn, pressed && { opacity: 0.85 }]}
        >
          <Feather name="sliders" size={15} color={badge > 0 ? Colors.neutral[0] : Colors.neutral[900]} />
          <Text style={[s.filtersText, badge > 0 && s.filtersTextOn]}>Filters</Text>
          {badge > 0 ? (
            <View style={s.badge}>
              <Text style={s.badgeText}>{badge}</Text>
            </View>
          ) : null}
        </Pressable>
        {quickChips.map((chip) => (
          <Chip
            key={chip.kind === "cuisine" ? `c:${chip.token}` : chip.kind}
            label={chip.label}
            selected={isQuickOn(filters, chip)}
            onPress={() => setFilters((f) => toggleQuick(f, chip))}
          />
        ))}
      </ScrollView>

      <View style={s.countRow}>
        {/* BOOK-1C2 — while the new filters load, the held count is dimmed
            with a spinner beside it: it is the old filters' number, not
            the answer (lib/cookbook/resultQuery.ts). */}
        <View
          style={s.countWrap}
          accessibilityLiveRegion="polite"
          aria-busy={results.updating}
          testID="cookbook-count"
        >
          <Text style={[s.count, results.updating && s.countUpdating]}>
            {results.total === null ? " " : mealCountLabel(results.total)}
          </Text>
          {results.updating ? (
            <ActivityIndicator
              size="small"
              color={Colors.sage[700]}
              accessibilityLabel="Updating"
              testID="cookbook-count-updating"
            />
          ) : null}
        </View>
        <SortDropdown<CookbookSort> value={sort} onChange={setSort} options={COOKBOOK_SORT_OPTIONS} />
      </View>
    </View>
  );

  return (
    <View style={s.screen}>
      <Header
        showBack
        title="Cookbook"
        subtitle={
          eligible.data === undefined
            ? "Meals that fit your allergies"
            : `${mealCountLabel(eligible.data)} that fit your allergies`
        }
      />
      <CookbookResults
        results={results}
        header={header}
        searchText={search}
        onClearFilters={hasAnyFilter(filters) ? () => setFilters(EMPTY_FILTERS) : undefined}
      />
      <CookbookFilterSheet
        visible={sheetOpen}
        filters={filters}
        q={debounced}
        cuisines={cuisineFacet}
        allergies={prefsQuery.data?.allergiesAndAvoidances ?? null}
        onApply={(next) => {
          setFilters(next);
          setSheetOpen(false);
        }}
        onClose={() => setSheetOpen(false)}
        onOpenProfile={() => {
          setSheetOpen(false);
          router.push("/preferences");
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.neutral[100] },
  headerBlock: { paddingTop: Spacing[2], paddingBottom: Spacing[3], gap: Spacing[3] },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    height: 44,
    paddingHorizontal: Spacing[3],
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Palette.border.strong,
    backgroundColor: Palette.background.card,
  },
  searchInput: {
    flex: 1,
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    padding: 0,
  },
  chipRow: { gap: Spacing[2], alignItems: "center", paddingRight: Spacing[4] },
  filtersBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Palette.chip.default.border,
    backgroundColor: Palette.chip.default.background,
  },
  filtersBtnOn: {
    backgroundColor: Palette.chip.selected.background,
    borderColor: Palette.chip.selected.border,
  },
  filtersText: {
    fontSize: Typography.fontSize.sm,
    color: Palette.chip.default.text,
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  filtersTextOn: { color: Palette.chip.selected.text },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.neutral[0],
  },
  badgeText: {
    fontSize: Typography.fontSize.xxs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[700],
    fontWeight: Typography.fontWeight.bold,
  },
  countRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
  },
  countWrap: { flexDirection: "row", alignItems: "center", gap: Spacing[2] },
  count: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  countUpdating: { opacity: UPDATING_OPACITY },
});
