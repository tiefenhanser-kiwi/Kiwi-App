import React, { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import type { SortKey } from "@/components/SortDropdown";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { formatDate, formatRelative } from "@/lib/date";
import type { SavedDish } from "@/lib/types";

type Props = {
  dish: SavedDish;
  onPress: () => void;
  /** Optional: sort-aware secondary line. Hidden for "alpha" /
   *  "cook_time" since those don't reveal otherwise-hidden data. */
  sortKey?: SortKey;
};

function buildSortLine(dish: SavedDish, sortKey: SortKey): string | null {
  switch (sortKey) {
    case "last_cooked":
      return dish.lastCookedAt
        ? `Last cooked ${formatRelative(dish.lastCookedAt)}`
        : "Never cooked";
    case "times_cooked": {
      // Dishes can be prepared but not "cooked" (e.g., chips, leftovers),
      // so the framing matches DishChooserSheet's existing "Used N×".
      const n = dish.useCount ?? 0;
      return n === 0 ? "Never used" : `Used ${n}× total`;
    }
    case "date_created":
      return dish.createdAt ? `Added ${formatDate(dish.createdAt)}` : null;
    case "alpha":
    case "cook_time":
      return null;
  }
  return null;
}

export function DishRow({ dish, onPress, sortKey }: Props) {
  const sortLine = useMemo(
    () => (sortKey ? buildSortLine(dish, sortKey) : null),
    [dish, sortKey],
  );

  const metaParts = [
    dish.cuisineType,
    `${dish.caloriesPerServing} cal/serving`,
  ].filter(Boolean);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}
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
        <Text style={styles.meta} numberOfLines={1} ellipsizeMode="tail">
          {metaParts.join(" · ")}
        </Text>
        {sortLine && <Text style={styles.sortLine}>{sortLine}</Text>}
      </View>
      {dish.useCount !== undefined && dish.useCount > 0 && (
        <Text style={styles.useCount}>Used in {dish.useCount}</Text>
      )}
    </Pressable>
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
  sortLine: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
  },
  useCount: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
});
