// /test-kitchen/recipe — Row 13 · Block 2 Part D. The guest's full recipe.
//
// R4, Hans: "I think it's fine to read the full recipe in the plan." This is that
// read, and it comes from GET /meals/:id with the guest principal — the one
// catalog route mounted behind requireGuestOrAuth — keyed on the
// `sourceStoreMealId` of the plan slot. The draft itself cannot serve it: the
// expand's details stage carries ingredients and macros but no `steps` (see
// lib/guest/guestPlanModel.ts's header).
//
// ⚠️ NOT app/meal/[id].tsx. That screen's read is useMeal → getMeal with the USER
// principal (a guest token there is a 401 and the cascade), and its surface is
// favourites, servings PATCH, the add-to-plan sheet, canonical-servings writes and
// the plan-item override path — every one of them member-only. What a guest needs
// is the recipe: ingredients by dish, then the steps.
//
// 🔴 HOOKS SIT ABOVE THE EARLY RETURNS.

import React from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { GuestDoorSheet } from "@/components/GuestDoorSheet";
import { Header } from "@/components/Header";
import { LoadingShim } from "@/components/LoadingShim";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useGuest } from "@/contexts/GuestContext";
import { useGuestDoor } from "@/hooks/useGuestDoor";
import { trackGuestEvent } from "@/lib/api/guest";
import { getMeal } from "@/lib/api/meals";
// Block 2b (BUG-315) — the shared line formatter and the shared steps decision.
// Both were extracted from app/meal/[id].tsx, which now calls them too; see each
// file's header for what this screen got wrong before them.
import { formatIngredientLine } from "@/lib/format/ingredientLine";
import {
  flatMealSteps,
  mealStepsAreGrouped,
  stepBearingDishes,
} from "@/lib/meals/mealSteps";

export const GUEST_RECIPE_GONE =
  "Kiwi could not find this recipe. It may have been updated since your plan was built.";

/**
 * One numbered step row, read-only. Block 2b (BUG-315): numbered by POSITION in
 * its own list, not by `step.stepIndex` — in the grouped layout each dish's
 * numbering restarts at 1, which is what the member screen does, and a dish's
 * stepIndex is not guaranteed to start at 0 anyway.
 *
 * Deliberately NOT app/meal/[id].tsx's renderStepRow: that one carries the
 * timing-sensitive circle, the amountRefs scaling against a servings multiplier
 * this screen has no stepper for, and the unmatched-amount clarify hint (a
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

export default function GuestRecipeRoute() {
  if (Platform.OS !== "web") return <Redirect href="/" />;
  return <GuestRecipeScreen />;
}

function GuestRecipeScreen() {
  const router = useRouter();
  const { session } = useGuest();
  const guestDoor = useGuestDoor();
  const params = useLocalSearchParams<{ mealId?: string }>();
  const mealId = params.mealId ?? "";

  const mealQuery = useQuery({
    queryKey: ["guest", "meal", mealId],
    queryFn: () => getMeal(mealId, undefined, { principal: "guest" }),
    enabled: mealId.length > 0 && !!session,
  });
  const meal = mealQuery.data ?? null;

  React.useEffect(() => {
    if (meal) void trackGuestEvent("recipe_opened", { meta: { mealId } });
  }, [meal, mealId]);

  // Block 2b (BUG-315) — the shared decision, computed once. Both are safe on a
  // null meal (the query has not resolved) because the shapes default to empty.
  const stepsGrouped = meal ? mealStepsAreGrouped(meal) : false;
  const flatSteps = meal ? flatMealSteps(meal) : [];

  if (!session) return <Redirect href="/test-kitchen" />;

  return (
    <View style={s.screen}>
      <Header
        showBack
        onBack={() => router.back()}
        title={meal?.title ?? "Recipe"}
        subtitle={
          meal
            ? [
                meal.minutes ? `${meal.minutes} min` : null,
                `${meal.effectiveServings} servings`,
                meal.cuisine,
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
      />
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {mealQuery.isLoading ? (
          <LoadingShim variant="inline" label="Opening the recipe…" />
        ) : null}

        {mealQuery.isError ? (
          <View style={s.statusCard}>
            <Text style={s.statusTitle}>Recipe not found</Text>
            <Text style={s.statusBody}>{GUEST_RECIPE_GONE}</Text>
            <Button label="Back to the plan" variant="primary" onPress={() => router.back()} />
          </View>
        ) : null}

        {meal ? (
          <>
            {meal.description ? <Text style={s.headnote}>{meal.description}</Text> : null}

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

            {/* The steps. A catalog meal has them; this is the whole reason the
                recipe is read from GET /meals/:id and not from the draft.
                Block 2b (BUG-315): this read `meal.steps`, the MEAL-owned array,
                which is empty on every multi-dish catalog meal — the steps live
                on dishes[].steps. The grouped/flat decision is now the member
                screen's, shared (lib/meals/mealSteps.ts). */}
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

            <View style={s.doors}>
              <Button
                label="Save this plan to my account"
                variant="primary"
                onPress={() => guestDoor.open("save_plan")}
                testID="guest-recipe-save"
              />
              <Button
                label="Prep & Cook"
                variant="ghost"
                onPress={() => guestDoor.open("prep_cook")}
                testID="guest-recipe-prep"
              />
            </View>
          </>
        ) : null}
      </ScrollView>
      <GuestDoorSheet action={guestDoor.door} onClose={guestDoor.close} />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.neutral[100] },
  scroll: { padding: Spacing[4], paddingBottom: Spacing[8], gap: Spacing[3] },
  headnote: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
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
  doors: { gap: Spacing[2], marginTop: Spacing[2] },
  statusCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[3],
  },
  statusTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  statusBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
});
