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
import { PlanPreviewModal } from "@/components/PlanPreviewModal";
import { PlanRow } from "@/components/PlanRow";
import { Screen } from "@/components/Screen";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { usePlans } from "@/hooks/usePlans";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useTemplatePreview } from "@/hooks/useTemplatePreview";
import { asPlanDiscoveryFilters, type PlanFilterKey } from "@/lib/api/plans";
import { plansFilterDefault } from "@/lib/plans/filterDefault";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";

export default function PlansTab() {
  const router = useRouter();
  const { user, setUiState } = useAuth();
  const { useTemplateAsPlan } = useApp();

  // WS7-4-B c11 — Use Plan preview overlay state. The PlanRow source
  // dispatcher (c9) routes template-source rows here; the modal fetches
  // the template detail and surfaces a Use Plan CTA whose tap mutates
  // and navigates to the freshly-created Instance.
  const preview = useTemplatePreview();
  const handleUseFromPreview = async (templateId: string) => {
    const { instanceId } = await useTemplateAsPlan(templateId);
    router.push({ pathname: "/plan/[id]", params: { id: instanceId } });
  };

  // usePlans(['my_plans']) — supplies the saved-plan count for the default
  // filter. Cache-shared with the Home Plan Discovery card and (when the
  // selected filter is my_plans) the main list query below.
  const myPlans = usePlans(["my_plans"]);

  // Single-select filter (Ruling B / 4H-2). Seeded at mount from a
  // persisted lastPlansFilters, else R1's count-based default. The
  // saved-plan count isn't known synchronously at mount, so the
  // count-based default is finalised once myPlans resolves (effect below).
  const [filters, setFilters] = useState<PlanFilterKey[]>(() =>
    plansFilterDefault(asPlanDiscoveryFilters(user?.lastPlansFilters), 0),
  );
  const [defaultApplied, setDefaultApplied] = useState(false);
  useEffect(() => {
    if (defaultApplied || !myPlans.data) return;
    setDefaultApplied(true);
    const persisted = asPlanDiscoveryFilters(user?.lastPlansFilters);
    // A persisted filter already seeded the initial state synchronously —
    // only the count-based default needs the resolved myPlans data.
    if (persisted.length > 0) return;
    setFilters(plansFilterDefault(persisted, myPlans.data.plans.length));
  }, [myPlans.data, defaultApplied, user?.lastPlansFilters]);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("alpha");

  // 250ms debounce on search input.
  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedQuery(query.trim().toLowerCase()),
      250,
    );
    return () => clearTimeout(t);
  }, [query]);

  const plansQuery = usePlans(filters);
  // WS7-6 (E) Block 2 §6 — focus-driven backstop for returning to the tab.
  useRefetchOnFocus(plansQuery);
  // activeThisWeek is server-resolved on every GET /plans response (PRD
  // §9.2.1) — the pinned This Week callout reads it off the list query.
  const activeThisWeek = plansQuery.data?.activeThisWeek ?? null;

  const toggleFilter = (key: PlanFilterKey) => {
    const next: PlanFilterKey[] = [key];
    // A user choice — stop the count-based default from overriding it if
    // myPlans resolves late.
    setDefaultApplied(true);
    setFilters(next);
    setUiState({ lastPlansFilters: next });
  };

  // The server already filtered by the selected chip; search + sort run
  // client-side over the result (Ruling C — D-WS7-048 moves these to
  // server params in WS9).
  const visibleRows = useMemo(() => {
    let out = [...(plansQuery.data?.plans ?? [])];
    if (debouncedQuery) {
      out = out.filter((r) => {
        const hay = `${r.name} ${r.tags.join(" ")}`.toLowerCase();
        return hay.includes(debouncedQuery);
      });
    }
    // Only the A–Z sort has a backing field on PlanListItem; the cook-stat
    // sort keys need server metadata that GET /plans does not carry yet
    // (D-WS7-048). They fall through as a no-op until WS9.
    if (sortKey === "alpha") {
      out.sort((a, b) => a.name.localeCompare(b.name));
    }
    return out;
  }, [plansQuery.data, debouncedQuery, sortKey]);

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Plans" />
      <Screen>
        {activeThisWeek && (
          <View style={s.thisWeekCard}>
            <View style={s.thisWeekBadge}>
              <Text style={s.thisWeekBadgeText}>This Week</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.thisWeekTitle} numberOfLines={1}>
                {activeThisWeek.name}
              </Text>
            </View>
            <Pressable
              onPress={() =>
                router.push({
                  pathname: "/plan/[id]",
                  params: { id: activeThisWeek.id },
                })
              }
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
          {plansQuery.isLoading ? (
            <Text style={s.loadingText}>Loading…</Text>
          ) : plansQuery.isError ? (
            <Text style={s.loadingText}>
              Couldn’t load plans right now. Try again in a moment.
            </Text>
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
                  onPress={() => toggleFilter("featured")}
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
            visibleRows.map((row) => (
              <PlanRow
                key={row.id}
                plan={row}
                onPreviewTemplate={preview.open}
              />
            ))
          )}
        </View>
      </Screen>
      <PlanPreviewModal
        visible={preview.visible}
        templateId={preview.templateId}
        onClose={preview.close}
        onUsePlan={handleUseFromPreview}
      />
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
