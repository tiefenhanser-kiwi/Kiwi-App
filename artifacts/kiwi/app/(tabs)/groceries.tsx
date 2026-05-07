import React, { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { formatRelative } from "@/lib/date";
import { getGroceryLists } from "@/lib/stubs";
import {
  KColors,
  KPalette,
  KRadius,
  KSpacing,
  KType,
} from "@/constants/tokens";
import type { GroceryListSummary } from "@/lib/types";

type GrocerySortKey = "recent" | "plan" | "alpha";

const SORT_OPTIONS: Array<{ key: GrocerySortKey; label: string }> = [
  { key: "recent", label: "Most recent" },
  { key: "plan", label: "By plan" },
  { key: "alpha", label: "Alphabetical" },
];

export default function GroceriesTab() {
  const router = useRouter();
  const lists = useMemo(() => getGroceryLists(), []);

  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<GrocerySortKey>("recent");
  const [sortOpen, setSortOpen] = useState(false);

  const sorted = useMemo(() => {
    const filtered = query.trim()
      ? lists.filter((l) =>
          l.planName.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : lists;
    return [...filtered].sort((a, b) => {
      if (sortKey === "recent") return b.createdAt.localeCompare(a.createdAt);
      // "plan" + "alphabetical" both order by planName for WS5; WS7 will
      // distinguish them when we have a plan-grouping affordance.
      return a.planName.localeCompare(b.planName);
    });
  }, [lists, query, sortKey]);

  const handleViewList = (id: string) => {
    router.push({ pathname: "/grocery-list/[id]", params: { id } });
  };

  const handleGetList = () => {
    Alert.alert(
      "Coming in WS6 — list generation",
      "Generating a fresh grocery list from a meal plan requires the API workstream (POST /grocery-lists per PRD §12.3.2).",
    );
  };

  const handleOrderOnline = () => {
    Alert.alert(
      "Coming in WS6 — retailer integration",
      "Online ordering requires the retailer adapter pattern from PRD §12.12.",
    );
  };

  const handleReuse = () => {
    Alert.alert(
      "Coming in WS7 — list reuse",
      "Cloning a past list to a new draft requires the API client.",
    );
  };

  const currentSortLabel =
    SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? "Most recent";

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Groceries" subtitle="your saved lists" />
      <Screen>
        <View style={styles.controlsRow}>
          <View style={styles.searchWrap}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search lists…"
              placeholderTextColor={KColors.neutral[600]}
              style={styles.searchInput}
            />
          </View>
          <View style={styles.sortWrap}>
            <Pressable
              onPress={() => setSortOpen((o) => !o)}
              style={({ pressed }) => [
                styles.sortTrigger,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.sortTriggerLabel}>Sort: </Text>
              <Text style={styles.sortTriggerValue}>{currentSortLabel}</Text>
              <Text style={styles.chev}>{sortOpen ? "▴" : "▾"}</Text>
            </Pressable>
            {sortOpen && (
              <View style={styles.sortMenu}>
                {SORT_OPTIONS.map((o) => (
                  <Pressable
                    key={o.key}
                    onPress={() => {
                      setSortKey(o.key);
                      setSortOpen(false);
                    }}
                    style={({ pressed }) => [
                      styles.sortItem,
                      pressed && { backgroundColor: KColors.neutral[200] },
                    ]}
                  >
                    <Text
                      style={[
                        styles.sortItemText,
                        o.key === sortKey && {
                          color: KColors.sage[700],
                          fontWeight: KType.weight.semibold,
                        },
                      ]}
                    >
                      {o.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        </View>

        {sorted.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              Your grocery lists show up here. Create a meal plan to generate
              your first list.
            </Text>
            <Pressable
              onPress={() => router.push("/(tabs)/plans")}
              style={({ pressed }) => [
                styles.emptyBtn,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.emptyBtnText}>Open Plans</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.list}>
            {sorted.map((list) => (
              <ListCard
                key={list.id}
                list={list}
                onViewList={() => handleViewList(list.id)}
                onGetList={handleGetList}
                onOrderOnline={handleOrderOnline}
                onReuse={handleReuse}
              />
            ))}
          </View>
        )}
      </Screen>
    </View>
  );
}

type ListCardProps = {
  list: GroceryListSummary;
  onViewList: () => void;
  onGetList: () => void;
  onOrderOnline: () => void;
  onReuse: () => void;
};

function ListCard({
  list,
  onViewList,
  onGetList,
  onOrderOnline,
  onReuse,
}: ListCardProps) {
  return (
    <Pressable
      onPress={onViewList}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.92 }]}
    >
      <View style={styles.cardTopRow}>
        {list.isThisWeek ? (
          <View style={styles.thisWeekBadge}>
            <Text style={styles.thisWeekBadgeText}>This Week</Text>
          </View>
        ) : list.status === "draft" ? (
          <View style={styles.draftBadge}>
            <Text style={styles.draftBadgeText}>Draft</Text>
          </View>
        ) : (
          <View style={styles.pastBadge}>
            <Text style={styles.pastBadgeText}>Past</Text>
          </View>
        )}
      </View>
      <Text style={styles.planName} numberOfLines={2}>
        {list.planName}
      </Text>
      <Text style={styles.metaLine}>
        {list.itemCount} items · {formatRelative(list.createdAt)}
      </Text>

      <View style={styles.actionsRow}>
        {list.isThisWeek ? (
          <>
            <CardButton variant="primary" onPress={onViewList} label="View List" />
            <CardButton variant="outline" onPress={onGetList} label="Get List ✓" />
            <CardButton
              variant="terra"
              onPress={onOrderOnline}
              label="Order Online"
            />
          </>
        ) : (
          <>
            <CardButton variant="outline" onPress={onViewList} label="View List" />
            <CardButton variant="primary" onPress={onReuse} label="Reuse" />
          </>
        )}
      </View>
    </Pressable>
  );
}

function CardButton({
  variant,
  onPress,
  label,
}: {
  variant: "primary" | "outline" | "terra";
  onPress: () => void;
  label: string;
}) {
  const palette =
    variant === "primary"
      ? {
          bg: KColors.sage[700],
          text: KColors.neutral[0],
          border: KColors.sage[700],
        }
      : variant === "terra"
        ? {
            bg: KColors.terracotta[400],
            text: KColors.neutral[0],
            border: KColors.terracotta[400],
          }
        : {
            bg: "transparent",
            text: KColors.sage[700],
            border: KColors.sage[300],
          };

  return (
    <Pressable
      onPress={(e) => {
        // Stop propagation so tapping a button doesn't also fire the
        // card's onPress (which routes to View List).
        e.stopPropagation();
        onPress();
      }}
      style={({ pressed }) => [
        styles.cardBtn,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
        },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Text style={[styles.cardBtnText, { color: palette.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  controlsRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    marginBottom: KSpacing.md,
    zIndex: 10,
  },
  searchWrap: {
    flex: 1,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    paddingHorizontal: KSpacing.md,
    justifyContent: "center",
  },
  searchInput: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    paddingVertical: KSpacing.sm,
  },
  sortWrap: {
    position: "relative",
  },
  sortTrigger: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    paddingHorizontal: KSpacing.md,
    paddingVertical: 10,
  },
  sortTriggerLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  sortTriggerValue: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  chev: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    marginLeft: 4,
  },
  sortMenu: {
    position: "absolute",
    top: "100%",
    right: 0,
    marginTop: 4,
    minWidth: 160,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    paddingVertical: KSpacing.xs,
    zIndex: 20,
  },
  sortItem: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
  },
  sortItemText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
  },
  empty: {
    paddingTop: KSpacing.xxl,
    paddingHorizontal: KSpacing.lg,
    alignItems: "center",
    gap: KSpacing.lg,
  },
  emptyText: {
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    textAlign: "center",
    lineHeight: 22,
    fontFamily: "Inter_400Regular",
  },
  emptyBtn: {
    backgroundColor: KColors.sage[700],
    borderRadius: KRadius.lg,
    paddingHorizontal: KSpacing.xl,
    paddingVertical: 12,
  },
  emptyBtnText: {
    color: KColors.neutral[0],
    fontSize: KType.size.md,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  list: {
    gap: KSpacing.md,
  },
  card: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.xl,
    borderWidth: 1,
    borderColor: KPalette.border.default,
    padding: KSpacing.md,
    gap: KSpacing.xs,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
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
  pastBadge: {
    backgroundColor: KColors.neutral[300],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
  },
  pastBadgeText: {
    fontSize: 10,
    color: KColors.neutral[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  draftBadge: {
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
  },
  draftBadgeText: {
    fontSize: 10,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  planName: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginTop: KSpacing.xs,
  },
  metaLine: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
  },
  cardBtn: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 100,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 10,
    borderRadius: KRadius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  cardBtnText: {
    fontSize: KType.size.sm,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
