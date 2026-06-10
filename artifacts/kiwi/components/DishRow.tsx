import React, { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import type { SortKey } from "@/components/SortDropdown";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
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
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
            {dish.title}
          </Text>
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
  macros: {
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
