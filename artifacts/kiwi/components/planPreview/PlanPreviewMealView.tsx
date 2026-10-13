// PREVIEW-1 — a meal opened from the featured-plan preview, IN the sheet.
//
// Why in-sheet rather than MealPreviewSheet or /meal/[id]:
//   • MealPreviewSheet is a second RN <Modal> whose footer is the Pick toggle
//     and whose input is a ShelfMeal — reusing it means a Modal stacked on a
//     Modal (web renders both portals; Android back has to unwind two) plus an
//     edit to give it a no-pick mode.
//   • /meal/[id] is a route push, which lands UNDER this Modal — the sheet would
//     have to close first, and the user loses the preview they came from.
// The template read already carries the full MealDetail for every item
// (composeMealDetail on the server), so there is nothing to fetch: the body is
// the guest recipe screen's own MealRecipeSections, the same one the Pick
// preview renders. One sheet, one dismiss path, a back link to the plan.

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { DisplayTitle } from "@/components/DisplayTitle";
import { MealRecipeSections } from "@/components/MealRecipeSections";
import { TreatedImage } from "@/components/TreatedImage";
import { Colors, ImageTreatment, Radius, Spacing, Typography } from "@/constants/tokens";

import type { PreviewMealRow } from "./previewModel";

export function PlanPreviewMealView({ row }: { row: PreviewMealRow }) {
  const meal = row.meal;
  return (
    <View testID="plan-preview-meal-view">
      <TreatedImage
        source={row.imageUrl ? { uri: row.imageUrl } : null}
        aspectRatio={ImageTreatment.aspect.hero}
        radius={Radius.lg}
      />
      <View style={s.head}>
        {row.day ? <Text style={s.day}>{row.day}</Text> : null}
        <DisplayTitle source={meal} variant="hero" style={s.title} />
        <Text style={s.meta}>{row.metaLine}</Text>
        {meal.description ? <Text style={s.description}>{meal.description}</Text> : null}
      </View>
      <MealRecipeSections meal={meal} />
    </View>
  );
}

const s = StyleSheet.create({
  head: {
    gap: 6,
    marginTop: Spacing[3],
    marginBottom: Spacing[3],
  },
  day: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  title: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
  },
  meta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  description: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
});
