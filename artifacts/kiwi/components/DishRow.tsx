import React, { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { DisplayTitle } from "@/components/DisplayTitle";
import type { SortKey } from "@/components/SortDropdown";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import type { DishListItem } from "@/lib/api/dishes";
import { formatMacroLine } from "@/lib/format/macros";

type Props = {
  dish: DishListItem;
  onPress: () => void;
  onCookNow: (dishId: string) => void;
  onAddToMeal: (dishId: string, dishName: string) => void;
  /** Optional: sort-aware secondary line. DishListItem doesn't carry
   *  cook-stat fields today (D-WS7-048 extended) so the cook-stat sorts
   *  surface no secondary line rather than render misleading numbers. */
  sortKey?: SortKey;
};

function buildSortLine(sortKey: SortKey): string | null {
  switch (sortKey) {
    case "last_cooked":
    case "times_cooked":
    case "date_created":
    case "alpha":
    case "cook_time":
      // D-WS7-048 (extended): DishListItem has no cook-stat fields. The sorts
      // become no-ops until WS9 lands server-side sort params; the row hides
      // the secondary line rather than render misleading zeros.
      return null;
  }
  return null;
}

const capitalize = (s: string) =>
  s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;

export function DishRow({
  dish,
  onPress,
  onCookNow,
  onAddToMeal,
  sortKey,
}: Props) {
  const sortLine = useMemo(
    () => (sortKey ? buildSortLine(sortKey) : null),
    [sortKey],
  );

  // DishListItem has no cuisine (no Dish.cuisineType column). Meta keeps
  // difficulty + time as the lightweight pair PRD §9.3.4 intends.
  const metaParts = [
    dish.difficulty ? capitalize(dish.difficulty) : null,
    dish.minutes > 0 ? `${dish.minutes} min` : null,
  ].filter(Boolean) as string[];

  return (
    <View style={styles.row}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.cardArea, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.thumb}>
          {dish.image ? (
            <Image
              source={{ uri: dish.image }}
              style={styles.thumbImage}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.thumbFallback} />
          )}
        </View>
        <View style={styles.body}>
          <DisplayTitle source={dish} variant="row" style={styles.title} />
          {metaParts.length > 0 && (
            <Text style={styles.meta} numberOfLines={1} ellipsizeMode="tail">
              {metaParts.join(" · ")}
            </Text>
          )}
          {/* WS7-6 C-fix Block 4 — full per-serving macro line (Hans-ruled over
              the PRD calories-only row). Zeros render as-is (real data). */}
          <Text style={styles.macros} numberOfLines={1} ellipsizeMode="tail">
            {formatMacroLine(dish.calories, dish.protein, dish.carbs, dish.fat)}
          </Text>
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
          onPress={() => onAddToMeal(dish.id, dish.title)}
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
    gap: Spacing[2],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    padding: Spacing[2],
    borderWidth: 1,
    borderColor: Colors.neutral[200],
  },
  cardArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: Radius.sm,
    overflow: "hidden",
    backgroundColor: Colors.sage[100],
  },
  thumbImage: { width: "100%", height: "100%" },
  thumbFallback: {
    width: "100%",
    height: "100%",
    backgroundColor: Colors.sage[100],
  },
  body: { flex: 1, gap: 2 },
  title: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  meta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  macros: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  sortLine: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
  },
  actionStack: {
    gap: Spacing[1],
    alignItems: "stretch",
    minWidth: 88,
  },
  cookNowBtn: {
    backgroundColor: Colors.sage[700],
    paddingHorizontal: Spacing[2],
    paddingVertical: 8,
    borderRadius: Radius.md,
    alignItems: "center",
  },
  cookNowText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  addToMealBtn: {
    backgroundColor: Colors.terracotta[400],
    paddingHorizontal: Spacing[2],
    paddingVertical: 8,
    borderRadius: Radius.md,
    alignItems: "center",
  },
  addToMealText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
