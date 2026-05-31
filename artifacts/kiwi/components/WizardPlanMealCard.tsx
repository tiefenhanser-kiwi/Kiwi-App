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

import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
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
          color={KColors.sage[700]}
        />
      </Pressable>

      {expanded &&
        meal.dishes.map((dish, di) => (
          <View key={`${dish.title}-${di}`} style={s.dishCard}>
            <Text style={s.dishTitle}>{dish.title}</Text>
            <Text style={s.dishRole}>{dish.role}</Text>
            {dish.macros && !dish.macros.failed && (
              <Text style={s.dishMacros}>
                {Math.round(dish.macros.caloriesPerServing)} cal ·{" "}
                {Math.round(dish.macros.proteinGPerServing)}g P ·{" "}
                {Math.round(dish.macros.carbsGPerServing)}g C ·{" "}
                {Math.round(dish.macros.fatGPerServing)}g F (per serving)
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
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    gap: KSpacing.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
  },
  headerText: {
    flex: 1,
  },
  mealHeader: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  mealMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  dishCard: {
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    padding: KSpacing.md,
    marginTop: KSpacing.sm,
    gap: 4,
  },
  dishTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  dishRole: {
    fontSize: KType.size.xs,
    color: KColors.sage[700],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
    textTransform: "capitalize",
  },
  dishMacros: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  subSectionLabel: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
    marginTop: KSpacing.sm,
  },
  bulletRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    alignItems: "flex-start",
  },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: KColors.sage[600],
    marginTop: 7,
  },
  bulletText: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
});
