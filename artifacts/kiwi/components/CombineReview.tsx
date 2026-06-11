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

import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
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
    <View style={{ marginTop: KSpacing.lg, gap: KSpacing.md }}>
      <View style={s.subHeaderRow}>
        <Text style={s.subHeader}>Review combined meal</Text>
        <Pressable
          onPress={onBack}
          hitSlop={6}
          style={({ pressed }) => [s.addLinkBtn, pressed && { opacity: 0.7 }]}
        >
          <Feather name="chevron-left" size={14} color={KColors.sage[700]} />
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
          placeholderTextColor={KColors.neutral[600]}
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
          <Text style={s.reviewDishHeader}>{dish.name}</Text>
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
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  addLinkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: KSpacing.xs,
  },
  addLinkText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  fieldLabel: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  textInput: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  inputInvalid: {
    borderColor: KColors.terracotta[400],
  },
  invalidBadge: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
    marginLeft: 4,
  },
  helperText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  reviewDish: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    gap: 4,
  },
  reviewDishHeader: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  reviewIngredient: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
});
