import React, { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import type { SortKey } from "@/components/SortDropdown";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { formatDate, formatRelative } from "@/lib/date";
import type { SavedDish } from "@/lib/types";

type Props = {
  dish: SavedDish;
  onPress: () => void;
  onCookNow: (dishId: string) => void;
  onAddToMeal: (dishId: string, dishName: string) => void;
  /** Optional: sort-aware secondary line for last_cooked / date_created.
   *  "times_cooked" no longer renders a sort line — the always-on
   *  "Used in N meals" line below covers the meal-use story. */
  sortKey?: SortKey;
};

function buildSortLine(dish: SavedDish, sortKey: SortKey): string | null {
  switch (sortKey) {
    case "last_cooked":
      return dish.lastCookedAt
        ? `Last cooked ${formatRelative(dish.lastCookedAt)}`
        : "Never cooked";
    case "date_created":
      return dish.createdAt ? `Added ${formatDate(dish.createdAt)}` : null;
    case "times_cooked":
    case "alpha":
    case "cook_time":
      return null;
  }
  return null;
}

export function DishRow({
  dish,
  onPress,
  onCookNow,
  onAddToMeal,
  sortKey,
}: Props) {
  const sortLine = useMemo(
    () => (sortKey ? buildSortLine(dish, sortKey) : null),
    [dish, sortKey],
  );

  const metaParts = [
    dish.cuisineType,
    dish.estimatedTimeMinutes !== undefined
      ? `${dish.estimatedTimeMinutes} min`
      : null,
  ].filter(Boolean) as string[];

  return (
    <View style={styles.row}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.cardArea, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.thumb}>
          {dish.imageUrl ? (
            <Image
              source={{ uri: dish.imageUrl }}
              style={styles.thumbImage}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.thumbFallback} />
          )}
        </View>
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
            {dish.name}
          </Text>
          {metaParts.length > 0 && (
            <Text style={styles.meta} numberOfLines={1} ellipsizeMode="tail">
              {metaParts.join(" · ")}
            </Text>
          )}
          {dish.mealUseCount > 0 && (
            <Text style={styles.useCount}>
              Used in {dish.mealUseCount}{" "}
              {dish.mealUseCount === 1 ? "meal" : "meals"}
            </Text>
          )}
          {sortLine && <Text style={styles.sortLine}>{sortLine}</Text>}
        </View>
      </Pressable>
      <View style={styles.actionStack}>
        <Pressable
          onPress={() => onCookNow(dish.id)}
          style={({ pressed }) => [
            styles.cookNowBtn,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.cookNowText}>Cook Now</Text>
        </Pressable>
        <Pressable
          onPress={() => onAddToMeal(dish.id, dish.name)}
          style={({ pressed }) => [
            styles.addToMealBtn,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.addToMealText}>Add to Meal</Text>
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
    width: 48,
    height: 48,
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
  useCount: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  sortLine: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
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
  addToMealBtn: {
    backgroundColor: KColors.terracotta[400],
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 8,
    borderRadius: KRadius.md,
    alignItems: "center",
  },
  addToMealText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
