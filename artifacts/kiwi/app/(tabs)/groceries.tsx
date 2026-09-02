import React, { useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { resolveDisplayTitle } from "@/components/DisplayTitle";
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
        : // BUG-067 — order by the displayed string via the shared resolver.
          // Grocery lists carry no displayTitle today, so this resolves to
          // `title` (a no-op now; forward-safe if a display name is ever added).
          resolveDisplayTitle(a).localeCompare(resolveDisplayTitle(b)), // A–Z
    );
  }, [lists, query, sortKey]);

  const handleViewList = (id: string) => {
    router.push({ pathname: "/grocery-list/[id]", params: { id } });
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
              placeholderTextColor={Palette.text.placeholder}
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
  // WS7-7-A B6 item 6 — present only when the list is plan-derived; the card
  // renders the "View Meal Plan" link iff this is defined.
  onViewPlan?: () => void;
};

function ListCard({ list, onViewList, onViewPlan }: ListCardProps) {
  const badge = chipLabel(list);

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
          WS9 3e Part 1.4 — the dead "Order Online" stub (Alert "coming soon",
          D-WS7-125) is removed entirely; it re-surfaces with roadmap row 8
          (Instacart) under the R3 "Order Online" label. The card tap is the
          only affordance now. */}
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
    color: Colors.neutral[700],
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
    // WS9 3e Part 1.3 — align to the 3d PlanRow token language (Radius.md +
    // neutral[200] hairline) so the two list surfaces read as one family. The
    // whole-card-tap affordance (B6) is kept, so this is a token-alignment
    // restyle, not a structural conversion to PlanRow's thumb+Open row.
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[200],
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
    fontSize: Typography.fontSize.xxs,
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
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  planLink: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginTop: Spacing[1],
  },
});
