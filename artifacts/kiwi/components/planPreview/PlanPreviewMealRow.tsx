// PREVIEW-1 — one meal in the featured-plan preview, read-only.
//
// Plan Review's row (components/PlanReviewMealRow.tsx), minus everything that
// acts: the same card (card surface, lg radius, neutral[400] edge, card
// shadow), the same body row (TreatedImage thumb at ImageTreatment.thumb.row,
// md radius, top-aligned beside a growing text column), the same title and
// meta type. The day rides on top as an eyebrow in place of Plan Review's
// seven-pill strip — a strip is a control for MOVING a meal, and nothing on
// this sheet moves.
//
// ⚠️ NOT PlanReviewMealRow with readOnly. Its readOnly mode still renders the
// day strip and the "View Ingredients" button, which pushes /meal/[id] with
// plan params — a route change underneath this Modal, for a plan the user
// does not own. The only action here is the tap that opens the meal in-sheet.
//
// ⚠️ NOT MealRowBody either, though it was the first cut: it caps the meta at
// ONE line, and at ~130% text on a 375 pt phone the time part truncated
// ("40 min · 38 min hand…"). Plan Review's meta wraps; so does this one.
//
// Description: TWO lines, not Plan Review's three (BUG-197). The preview is
// five rows in an 85% sheet above a pinned footer, and the full description is
// one tap away in the meal view.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { DisplayTitle, resolveDisplayTitle } from "@/components/DisplayTitle";
import { TreatedImage } from "@/components/TreatedImage";
import {
  Colors,
  ImageTreatment,
  Palette,
  Radius,
  Shadow,
  Spacing,
  Typography,
} from "@/constants/tokens";

import type { PreviewMealRow } from "./previewModel";

export function PlanPreviewMealRow({
  row,
  onOpen,
}: {
  row: PreviewMealRow;
  onOpen: (row: PreviewMealRow) => void;
}) {
  const title = resolveDisplayTitle(row.meal, "Meal");
  return (
    <Pressable
      onPress={() => onOpen(row)}
      accessibilityRole="button"
      accessibilityLabel={row.day ? `${row.day}: ${title}` : title}
      style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
      testID={`plan-preview-row-${row.itemId}`}
    >
      {row.day ? <Text style={s.day}>{row.day}</Text> : null}
      <View style={s.bodyRow}>
        <TreatedImage
          source={row.imageUrl ? { uri: row.imageUrl } : null}
          width={ImageTreatment.thumb.row}
          height={ImageTreatment.thumb.row}
          radius={Radius.md}
        />
        <View style={s.textCol}>
          <DisplayTitle source={row.meal} variant="row" style={s.title} />
          {row.meal.description ? (
            <Text style={s.description} numberOfLines={2}>
              {row.meal.description}
            </Text>
          ) : null}
          <Text style={s.metaLine}>{row.metaLine}</Text>
        </View>
      </View>
    </Pressable>
  );
}

// Every style but `day` is PlanReviewMealRow's, by name.
const s = StyleSheet.create({
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    padding: Spacing[3],
    marginBottom: Spacing[2],
    ...Shadow.card,
  },
  day: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: Spacing[2],
  },
  bodyRow: {
    flexDirection: "row",
    gap: Spacing[3],
    alignItems: "flex-start",
  },
  textCol: {
    flex: 1,
    gap: Spacing[1],
  },
  title: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  description: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  metaLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
});
