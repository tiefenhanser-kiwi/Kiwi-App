import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { FilterChipRow, PLAN_DISCOVERY_FILTER_OPTIONS } from "@/components/FilterChipRow";
import { Header } from "@/components/Header";
import { PlanRow } from "@/components/PlanRow";
import { Screen } from "@/components/Screen";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  asPlanDiscoveryFilters,
  getPlansPayload,
  type PlanDiscoveryFilter,
  type PlanRowData,
} from "@/lib/stubs";

export default function PlansTab() {
  const router = useRouter();
  const { user, setUiState } = useAuth();
  const { plans, currentPlan } = useApp();

  const hasAnyRealMeal = useMemo(() => {
    if (!currentPlan) return false;
    return (
      currentPlan.meals?.some(
        (m: { recipeId?: string }) => m.recipeId && m.recipeId !== "",
      ) ?? false
    );
  }, [currentPlan]);

  // Single-select (4H-2): always exactly one filter active. Persisted user
  // value first, else PRD §9.2.2 defaults (Featured for users with no saved
  // plans; My Plans otherwise). Take the first element of any persisted
  // multi-select array as a graceful migration. Computed once at mount;
  // setFilters takes over after.
  const initialFilters = useMemo<PlanDiscoveryFilter[]>(() => {
    const persisted = asPlanDiscoveryFilters(user?.lastPlansFilters);
    if (persisted.length > 0) return [persisted[0]];
    return plans.length > 0 ? ["my_plans"] : ["featured"];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [filters, setFilters] = useState<PlanDiscoveryFilter[]>(initialFilters);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("alpha");
  const [rows, setRows] = useState<PlanRowData[]>([]);
  const [loading, setLoading] = useState(false);

  // 250ms debounce on search input.
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
        const payload = await getPlansPayload();
        if (!cancelled) setRows(payload.plans);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleFilter = (key: PlanDiscoveryFilter) => {
    const next: PlanDiscoveryFilter[] = [key];
    setFilters(next);
    setUiState({ lastPlansFilters: next });
  };

  // OR semantics across selected chips, then substring search, then sort.
  // Stub data is empty so sort has no observable effect today; WS7 wires
  // real sort metadata onto PlanRowData when it lands.
  const visibleRows = useMemo(() => {
    if (filters.length === 0) return [];
    let out = rows.filter((r) => filters.includes(r.filterGroup));
    if (debouncedQuery) {
      out = out.filter((r) => {
        const hay = `${r.title} ${r.tags.join(" ")}`.toLowerCase();
        return hay.includes(debouncedQuery);
      });
    }
    return out;
  }, [rows, filters, debouncedQuery, sortKey]);

  const showThisWeek = !!currentPlan && hasAnyRealMeal;

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Plans" />
      <Screen>
        {showThisWeek && (
          <View style={s.thisWeekCard}>
            <View style={s.thisWeekBadge}>
              <Text style={s.thisWeekBadgeText}>This Week</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.thisWeekTitle} numberOfLines={1}>
                {currentPlan?.name}
              </Text>
              <Text style={s.thisWeekMeta}>
                {currentPlan?.meals.length ?? 0} meals
              </Text>
            </View>
            <Pressable
              onPress={() => {
                if (currentPlan) router.push(`/plan/${currentPlan.id}`);
              }}
              style={({ pressed }) => [s.openBtn, pressed && { opacity: 0.7 }]}
            >
              <Text style={s.openText}>Open</Text>
            </Pressable>
          </View>
        )}

        <View style={s.filterWrap}>
          <FilterChipRow
            options={PLAN_DISCOVERY_FILTER_OPTIONS}
            selected={filters}
            onToggle={toggleFilter}
          />
        </View>

        <View style={s.controlsRow}>
          <View style={s.searchWrap}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search plans…"
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
                Your saved plans live here. Try the Kitchen Wizard or browse
                Featured plans to get started.
              </Text>
              <View style={s.emptyButtons}>
                <Pressable
                  onPress={() => router.push("/wizard")}
                  style={({ pressed }) => [
                    s.btnPrimary,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={s.btnPrimaryText}>Open Kitchen Wizard</Text>
                </Pressable>
                <Pressable
                  onPress={() => setFilters(["featured"])}
                  style={({ pressed }) => [
                    s.btnSecondary,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={s.btnSecondaryText}>Browse Featured</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            visibleRows.map((row) => <PlanRow key={row.id} plan={row} />)
          )}
        </View>
      </Screen>
    </View>
  );
}

const s = StyleSheet.create({
  thisWeekCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    borderWidth: 1,
    borderColor: KColors.terracotta[200],
    marginTop: KSpacing.md,
    marginBottom: KSpacing.lg,
  },
  thisWeekBadge: {
    backgroundColor: KColors.terracotta[400],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
  },
  thisWeekBadgeText: {
    fontSize: 10,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  thisWeekTitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  thisWeekMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  openBtn: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: 8,
    borderRadius: KRadius.md,
    backgroundColor: KColors.sage[700],
  },
  openText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
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
    backgroundColor: KPalette.bg.card,
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
    flexDirection: "row",
    gap: KSpacing.sm,
  },
  btnPrimary: {
    backgroundColor: KColors.sage[700],
    paddingHorizontal: KSpacing.md,
    paddingVertical: 10,
    borderRadius: KRadius.md,
  },
  btnPrimaryText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  btnSecondary: {
    backgroundColor: KPalette.bg.card,
    paddingHorizontal: KSpacing.md,
    paddingVertical: 10,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
  },
  btnSecondaryText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
