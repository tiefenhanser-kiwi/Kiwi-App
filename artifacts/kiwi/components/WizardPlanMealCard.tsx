// WS7-5c Block B (mobile) — per-meal validation card on the wizard's
// Plan Details screen.
//
// Hans's product flow: "View Plan Details" is a *draft-validation view*
// (is this the plan I want?), not a cookbook. Each meal renders as a
// card showing meal-level summary; tapping the header expands it to
// reveal, per dish: title + role, the per-dish macro line, and the
// ingredient list. **No steps** — steps are produced server-side at
// Save / Save and Use (Block A's finalize_steps call) and live on the
// post-save meal-detail / Cook Mode path.
//
// Default state is collapsed: a 5-day plan otherwise produces a wall of
// text before the user has decided whether to keep the plan. Tapping
// the header (Pressable + chevron, matching PlanDiscoveryCard's pattern)
// flips it open. Component is intentionally stateless about its peers —
// each card owns its own open/closed flag, so expanding one doesn't
// collapse another (matches Hans's "validation" framing where the user
// often wants to compare two meals side-by-side).

import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { formatMacro } from "@/lib/format/macros";
import type { WizardExpandEnrichedMeal } from "@/lib/api/wizard";

export interface WizardPlanMealCardProps {
  meal: WizardExpandEnrichedMeal;
  index: number;
  /**
   * Test-only override for the initial expanded state. Production callers
   * never pass this — default is collapsed (Hans's ruling). Tests use it
   * to assert the expanded render path without simulating a tap.
   */
  initiallyExpanded?: boolean;
}

export function WizardPlanMealCard({
  meal,
  index,
  initiallyExpanded = false,
}: WizardPlanMealCardProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);

  return (
    <View style={s.mealSection}>
      <Pressable
        onPress={() => setExpanded((x) => !x)}
        style={({ pressed }) => [s.header, pressed && { opacity: 0.6 }]}
        hitSlop={6}
      >
        <View style={s.headerText}>
          <Text style={s.mealHeader}>
            Day {index + 1} · {meal.title}
          </Text>
          <Text style={s.mealMeta}>
            {meal.cuisineType} · {meal.estimatedTimeMinutes} min · serves{" "}
            {meal.servings}
          </Text>
        </View>
        <Feather
          name={expanded ? "chevron-up" : "chevron-down"}
          size={18}
          color={Colors.sage[700]}
        />
      </Pressable>

      {expanded &&
        meal.dishes.map((dish, di) => (
          <View key={`${dish.title}-${di}`} style={s.dishCard}>
            <Text style={s.dishTitle}>{dish.title}</Text>
            <Text style={s.dishRole}>{dish.role}</Text>
            {dish.macros && !dish.macros.failed && (
              <Text style={s.dishMacros}>
                {formatMacro(dish.macros.caloriesPerServing, "0")} cal ·{" "}
                {formatMacro(dish.macros.proteinGPerServing, "0")}g P ·{" "}
                {formatMacro(dish.macros.carbsGPerServing, "0")}g C ·{" "}
                {formatMacro(dish.macros.fatGPerServing, "0")}g F (per serving)
              </Text>
            )}

            <Text style={s.subSectionLabel}>Ingredients</Text>
            {dish.ingredients.map((ing, ii) => (
              <View key={`${ing.name}-${ii}`} style={s.bulletRow}>
                <View style={s.bulletDot} />
                <Text style={s.bulletText}>
                  {ing.quantity} {ing.unit} {ing.name}
                  {ing.preparationNote ? `, ${ing.preparationNote}` : ""}
                  {ing.isOptional ? " (optional)" : ""}
                </Text>
              </View>
            ))}
          </View>
        ))}
    </View>
  );
}

const s = StyleSheet.create({
  mealSection: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
    gap: Spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
  },
  headerText: {
    flex: 1,
  },
  mealHeader: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  mealMeta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  dishCard: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    padding: Spacing[3],
    marginTop: Spacing[2],
    gap: 4,
  },
  dishTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  dishRole: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
    textTransform: "capitalize",
  },
  dishMacros: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  subSectionLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[600],
    fontWeight: Typography.fontWeight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: Typography.face.sans[600],
    marginTop: Spacing[2],
  },
  bulletRow: {
    flexDirection: "row",
    gap: Spacing[2],
    alignItems: "flex-start",
  },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: Colors.sage[600],
    marginTop: 7,
  },
  bulletText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
});
