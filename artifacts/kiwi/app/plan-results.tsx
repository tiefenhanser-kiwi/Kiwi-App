import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { MealCard } from "@/components/MealCard";
import { Screen } from "@/components/Screen";
import { SwapSheet } from "@/components/SwapSheet";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getRecipe } from "@/lib/mockData";

export default function PlanResults() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { plans, swapMealInCurrentPlan, currentPlanId } = useApp();
  const plan = plans.find((p) => p.id === id) ?? null;
  const isCurrent = plan?.id === currentPlanId;

  const [swapIndex, setSwapIndex] = useState<number | null>(null);

  if (!plan) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header title="Plan" showBack />
        <Screen>
          <Text style={s.empty}>Plan not found.</Text>
        </Screen>
      </View>
    );
  }

  const swapTarget = swapIndex !== null ? plan.meals[swapIndex] : null;

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title={plan.name} subtitle="Kiwi cooked up" showBack />
      <Screen>
        <View style={s.banner}>
          <Feather name="check-circle" size={20} color={KColors.sage[700]} />
          <Text style={s.bannerText}>
            {plan.notes ||
              `${plan.meals.length} meals planned. Grocery list ready when you are.`}
          </Text>
        </View>

        <View style={{ gap: KSpacing.md }}>
          {plan.meals.map((slot, idx) => {
            const r = getRecipe(slot.recipeId);
            if (!r) return null;
            return (
              <View key={`${slot.day}-${slot.slot}-${idx}`}>
                <MealCard
                  recipe={r}
                  day={slot.day}
                  slot={slot.slot}
                  onPress={() => router.push(`/recipe/${r.id}`)}
                />
                {slot.reason && (
                  <Text style={s.reason}>"{slot.reason}"</Text>
                )}
                {isCurrent && (
                  <Pressable
                    onPress={() => setSwapIndex(idx)}
                    style={({ pressed }) => [
                      s.swapBtn,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Feather
                      name="refresh-cw"
                      size={14}
                      color={KColors.sage[700]}
                    />
                    <Text style={s.swapText}>Swap this meal</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>

        <View style={{ height: KSpacing.xl }} />
        <Button
          label="Open grocery list"
          variant="terra"
          onPress={() => router.replace("/(tabs)/groceries")}
          iconLeft={<Feather name="shopping-bag" size={16} color="#fff" />}
        />
        <View style={{ height: KSpacing.sm }} />
        <Button
          label="Back to home"
          variant="ghost"
          onPress={() => router.replace("/(tabs)")}
        />
      </Screen>

      <SwapSheet
        visible={swapIndex !== null}
        excludeId={swapTarget?.recipeId}
        onClose={() => setSwapIndex(null)}
        onPick={(r) => {
          if (swapIndex !== null) {
            swapMealInCurrentPlan(swapIndex, r.id);
          }
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KColors.sage[50],
    borderColor: KColors.sage[300],
    borderWidth: 1,
    borderRadius: 12,
    padding: KSpacing.md,
    marginBottom: KSpacing.lg,
  },
  bannerText: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: "500",
    fontFamily: "Inter_500Medium",
  },
  reason: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontStyle: "italic",
    marginTop: KSpacing.xs,
    paddingHorizontal: KSpacing.sm,
    fontFamily: "Inter_400Regular",
  },
  swapBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    marginTop: KSpacing.xs,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 6,
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.sage[300],
  },
  swapText: {
    fontSize: KType.size.xs,
    color: KColors.sage[700],
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
  empty: {
    color: KColors.neutral[700],
    fontSize: KType.size.md,
    textAlign: "center",
    marginTop: 40,
    fontFamily: "Inter_400Regular",
  },
});
