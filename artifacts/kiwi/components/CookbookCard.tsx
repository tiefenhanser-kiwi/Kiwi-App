// BOOK-1C1 (D-WS9-312) — one Cookbook result: a 4:3 photo (TreatedImage, so a
// meal without a photo gets the warm placeholder ramp, its ruled terminal
// state, D-WS9-246), the title in serif, "47 min · 25 hands-on · 720 kcal",
// the cuisine and difficulty pills, and two actions:
//   Save — the Save chip (BOOK-1C2: it replaced the heart, which read as a
//      "like"): "Save" on light sage, "Saved" on dark sage. AppContext.setSaved,
//      the same write meal detail's chip uses, so the two never disagree;
//   +  Add to a plan — the host opens AddMealToPlanSheet (plan, then day).
// Tapping anywhere else opens the existing meal detail.
//
// Presentational: the host owns every action. The two buttons are siblings of
// the card's pressable body, not children, so a tap on Save or + never also
// opens the meal (nested Pressables on react-native-web bubble).

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { DisplayTitle } from "@/components/DisplayTitle";
import { SaveChip } from "@/components/SaveChip";
import { TreatedImage } from "@/components/TreatedImage";
import { Colors, ImageTreatment, Palette, Radius, Shadow, Spacing, Typography } from "@/constants/tokens";
import type { CookbookMeal } from "@/lib/api/cookbook";
import { cardMetaLine, cardPills } from "@/lib/cookbook/query";

export interface CookbookCardProps {
  meal: CookbookMeal;
  onOpen: (meal: CookbookMeal) => void;
  onToggleSave: (meal: CookbookMeal) => void;
  onAddToPlan: (meal: CookbookMeal) => void;
}

export function CookbookCard({ meal, onOpen, onToggleSave, onAddToPlan }: CookbookCardProps) {
  const pills = cardPills(meal);
  return (
    <View style={s.card}>
      <Pressable
        onPress={() => onOpen(meal)}
        accessibilityRole="button"
        style={({ pressed }) => [pressed && { opacity: 0.92 }]}
      >
        <TreatedImage
          source={meal.imageUrl ? { uri: meal.imageUrl } : null}
          aspectRatio={ImageTreatment.aspect.mealCard}
        />
        <View style={s.body}>
          <DisplayTitle source={meal} variant="railCard" style={s.title} />
          <Text style={s.meta} numberOfLines={1}>
            {cardMetaLine(meal)}
          </Text>
        </View>
      </Pressable>
      <View style={s.footer}>
        <View style={s.pills}>
          {pills.map((p) => (
            <View key={p} style={s.pill}>
              <Text style={s.pillText}>{p}</Text>
            </View>
          ))}
        </View>
        <SaveChip saved={meal.isSaved} onToggle={() => onToggleSave(meal)} />
        <Pressable
          onPress={() => onAddToPlan(meal)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Add to a plan"
          style={({ pressed }) => [s.action, s.addAction, pressed && { opacity: 0.7 }]}
        >
          <Feather name="plus" size={20} color={Colors.neutral[0]} />
        </Pressable>
      </View>
    </View>
  );
}

const ACTION = 36;

const s = StyleSheet.create({
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Palette.border.default,
    overflow: "hidden",
    ...Shadow.card,
  },
  body: {
    paddingHorizontal: Spacing[3],
    paddingTop: Spacing[3],
    gap: 4,
  },
  title: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  meta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    paddingHorizontal: Spacing[3],
    paddingTop: Spacing[2],
    paddingBottom: Spacing[3],
  },
  pills: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.full,
  },
  pillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
  action: {
    width: ACTION,
    height: ACTION,
    borderRadius: ACTION / 2,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Palette.border.default,
    backgroundColor: Palette.background.card,
  },
  addAction: {
    backgroundColor: Colors.sage[700],
    borderColor: Colors.sage[700],
  },
});
