// WS7-6 G1 — Mode C "Review combined meal" surface, extracted from
// app/meal-builder.tsx so the greyed-Save fix is testable in isolation (the
// screen itself pulls in react-native-draggable-flatlist, which the node test
// harness doesn't stub — same reason Block 4 extracted DishChooserSheetView).
//
// The fix: the meal-name input now lives HERE, on the surface where Save lives.
// Pre-fix the name input was only on the picker step, so a user who tapped
// "Continue with selected" without naming the meal landed on a greyed Save with
// no input to fix it and no messaging (PRD §10.5.3 violation). `nameError`
// mirrors the manual editor's saveAttempted-gated inline error.

import React from "react";
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { resolveDisplayTitle } from "@/components/DisplayTitle";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import type { SavedDish } from "@/lib/types";

export interface CombineReviewProps {
  savedDishes: SavedDish[];
  selectedDishIds: string[];
  onBack: () => void;
  /** Meal name state — same value the picker's MetaFields edits; pre-filled
   *  when the user named the meal on the picker step. */
  mealName: string;
  setMealName: (v: string) => void;
  /** True when the parent's saveAttempted gate is open AND the name is blank. */
  nameError: boolean;
}

export function CombineReview({
  savedDishes,
  selectedDishIds,
  onBack,
  mealName,
  setMealName,
  nameError,
}: CombineReviewProps) {
  const selected = savedDishes.filter((d) => selectedDishIds.includes(d.id));
  return (
    <View style={{ marginTop: Spacing[4], gap: Spacing[3] }}>
      <View style={s.subHeaderRow}>
        <Text style={s.subHeader}>Review combined meal</Text>
        <Pressable
          onPress={onBack}
          hitSlop={6}
          style={({ pressed }) => [s.addLinkBtn, pressed && { opacity: 0.7 }]}
        >
          <Feather name="chevron-left" size={14} color={Colors.sage[700]} />
          <Text style={s.addLinkText}>Back to picker</Text>
        </Pressable>
      </View>

      {/* Meal name — present here so Save (which lives on this surface) always
          has a reachable name input + validation messaging. */}
      <View>
        <Text style={s.fieldLabel}>Meal name</Text>
        <TextInput
          value={mealName}
          onChangeText={setMealName}
          placeholder="Meal name (e.g., Salmon Teriyaki)"
          placeholderTextColor={Colors.neutral[600]}
          style={[s.textInput, nameError && s.inputInvalid]}
          returnKeyType="done"
          blurOnSubmit
          onSubmitEditing={Keyboard.dismiss}
          testID="combine-review-name"
        />
        {nameError && (
          <Text style={s.invalidBadge}>Add a meal name to save.</Text>
        )}
      </View>

      <Text style={s.helperText}>
        After saving, you can edit any dish or ingredient individually.
      </Text>
      {selected.map((dish) => (
        <View key={dish.id} style={s.reviewDish}>
          <Text style={s.reviewDishHeader}>{resolveDisplayTitle(dish)}</Text>
          {dish.ingredients.map((ing, i) => (
            <Text key={i} style={s.reviewIngredient}>
              {ing.quantity} {ing.unit} {ing.name}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  subHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  subHeader: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  addLinkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: Spacing[1],
  },
  addLinkText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  fieldLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginBottom: 4,
  },
  textInput: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  inputInvalid: {
    borderColor: Colors.terracotta[400],
  },
  invalidBadge: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
    marginLeft: 4,
  },
  helperText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  reviewDish: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
    gap: 4,
  },
  reviewDishHeader: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: 4,
  },
  reviewIngredient: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
});
