import React, { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { FilterChipRow } from "@/components/FilterChipRow";
import { PlanCardSmall } from "@/components/PlanCardSmall";
import { useAuth } from "@/contexts/AuthContext";
import { getHomePayload, type PlanDiscoveryCard, type PlanDiscoveryFilter }
  from "@/lib/stubs";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

type Props = {
  // First-time users get the card expanded by default. Per PRD §3.6,
  // this is keyed off whether the user has any saved filter preference
  // yet. 3F replaces this with `user.lastPlanDiscoveryFilters`.
  defaultExpanded?: boolean;
  // 3F replaces local-state filters with persisted user state.
  initialFilters?: PlanDiscoveryFilter[];
};

export function PlanDiscoveryCard({
  defaultExpanded = false,
  initialFilters,
}: Props) {
  const { setUiState } = useAuth();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [filters, setFilters] = useState<PlanDiscoveryFilter[]>(
    initialFilters ?? ["featured"],
  );
  const [cards, setCards] = useState<PlanDiscoveryCard[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch on mount. Stub returns [] today; WS7 fills it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const payload = await getHomePayload();
        if (!cancelled) setCards(payload.planDiscoveryCards);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleFilter = (key: PlanDiscoveryFilter) => {
    setFilters((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      setUiState({ lastPlanDiscoveryFilters: next });
      return next;
    });
  };

  // OR semantics per PRD §4.2.5: a card matches if ANY of its badge or
  // tag mappings hits a selected filter. Today the stub is empty so this
  // always returns []. Real filtering logic is intentionally simple here;
  // server-side filtering takes over in WS7.
  const visibleCards = useMemo(() => {
    if (filters.length === 0) return cards;
    return cards.filter(
      (c) => c.badge !== null && filters.includes(c.badge),
    );
  }, [cards, filters]);

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
          <FilterChipRow selected={filters} onToggle={toggleFilter} />
          <View style={styles.cardList}>
            {loading ? (
              <Text style={styles.emptyText}>Loading…</Text>
            ) : visibleCards.length === 0 ? (
              <Text style={styles.emptyText}>
                {filters.length === 0
                  ? "Pick a filter to see plans."
                  : "No plans match these filters yet. Try the Kitchen Wizard to build one."}
              </Text>
            ) : (
              visibleCards.map((c) => (
                <PlanCardSmall key={c.planId} card={c} />
              ))
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    flex: 1,
  },
  thumbDot: {
    width: 36,
    height: 36,
    borderRadius: 9,
    backgroundColor: KColors.sage[100],
  },
  title: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  sub: {
    fontSize: 10,
    color: KColors.sage[700],
    marginTop: 1,
    fontFamily: "Inter_400Regular",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  toggleLabel: {
    fontSize: 10,
    color: KColors.sage[700],
    fontFamily: "Inter_500Medium",
  },
  chev: {
    fontSize: 14,
    color: KColors.sage[700],
    fontWeight: "700",
  },
  body: {
    marginTop: KSpacing.md,
    gap: KSpacing.sm,
  },
  cardList: {
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
  },
  emptyText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    paddingVertical: KSpacing.md,
    textAlign: "center",
    lineHeight: 16,
  },
});
