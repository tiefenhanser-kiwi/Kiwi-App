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
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";

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
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
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
                  placeholderTextColor={KColors.neutral[600]}
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
      <Text style={styles.planName} numberOfLines={2}>
        {plan.name}
      </Text>
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
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginBottom: KSpacing.md,
  },
  message: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    paddingVertical: KSpacing.lg,
  },
  controlsRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    marginTop: KSpacing.md,
    marginBottom: KSpacing.md,
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
  sortToggle: {
    flexDirection: "row",
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    overflow: "hidden",
  },
  sortChip: {
    paddingHorizontal: KSpacing.md,
    justifyContent: "center",
  },
  sortChipActive: {
    backgroundColor: KColors.sage[100],
  },
  sortChipText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  sortChipTextActive: {
    color: KColors.sage[700],
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
  cardPinned: {
    borderColor: KColors.sage[300],
    marginBottom: KSpacing.xs,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  badge: {
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
  },
  badgeText: {
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
  planDesc: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
});
