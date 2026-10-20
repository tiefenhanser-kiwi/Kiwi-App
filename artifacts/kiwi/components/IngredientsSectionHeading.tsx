// WS9 D-WS9-058 (BUG-331) — the "Ingredients" heading, as a CONTROL.
//
// 🔴 WHY THIS IS A COMPONENT AND NOT FOUR LINES OF JSX ON THE SCREEN.
//
// Hans reported the label as something that "is supposed to expand, but no-ops
// when I click now". It never did — git history says it has been an inert
// <Text> since WS5-5F (a286a7f) and nothing near it was ever pressable. The
// whole point of this block is that it becomes pressable and STAYS pressable.
// Inline on app/meal/[id].tsx that is unguardable: app/** is outside the test
// glob (D-WS9-164), so deleting the Pressable would be a silent, green
// regression straight back to the bug that was reported. Part D's break 7 is
// exactly that deletion, and it has to go RED.
//
// BUG-452 (WEB-4) — and it now LOOKS like one. The eyebrow-plus-far-chevron
// below read as an inert heading (Hans tapped it by accident), so the heading
// is the shared sage IngredientsToggle; it keeps this file's testID, label and
// hitSlop, and SectionLabel's own section spacing (16 above, 10 below).
//
// (History, before BUG-452:) ⚠️ SectionLabel IS NOT TOUCHED, and that is deliberate. It is shared across 11
// renders in 5 files and takes no `onPress`; adding one would put a tap target
// on ten headings that do nothing. The Pressable and the chevron are HERE,
// wrapping it — so the eyebrow's own type, weight and colour are byte-identical
// to the other ten.
//
// ⚠️ THE WEIGHT IS NOT CHANGED EITHER. The contrast is 9.61:1 (neutral[800]
// #4A3F30 on the locked paper #FBF7EF) against a 4.5:1 AA bar, so "hard to see"
// is not a contrast failure — it is a hierarchy inversion: a 14px serif-italic
// eyebrow sitting above its own 15px serif-600 "For the {dish}:" sub-heading.
// That is RECORDED (M10) and not fixed here; it is a change to a shared
// primitive across 11 renders and wants its own device pass.

import React from "react";
import { StyleSheet } from "react-native";

import { IngredientsToggle } from "@/components/IngredientsToggle";
import { Spacing } from "@/constants/tokens";

export interface IngredientsSectionHeadingProps {
  /** Opens the consolidated-ingredients sheet. */
  onPress: () => void;
  /** Defaults to "Ingredients" — the dish screen may want its own word. */
  label?: string;
}

export function IngredientsSectionHeading({
  onPress,
  label = "Ingredients",
}: IngredientsSectionHeadingProps) {
  return (
    <IngredientsToggle
      onPress={onPress}
      label={label}
      accessibilityLabel="View all ingredients"
      hitSlop={8}
      style={s.gap}
      testID="meal-ingredients-heading"
    />
  );
}

const s = StyleSheet.create({
  // SectionLabel's margins, so the section keeps its rhythm (it was the single
  // owner of the inter-section gap here, WS9-2 2c Commit 4 §4.3).
  gap: {
    marginTop: Spacing[4],
    marginBottom: 10,
  },
});
