import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { FilterChipRow, PLAN_DISCOVERY_FILTER_OPTIONS } from "@/components/FilterChipRow";
import { PlanCardSmall } from "@/components/PlanCardSmall";
import { PlanPreviewModal } from "@/components/PlanPreviewModal";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { usePlans } from "@/hooks/usePlans";
import { useTemplatePreview } from "@/hooks/useTemplatePreview";
import { asPlanDiscoveryFilters, type PlanFilterKey } from "@/lib/api/plans";
import { homeFilterDefault } from "@/lib/home/filterDefault";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

// PRD §4.2.5 — the Home discovery card previews up to five plans.
const HOME_DISCOVERY_PREVIEW_LIMIT = 5;

// WS7-3 C2 Commit 2 — the Home Plan Discovery card. Sources from
// usePlans([filter]) (Phase 2 Ruling A): the chip is the query key, so
// switching filters is instant and the cache is shared with the Plans tab.
export function PlanDiscoveryCard() {
  const { user, setUiState } = useAuth();
  const { useTemplateAsPlan } = useApp();
  const router = useRouter();

  // WS7-4-B c12 — Use Plan preview overlay state. Owned by the discovery
  // card (not the home screen) so the prop drill into PlanCardSmall stays
  // short and the home screen doesn't need to know about template-preview
  // state. The Use Plan tap on PlanCardSmall navigates directly via its
  // own router.push; this modal handles the Preview-then-Use chain.
  const preview = useTemplatePreview();
  const handleUseFromPreview = async (templateId: string) => {
    const { instanceId } = await useTemplateAsPlan(templateId);
    router.push({ pathname: "/plan/[id]", params: { id: instanceId } });
  };

  // Single-select (4H-2 / D-WS7-049): exactly one filter active. Seeded
  // once at mount — a persisted lastPlanDiscoveryFilters wins, else R1's
  // Featured default. setFilters takes over after first interaction.
  const [filters, setFilters] = useState<PlanFilterKey[]>(() =>
    homeFilterDefault(asPlanDiscoveryFilters(user?.lastPlanDiscoveryFilters)),
  );

  // First-time-user expansion (R3): expand when the user has no saved
  // plans. Derived from usePlans(['my_plans']) — cache-shared with the
  // Plans tab. Collapsed while that query loads (avoids a layout jump on
  // the common returning-user path); the data-derived default is applied
  // exactly once, then the header toggle is under user control.
  const myPlans = usePlans(["my_plans"]);
  const [expanded, setExpanded] = useState(false);
  const [defaultApplied, setDefaultApplied] = useState(false);
  useEffect(() => {
    if (defaultApplied || !myPlans.data) return;
    setExpanded(myPlans.data.plans.length === 0);
    setDefaultApplied(true);
  }, [myPlans.data, defaultApplied]);

  const plansQuery = usePlans(filters);
  const visiblePlans = (plansQuery.data?.plans ?? []).slice(
    0,
    HOME_DISCOVERY_PREVIEW_LIMIT,
  );

  const toggleFilter = (key: PlanFilterKey) => {
    const next: PlanFilterKey[] = [key];
    setFilters(next);
    setUiState({ lastPlanDiscoveryFilters: next });
  };

  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => setExpanded((x) => !x)}
        style={styles.header}
      >
        <View style={styles.headerLeft}>
          <View style={styles.thumbDot} />
          <View>
            <Text style={styles.title}>Browse Plans</Text>
            <Text style={styles.sub}>
              Featured, Top Rated, My Plans, Hosting & Events
            </Text>
          </View>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.toggleLabel}>{expanded ? "Hide" : "Show"}</Text>
          <Text style={styles.chev}>{expanded ? "▴" : "▾"}</Text>
        </View>
      </Pressable>

      {expanded && (
        <View style={styles.body}>
          <FilterChipRow
            options={PLAN_DISCOVERY_FILTER_OPTIONS}
            selected={filters}
            onToggle={toggleFilter}
          />
          <View style={styles.cardList}>
            {plansQuery.isLoading ? (
              <Text style={styles.emptyText}>Loading…</Text>
            ) : plansQuery.isError ? (
              <Text style={styles.emptyText}>
                Couldn’t load plans right now. Try again in a moment.
              </Text>
            ) : visiblePlans.length === 0 ? (
              <Text style={styles.emptyText}>
                No plans match this filter yet. Try the Kitchen Wizard to
                build one.
              </Text>
            ) : (
              visiblePlans.map((p) => (
                <PlanCardSmall
                  key={p.id}
                  plan={p}
                  onPreviewTemplate={preview.open}
                  onUseTemplate={useTemplateAsPlan}
                />
              ))
            )}
          </View>
        </View>
      )}
      <PlanPreviewModal
        visible={preview.visible}
        templateId={preview.templateId}
        onClose={preview.close}
        onUsePlan={handleUseFromPreview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    padding: Spacing[3],
    borderWidth: 1,
    borderColor: Colors.neutral[300],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    flex: 1,
  },
  thumbDot: {
    width: 36,
    height: 36,
    borderRadius: 9,
    backgroundColor: Colors.sage[100],
  },
  title: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  sub: {
    fontSize: 10,
    color: Colors.sage[700],
    marginTop: 1,
    fontFamily: Typography.face.sans[400],
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  toggleLabel: {
    fontSize: 10,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
  chev: {
    fontSize: 14,
    color: Colors.sage[700],
    fontWeight: "700",
  },
  body: {
    marginTop: Spacing[3],
    gap: Spacing[2],
  },
  cardList: {
    gap: Spacing[2],
    marginTop: Spacing[2],
  },
  emptyText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    paddingVertical: Spacing[3],
    textAlign: "center",
    lineHeight: 16,
  },
});
