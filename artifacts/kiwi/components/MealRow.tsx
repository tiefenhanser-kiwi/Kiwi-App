import React, { useMemo } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { DisplayTitle } from "@/components/DisplayTitle";
import type { SortKey } from "@/components/SortDropdown";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
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
          <DisplayTitle source={meal} variant="row" style={styles.title} />
          {/* WS9 3f-4d Part 1c (D-WS9-124) — one-line "what's on the plate"
              sub-text. Omitted entirely when absent (no empty gap/placeholder). */}
          {meal.description ? (
            <Text style={styles.description} numberOfLines={1}>
              {meal.description}
            </Text>
          ) : null}
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
    width: 56,
    height: 56,
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
  description: {
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
  tagRow: { flexDirection: "row", marginTop: 4 },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: Colors.sage[50],
    borderRadius: 4,
  },
  tagText: {
    fontSize: Typography.fontSize.xxs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
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
  addToPlanBtn: {
    backgroundColor: Colors.terracotta[400],
    paddingHorizontal: Spacing[2],
    paddingVertical: 8,
    borderRadius: Radius.md,
    alignItems: "center",
  },
  addToPlanText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
