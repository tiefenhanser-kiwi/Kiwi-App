import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { MealCard } from "@/components/MealCard";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KSpacing, KType } from "@/constants/tokens";
import { getRecipe } from "@/lib/mockData";

export default function PlanResults() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { plans } = useApp();
  const plan = plans.find((p) => p.id === id) ?? null;

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

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title={plan.name} subtitle="Kiwi cooked up" showBack />
      <Screen>
        <View style={s.banner}>
          <Feather name="check-circle" size={20} color={KColors.sage[700]} />
          <Text style={s.bannerText}>
            {plan.meals.length} meals planned. Grocery list ready when you are.
          </Text>
        </View>

        <View style={{ gap: KSpacing.md }}>
          {plan.meals.map((slot, idx) => {
            const r = getRecipe(slot.recipeId);
            if (!r) return null;
            return (
              <MealCard
                key={`${slot.day}-${slot.slot}-${idx}`}
                recipe={r}
                day={slot.day}
                slot={slot.slot}
                onPress={() => router.push(`/recipe/${r.id}`)}
              />
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
  empty: {
    color: KColors.neutral[700],
    fontSize: KType.size.md,
    textAlign: "center",
    marginTop: 40,
    fontFamily: "Inter_400Regular",
  },
});
