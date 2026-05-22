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
import { useGroceryLists } from "@/hooks/useGroceryLists";
import { formatRelative } from "@/lib/date";
import type { GroceryListListItem } from "@/lib/api/groceries";
import {
  KColors,
  KPalette,
  KRadius,
  KSpacing,
  KType,
} from "@/constants/tokens";

type GrocerySortKey = "recent" | "plan" | "alpha";

const SORT_OPTIONS: Array<{ key: GrocerySortKey; label: string }> = [
  { key: "recent", label: "Most recent" },
  { key: "plan", label: "By plan" },
  { key: "alpha", label: "Alphabetical" },
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Client-side proxy for the missing `isThisWeek` field on GroceryListListItem
// (the server's new renamed-flat shape doesn't carry it; PRD §12.14 status
// vocab is deferred to D-WS7-046). Used only to drive the 3-button "current
// list" action row vs the 2-button past-list row.
function isCurrentWeek(list: GroceryListListItem): boolean {
  if (!list.lastGeneratedAt) return false;
  const t = Date.parse(list.lastGeneratedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < WEEK_MS;
}

// D5 — single status badge, raw server enum title-cased. Returns null when
// the field is empty so the badge slot collapses.
function statusBadgeLabel(status: string): string | null {
  if (!status) return null;
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

export default function GroceriesTab() {
  const router = useRouter();
  const listsQuery = useGroceryLists();
  const lists = listsQuery.data ?? [];

  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<GrocerySortKey>("recent");
  const [sortOpen, setSortOpen] = useState(false);

  const sorted = useMemo(() => {
    const filtered = query.trim()
      ? lists.filter((l) =>
          l.title.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : lists;
    return [...filtered].sort((a, b) => {
      if (sortKey === "recent") return b.createdAt.localeCompare(a.createdAt);
      // "plan" + "alphabetical" both order by title (the GroceryListListItem
      // has no separate plan-name field — the title is the canonical label).
      return a.title.localeCompare(b.title);
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

        {listsQuery.isLoading ? (
          <Text style={styles.loadingText}>Loading…</Text>
        ) : listsQuery.isError ? (
          <Text style={styles.loadingText}>
            Couldn’t load grocery lists right now. Try again in a moment.
          </Text>
        ) : sorted.length === 0 ? (
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
  list: GroceryListListItem;
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
  const badge = statusBadgeLabel(list.status);
  const isCurrent = isCurrentWeek(list);

  return (
    <Pressable
      onPress={onViewList}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.92 }]}
    >
      {badge && (
        <View style={styles.cardTopRow}>
          <View style={styles.statusBadge}>
            <Text style={styles.statusBadgeText}>{badge}</Text>
          </View>
        </View>
      )}
      <Text style={styles.planName} numberOfLines={2}>
        {list.title}
      </Text>
      <Text style={styles.metaLine}>
        {list.itemCount} items · {formatRelative(list.createdAt)}
      </Text>

      <View style={styles.actionsRow}>
        {isCurrent ? (
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
  loadingText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    paddingVertical: KSpacing.lg,
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
  statusBadge: {
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
  },
  statusBadgeText: {
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
