// BUG-452 — the Ingredients control has to LOOK tappable.
//
// Hans tapped meal detail's Ingredients heading by accident: it was the shared
// SectionLabel eyebrow (14 px serif italic, the look of every inert heading on
// the screen) with a lone chevron at the far right of the row, so nothing read
// as a control. He wants it more visible, probably sage, clearly tappable, on
// every page that has it, so a user can "quickly think 'oh yeah, I have that
// stuff, I can make this' before they dig in".
//
// One component, so every surface reads the same: a sage-tint pill (Palette
// .button.sageTint — sage[700] on sage[50], 7.75:1) with a list glyph, the word,
// and the chevron right beside the word rather than stranded at the row's end.
// Used by IngredientsSectionHeading (meal detail), PlanReviewMealRow ("View
// Ingredients") and MealRow (the Recipes list).
import React from "react";
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Palette, Radius, Spacing, Typography } from "@/constants/tokens";

const TINT = Palette.button.sageTint;

export interface IngredientsToggleProps {
  onPress: () => void;
  label?: string;
  accessibilityLabel?: string;
  testID?: string;
  hitSlop?: number;
  /** "regular" for a section heading, "compact" inside a list row. */
  size?: "regular" | "compact";
  style?: StyleProp<ViewStyle>;
}

export function IngredientsToggle({
  onPress,
  label = "Ingredients",
  accessibilityLabel = "View ingredients",
  testID,
  hitSlop,
  size = "regular",
  style,
}: IngredientsToggleProps) {
  const compact = size === "compact";
  const icon = compact ? 13 : 15;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={hitSlop}
      testID={testID}
      style={({ pressed }) => [
        s.pill,
        compact && s.pillCompact,
        style,
        pressed && { backgroundColor: TINT.hover },
      ]}
    >
      <Feather name="list" size={icon} color={TINT.text} />
      <Text style={[s.label, compact && s.labelCompact]}>{label}</Text>
      <Feather name="chevron-right" size={icon} color={TINT.text} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: Spacing[1] + 2,
    backgroundColor: TINT.background,
    borderColor: TINT.border,
    borderWidth: 1,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2] - 2,
  },
  pillCompact: {
    paddingHorizontal: Spacing[2] + 2,
    paddingVertical: Spacing[1],
  },
  label: {
    fontSize: Typography.fontSize.base,
    color: TINT.text,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  labelCompact: {
    fontSize: Typography.fontSize.sm,
  },
});
