import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { MealRowBody } from "@/components/MealRowBody";
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
        {/* Block 2c Part D — the body is the shared MealRowBody (the Playlist
            row renders the same shape); this row keeps its Cook Now / Add to
            Plan stack. WS9 3f-4d Part 1c (D-WS9-124) — the "what's on the
            plate" sub-text. Omitted entirely when absent (no empty gap/
            placeholder).
            ⚠️ WS9 BUG-158 AMENDMENT (Sept 2) — TWO lines, was one. Last block
            held this at one as a deliberate per-surface divergence while
            PlanReviewMealRow and AddMealsSheet went to two. Hans has now seen
            both side by side on device and ruled two here as well: "I think
            two lines in My Recipes is a good call, maybe 3, but it's a lot of
            text on the card." TWO, NOT THREE — he named three and declined it
            in the same breath.
            ⚠️ D-WS9-124 was checked in canon before this changed. It ruled the
            AUTHORING of `description` (≤160-char instruction, 200-char schema,
            wizard + Mode-A prompts, list-item wiring). It never ruled a line
            count, and BUG-158's own entry calls line count "a per-surface
            decision". No conflict. */}
        <MealRowBody
          title={meal}
          description={meal.description}
          meta={meta}
          image={meal.image}
          tags={cuisineTag ? [cuisineTag] : []}
        >
          {sortLine && <Text style={styles.sortLine}>{sortLine}</Text>}
        </MealRowBody>
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
