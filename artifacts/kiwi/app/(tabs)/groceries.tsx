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
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { formatRelative } from "@/lib/date";
import {
  chipLabel,
  planLinkTarget,
  type GroceryListListItem,
} from "@/lib/api/groceries";
import {
  Colors,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";

// WS7-7-A B6 — sort vocabulary matches the Get-Groceries picker (Recent / A–Z).
// The old "By plan" option was a no-op (it sorted by title, same as A–Z — the
// list row carries no separate plan-name field), so it's dropped.
type GrocerySortKey = "recent" | "alpha";

const SORT_OPTIONS: Array<{ key: GrocerySortKey; label: string }> = [
  { key: "recent", label: "Recent" },
  { key: "alpha", label: "A–Z" },
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Client-side proxy for the action-row split (3-button "current list" vs
// 2-button past-list). WS7-6 (E) Block 2: the BADGE now uses the server's
// list.isActiveThisWeek (resolver-derived single winner); this date proxy
// remains for the action row only — see D-WS7-105 in kiwi_ws6_plan.md §6
// (resolved for badge, retained for action row pending a dedicated
// status-vocabulary pass).
function isCurrentWeek(list: GroceryListListItem): boolean {
  if (!list.lastGeneratedAt) return false;
  const t = Date.parse(list.lastGeneratedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < WEEK_MS;
}

export default function GroceriesTab() {
  const router = useRouter();
  const listsQuery = useGroceryLists();
  // WS7-6 (E) Block 2 §6 — focus-driven backstop for returning to the tab.
  useRefetchOnFocus(listsQuery);
  const lists = listsQuery.data ?? [];

  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<GrocerySortKey>("recent");

  const sorted = useMemo(() => {
    const filtered = query.trim()
      ? lists.filter((l) =>
          l.title.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : lists;
    return [...filtered].sort((a, b) =>
      sortKey === "recent"
        ? b.createdAt.localeCompare(a.createdAt) // newest first
        : a.title.localeCompare(b.title), // A–Z
    );
  }, [lists, query, sortKey]);

  const handleViewList = (id: string) => {
    router.push({ pathname: "/grocery-list/[id]", params: { id } });
  };

  // WS7-7-A B6 item 7 — interim placeholder; no retailer wiring (the `ordered`
  // status stays reserved for the future retailer flow, D-WS7-125).
  const handleOrderOnline = () => {
    Alert.alert("Online ordering — coming soon.");
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header title="Groceries" subtitle="your saved lists" />
      <Screen>
        {/* WS7-7-A B6 — search + Recent/A–Z toggle, matching the Get-Groceries
            plan picker so the two grocery surfaces share one control idiom. */}
        <View style={styles.controlsRow}>
          <View style={styles.searchWrap}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search lists…"
              placeholderTextColor={Colors.neutral[600]}
              style={styles.searchInput}
            />
          </View>
          <View style={styles.sortToggle}>
            {SORT_OPTIONS.map((o) => (
              <Pressable
                key={o.key}
                onPress={() => setSortKey(o.key)}
                style={({ pressed }) => [
                  styles.sortChip,
                  o.key === sortKey && styles.sortChipActive,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text
                  style={[
                    styles.sortChipText,
                    o.key === sortKey && styles.sortChipTextActive,
                  ]}
                >
                  {o.label}
                </Text>
              </Pressable>
            ))}
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
                onOrderOnline={handleOrderOnline}
                onViewPlan={(() => {
                  // WS7-7-A B6 item 6 — link present only for plan-derived
                  // lists; planLinkTarget returns null otherwise.
                  const target = planLinkTarget(list);
                  return target ? () => router.push(target) : undefined;
                })()}
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
  onOrderOnline: () => void;
  // WS7-7-A B6 item 6 — present only when the list is plan-derived; the card
  // renders the "View Meal Plan" link iff this is defined.
  onViewPlan?: () => void;
};

function ListCard({
  list,
  onViewList,
  onOrderOnline,
  onViewPlan,
}: ListCardProps) {
  const badge = chipLabel(list);
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

      {/* WS7-7-A B6 item 6 — text link (not a button) under the meta line,
          only for plan-derived lists. stopPropagation so it doesn't also fire
          the card's onPress (View List). */}
      {onViewPlan && (
        <Pressable
          onPress={(e) => {
            e.stopPropagation();
            onViewPlan();
          }}
          hitSlop={6}
          style={({ pressed }) => [pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.planLink}>View Meal Plan</Text>
        </Pressable>
      )}

      {/* WS7-7-A B6 items 2/3/4 — the whole card is pressable → View List, so
          the redundant View List button is removed; Get List + Reuse are gone.
          Current-week cards keep Order Online only; past cards are button-less
          (the card tap is the affordance). */}
      {isCurrent && (
        <View style={styles.actionsRow}>
          <CardButton
            variant="terra"
            onPress={onOrderOnline}
            label="Order Online"
          />
        </View>
      )}
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
          bg: Colors.sage[700],
          text: Colors.neutral[0],
          border: Colors.sage[700],
        }
      : variant === "terra"
        ? {
            bg: Colors.terracotta[400],
            text: Colors.neutral[0],
            border: Colors.terracotta[400],
          }
        : {
            bg: "transparent",
            text: Colors.sage[700],
            border: Colors.sage[300],
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
    gap: Spacing[2],
    marginBottom: Spacing[3],
    zIndex: 10,
  },
  searchWrap: {
    flex: 1,
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    paddingHorizontal: Spacing[3],
    justifyContent: "center",
  },
  searchInput: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    paddingVertical: Spacing[2],
  },
  // WS7-7-A B6 — Recent/A–Z toggle, mirroring the Get-Groceries picker.
  sortToggle: {
    flexDirection: "row",
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    overflow: "hidden",
  },
  sortChip: {
    paddingHorizontal: Spacing[3],
    justifyContent: "center",
  },
  sortChipActive: {
    backgroundColor: Colors.sage[100],
  },
  sortChipText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  sortChipTextActive: {
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  loadingText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    paddingVertical: Spacing[4],
  },
  empty: {
    paddingTop: Spacing[6],
    paddingHorizontal: Spacing[4],
    alignItems: "center",
    gap: Spacing[4],
  },
  emptyText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    textAlign: "center",
    lineHeight: 22,
    fontFamily: Typography.face.sans[400],
  },
  emptyBtn: {
    backgroundColor: Colors.sage[700],
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing[5],
    paddingVertical: 12,
  },
  emptyBtnText: {
    color: Colors.neutral[0],
    fontSize: Typography.fontSize.md,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  list: {
    gap: Spacing[3],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Palette.border.default,
    padding: Spacing[3],
    gap: Spacing[1],
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  statusBadge: {
    backgroundColor: Colors.sage[100],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  statusBadgeText: {
    fontSize: 10,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  planName: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginTop: Spacing[1],
  },
  metaLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  planLink: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginTop: Spacing[1],
  },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing[2],
    marginTop: Spacing[2],
  },
  cardBtn: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 100,
    paddingHorizontal: Spacing[2],
    paddingVertical: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  cardBtnText: {
    fontSize: Typography.fontSize.sm,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
