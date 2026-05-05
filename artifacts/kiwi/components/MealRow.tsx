import React, { useMemo } from "react";
import {
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { SortKey } from "@/components/SortDropdown";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { formatDate, formatRelative } from "@/lib/date";
import type { MealRowData } from "@/lib/stubs";

type Props = {
  meal: MealRowData;
  onPress: () => void;
  onCookNow: () => void;
  /** Optional: when set, render a sort-aware secondary line. Hidden
   *  for "alpha" / "cook_time" since those don't reveal hidden data. */
  sortKey?: SortKey;
};

function buildSortLine(meal: MealRowData, sortKey: SortKey): string | null {
  switch (sortKey) {
    case "last_cooked":
      return meal.lastCookedAt
        ? `Last cooked ${formatRelative(meal.lastCookedAt)}`
        : "Never cooked";
    case "times_cooked": {
      const n = meal.timesCooked ?? 0;
      return n === 0 ? "Never cooked" : `Cooked ${n}× total`;
    }
    case "date_created":
      return meal.createdAt ? `Added ${formatDate(meal.createdAt)}` : null;
    case "alpha":
    case "cook_time":
      return null;
  }
  return null;
}

export function MealRow({ meal, onPress, onCookNow, sortKey }: Props) {
  const sortLine = useMemo(
    () => (sortKey ? buildSortLine(meal, sortKey) : null),
    [meal, sortKey],
  );

  const handleAddToPlan = () => {
    Alert.alert(
      "Coming in WS5-5N-bis",
      "Add to Plan flow lands in the next sub-phase. Until then, open the meal detail to add it to a plan.",
    );
  };

  // Card tap navigates to Meal Detail (5N wiring). Add to Plan is a
  // separate Pressable so its tap doesn't bubble. onCookNow stays a
  // prop for parents that need it; not rendered inline today (the
  // Cook Now action lives on the Meal Detail screen).
  void onCookNow;

  return (
    <View style={styles.row}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.cardArea, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.thumb}>
          {meal.thumbnailUrl ? (
            <Image
              source={{ uri: meal.thumbnailUrl }}
              style={styles.thumbImage}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.thumbFallback} />
          )}
        </View>
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={1}>
            {meal.title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {meal.meta}
          </Text>
          {sortLine && <Text style={styles.sortLine}>{sortLine}</Text>}
          {meal.cuisineTag && (
            <View style={styles.tagRow}>
              <View style={styles.tag}>
                <Text style={styles.tagText}>{meal.cuisineTag}</Text>
              </View>
            </View>
          )}
        </View>
      </Pressable>
      <Pressable
        onPress={handleAddToPlan}
        style={({ pressed }) => [
          styles.addToPlanBtn,
          pressed && { opacity: 0.7 },
        ]}
      >
        <Text style={styles.addToPlanText}>Add to Plan</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    padding: KSpacing.sm,
    borderWidth: 1,
    borderColor: KColors.neutral[200],
  },
  cardArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: KColors.sage[100],
  },
  thumbImage: { width: "100%", height: "100%" },
  thumbFallback: {
    width: "100%",
    height: "100%",
    backgroundColor: KColors.sage[100],
  },
  body: { flex: 1, gap: 2 },
  title: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  meta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  sortLine: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
  },
  tagRow: { flexDirection: "row", marginTop: 4 },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: KColors.sage[50],
    borderRadius: 4,
  },
  tagText: {
    fontSize: 10,
    color: KColors.sage[700],
    fontFamily: "Inter_500Medium",
  },
  addToPlanBtn: {
    backgroundColor: KColors.sage[700],
    paddingHorizontal: KSpacing.md,
    paddingVertical: 8,
    borderRadius: KRadius.md,
    alignItems: "center",
    minWidth: 88,
  },
  addToPlanText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
