import React, { useMemo } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { SortKey } from "@/components/SortDropdown";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import type { MealListItem } from "@/lib/api/meals";

type Props = {
  meal: MealListItem;
  onPress: () => void;
  onCookNow: () => void;
  /** Fired when the row's Add to Plan button is tapped. The parent
   *  renders the AddMealToPlanSheet at screen level. */
  onAddToPlan: (mealId: string, mealTitle: string) => void;
  /** Optional: when set, render a sort-aware secondary line. MealListItem
   *  doesn't carry cook-stat fields today (D-WS7-048 extended) so the
   *  cook-stat sorts surface a "no data yet" hint rather than fake numbers. */
  sortKey?: SortKey;
};

function buildSortLine(sortKey: SortKey): string | null {
  switch (sortKey) {
    case "last_cooked":
    case "times_cooked":
    case "date_created":
      // D-WS7-048 (extended): MealListItem has no cook-stat fields. The sort
      // is a no-op until WS9 lands server-side params; the row hides the
      // secondary line rather than render misleading zeros.
      return null;
    case "alpha":
    case "cook_time":
      return null;
  }
  return null;
}

export function MealRow({
  meal,
  onPress,
  onCookNow,
  onAddToPlan,
  sortKey,
}: Props) {
  const sortLine = useMemo(
    () => (sortKey ? buildSortLine(sortKey) : null),
    [sortKey],
  );
  // Server returns `""` (not null) when a meal has no cuisine — hide the tag
  // pill on empty strings so the row stays clean.
  const cuisineTag = meal.cuisine.length > 0 ? meal.cuisine : null;
  const meta = `${meal.minutes} min · serves ${meal.servings}`;

  return (
    <View style={styles.row}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.cardArea, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.thumb}>
          {meal.image ? (
            <Image
              source={{ uri: meal.image }}
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
            {meta}
          </Text>
          {sortLine && <Text style={styles.sortLine}>{sortLine}</Text>}
          {cuisineTag && (
            <View style={styles.tagRow}>
              <View style={styles.tag}>
                <Text style={styles.tagText}>{cuisineTag}</Text>
              </View>
            </View>
          )}
        </View>
      </Pressable>
      <View style={styles.actionStack}>
        <Pressable
          onPress={onCookNow}
          style={({ pressed }) => [
            styles.cookNowBtn,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.cookNowText}>Cook Now</Text>
        </Pressable>
        <Pressable
          onPress={() => onAddToPlan(meal.id, meal.title)}
          style={({ pressed }) => [
            styles.addToPlanBtn,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.addToPlanText}>Add to Plan</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KPalette.bg.card,
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
  actionStack: {
    gap: KSpacing.xs,
    alignItems: "stretch",
    minWidth: 88,
  },
  cookNowBtn: {
    backgroundColor: KColors.sage[700],
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 8,
    borderRadius: KRadius.md,
    alignItems: "center",
  },
  cookNowText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  addToPlanBtn: {
    backgroundColor: KColors.terracotta[400],
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 8,
    borderRadius: KRadius.md,
    alignItems: "center",
  },
  addToPlanText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
