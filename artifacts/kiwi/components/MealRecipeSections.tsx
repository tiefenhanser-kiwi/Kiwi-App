// Resub C5 — a meal's recipe, read-only: ingredients by dish, then the steps.
//
// Lifted out of app/test-kitchen/recipe.tsx so the Pick screen's preview sheet
// (components/MealPreviewSheet.tsx) renders the recipe through the SAME code
// rather than a third copy. The two shared decisions stay where they were —
// lib/format/ingredientLine.ts formatIngredientLine (the line) and
// lib/meals/mealSteps.ts (grouped-by-dish vs flat) — and this is only their
// chrome, moved unchanged.
//
// ⚠️ NOT app/meal/[id].tsx's body: that one carries the servings stepper, the
// amountRefs scaling, the timing-sensitive circle and the clarify hint — member
// surfaces with writes behind them. This is the guest recipe's read, which is
// also all a preview needs.

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import type { MealDetail } from "@/lib/api/meals";
import { formatIngredientLine } from "@/lib/format/ingredientLine";
import {
  flatMealSteps,
  mealStepsAreGrouped,
  stepBearingDishes,
} from "@/lib/meals/mealSteps";

/**
 * One numbered step row, read-only. Block 2b (BUG-315): numbered by POSITION in
 * its own list, not by `step.stepIndex` — in the grouped layout each dish's
 * numbering restarts at 1, which is what the member screen does, and a dish's
 * stepIndex is not guaranteed to start at 0 anyway.
 *
 * Deliberately NOT app/meal/[id].tsx's renderStepRow: that one carries the
 * timing-sensitive circle, the amountRefs scaling against a servings multiplier
 * this view has no stepper for, and the unmatched-amount clarify hint (a
 * prompt to edit, which a guest cannot). The shared piece is the DECISION
 * (lib/meals/mealSteps.ts), not the chrome.
 */
function renderStep(
  step: { text: string; estimatedMinutes: number },
  i: number,
): React.ReactElement {
  return (
    <View key={i} style={s.step}>
      <Text style={s.stepIndex}>{i + 1}</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.stepText}>{step.text}</Text>
        {step.estimatedMinutes > 0 ? (
          <Text style={s.stepMeta}>{step.estimatedMinutes} min</Text>
        ) : null}
      </View>
    </View>
  );
}

export function MealRecipeSections({ meal }: { meal: MealDetail }) {
  const stepsGrouped = mealStepsAreGrouped(meal);
  const flatSteps = flatMealSteps(meal);
  return (
    <>
      {/* Ingredients, by dish — the shape the meal actually has. */}
      {meal.dishes.map((dish, di) => (
        <View key={`${di}-${dish.title}`} style={s.card}>
          <Text style={s.cardTitle}>{dish.title}</Text>
          <View style={s.ingredients}>
            {dish.ingredients.map((ing, ii) => (
              <Text key={`${ii}-${ing.name}`} style={s.ingredient}>
                {formatIngredientLine(ing, { includeNotes: true })}
              </Text>
            ))}
          </View>
        </View>
      ))}

      {/* The steps. Block 2b (BUG-315): a multi-dish catalog meal's steps live
          on dishes[].steps (the meal-owned array is empty); the grouped/flat
          decision is the member screen's, shared. */}
      {stepsGrouped ? (
        stepBearingDishes(meal.dishes).map((dish, di) => (
          <View key={`steps-${di}-${dish.title}`} style={s.card}>
            <Text style={s.cardTitle}>Steps · {dish.title}</Text>
            <View style={s.steps}>{dish.steps.map(renderStep)}</View>
          </View>
        ))
      ) : flatSteps.length > 0 ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>Steps</Text>
          <View style={s.steps}>{flatSteps.map(renderStep)}</View>
        </View>
      ) : null}
    </>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    gap: Spacing[2],
  },
  cardTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  ingredients: { gap: 4 },
  ingredient: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  steps: { gap: Spacing[3] },
  step: { flexDirection: "row", gap: Spacing[3], alignItems: "flex-start" },
  stepIndex: {
    width: 22,
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
  },
  stepText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  stepMeta: {
    marginTop: 2,
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
});
