// WS7-7-A B6 (D-WS5-033) — multi-plan grocery picker. Reached from the Home
// "Get Groceries" CTA when the user has 2+ plans (the 0/1 cases never route
// here — see decideGroceryEntry). Lists the user's plans with This Week pinned
// at the top and the rest searchable/sortable; picking a plan hands off to the
// shared generate flow (useGroceryGeneration) → /grocery-list/[id].
//
// "Build to scale" (Hans §5): the plans endpoint is keyset-paginated, so this
// fetches ALL pages (fetchAllPlans loops nextCursor) and does search + sort
// client-side over the full set. Server-side search/sort is a documented WS9
// scale-point, not this block.

import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { DisplayTitle } from "@/components/DisplayTitle";
import { GroceryGeneratingOverlay } from "@/components/GroceryGeneratingOverlay";
import { Header } from "@/components/Header";
import { LoadingShim } from "@/components/LoadingShim";
import { Screen } from "@/components/Screen";
import { useGroceryGeneration } from "@/hooks/useGroceryGeneration";
import { getPlans, type PlanListItem } from "@/lib/api/plans";
import {
  buildPickerList,
  fetchAllPlans,
  type PickerSort,
} from "@/lib/groceryPicker";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

const SORTS: Array<{ key: PickerSort; label: string }> = [
  { key: "recent", label: "Recent" },
  { key: "alpha", label: "A–Z" },
];

export default function GroceryPlanPickerScreen() {
  // Fetch-all in one query — the picker wants the whole plan set in memory.
  const plansQuery = useQuery({
    queryKey: ["plans", "picker-all"],
    queryFn: () =>
      fetchAllPlans((cursor) => getPlans(["my_plans"], { cursor })),
  });

  const { generate, isGenerating } = useGroceryGeneration();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PickerSort>("recent");

  const { pinned, rest } = useMemo(
    () =>
      buildPickerList(
        plansQuery.data?.plans ?? [],
        plansQuery.data?.activeThisWeek ?? null,
        { query, sort },
      ),
    [plansQuery.data, query, sort],
  );

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header title="Get Groceries" subtitle="pick a plan" />
      <Screen>
        {plansQuery.isLoading ? (
          <LoadingShim variant="screen" label="Loading your plans…" />
        ) : plansQuery.isError ? (
          <Text style={styles.message}>
            Couldn’t load your plans right now. Try again in a moment.
          </Text>
        ) : (
          <>
            <Text style={styles.intro}>
              Which plan do you want groceries for?
            </Text>

            {pinned && (
              <PlanRow
                plan={pinned}
                pinned
                onPress={() => generate(pinned.id)}
              />
            )}

            <View style={styles.controlsRow}>
              <View style={styles.searchWrap}>
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search plans…"
                  placeholderTextColor={Colors.neutral[600]}
                  style={styles.searchInput}
                />
              </View>
              <View style={styles.sortToggle}>
                {SORTS.map((o) => (
                  <Pressable
                    key={o.key}
                    onPress={() => setSort(o.key)}
                    style={({ pressed }) => [
                      styles.sortChip,
                      o.key === sort && styles.sortChipActive,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Text
                      style={[
                        styles.sortChipText,
                        o.key === sort && styles.sortChipTextActive,
                      ]}
                    >
                      {o.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {rest.length === 0 ? (
              <Text style={styles.message}>
                {query.trim() ? "No plans match your search." : "No other plans."}
              </Text>
            ) : (
              <View style={styles.list}>
                {rest.map((plan) => (
                  <PlanRow
                    key={plan.id}
                    plan={plan}
                    onPress={() => generate(plan.id)}
                  />
                ))}
              </View>
            )}
          </>
        )}
      </Screen>
      <GroceryGeneratingOverlay visible={isGenerating} />
    </View>
  );
}

function PlanRow({
  plan,
  pinned = false,
  onPress,
}: {
  plan: PlanListItem;
  pinned?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        pinned && styles.cardPinned,
        pressed && { opacity: 0.92 },
      ]}
    >
      {pinned && (
        <View style={styles.cardTopRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>This Week</Text>
          </View>
        </View>
      )}
      <DisplayTitle source={plan} variant="row" style={styles.planName} />
      {plan.description ? (
        <Text style={styles.planDesc} numberOfLines={1}>
          {plan.description}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  intro: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginBottom: Spacing[3],
  },
  message: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    paddingVertical: Spacing[4],
  },
  controlsRow: {
    flexDirection: "row",
    gap: Spacing[2],
    marginTop: Spacing[3],
    marginBottom: Spacing[3],
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
  cardPinned: {
    borderColor: Colors.sage[300],
    marginBottom: Spacing[1],
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  badge: {
    backgroundColor: Colors.sage[100],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  badgeText: {
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
  planDesc: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
});
