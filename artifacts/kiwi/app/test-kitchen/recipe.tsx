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
import { formatQuantity } from "@/lib/format/quantity";

export const GUEST_RECIPE_GONE =
  "Kiwi could not find this recipe. It may have been updated since your plan was built.";

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
                meal.estimatedTimeMinutes ? `${meal.estimatedTimeMinutes} min` : null,
                `${meal.effectiveServings} servings`,
                meal.cuisineType,
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
                      {[
                        formatQuantity(ing.quantity, ing.unit),
                        ing.name,
                        ing.preparationNote ? `(${ing.preparationNote})` : null,
                        ing.isOptional ? "— optional" : null,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    </Text>
                  ))}
                </View>
              </View>
            ))}

            {/* The steps. A catalog meal has them; this is the whole reason the
                recipe is read from GET /meals/:id and not from the draft. */}
            {meal.steps.length > 0 ? (
              <View style={s.card}>
                <Text style={s.cardTitle}>Steps</Text>
                <View style={s.steps}>
                  {meal.steps.map((step) => (
                    <View key={step.stepIndex} style={s.step}>
                      <Text style={s.stepIndex}>{step.stepIndex + 1}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={s.stepText}>{step.text}</Text>
                        {step.estimatedMinutes > 0 ? (
                          <Text style={s.stepMeta}>{step.estimatedMinutes} min</Text>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </View>
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
