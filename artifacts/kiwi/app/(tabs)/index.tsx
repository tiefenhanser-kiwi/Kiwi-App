import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Header } from "@/components/Header";
import { MealCard } from "@/components/MealCard";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KSpacing, KType } from "@/constants/tokens";
import { getRecipe } from "@/lib/mockData";

export default function HomeTab() {
  const router = useRouter();
  const { currentPlan, groceries, isPremium } = useApp();

  const upcoming = useMemo(() => {
    if (!currentPlan) return [];
    return currentPlan.meals.slice(0, 5);
  }, [currentPlan]);

  const remaining = groceries.filter((g) => !g.checked && !g.inPantry).length;

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        title="This Week"
        subtitle={
          currentPlan
            ? `Week of ${formatWeek(currentPlan.weekStart)}`
            : "No plan yet"
        }
        rightIcon="plus-circle"
        onRightPress={() => router.push("/wizard")}
      />
      <Screen>
        <Card style={styles.heroCard} padded>
          <View style={styles.heroRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroLabel}>Tonight's dinner</Text>
              {upcoming[0] ? (
                <Text style={styles.heroTitle}>
                  {getRecipe(upcoming[0].recipeId)?.title}
                </Text>
              ) : (
                <Text style={styles.heroTitle}>No meal scheduled</Text>
              )}
              <View style={styles.heroMetaRow}>
                <View style={styles.heroMeta}>
                  <Feather name="shopping-bag" size={14} color={KColors.sage[700]} />
                  <Text style={styles.heroMetaText}>{remaining} items left</Text>
                </View>
                {!isPremium && (
                  <View style={styles.heroMeta}>
                    <Feather name="star" size={14} color={KColors.terracotta[400]} />
                    <Text style={styles.heroMetaText}>Free plan</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
          <View style={{ height: KSpacing.md }} />
          <Button
            label="Start cooking"
            variant="terra"
            onPress={() => {
              if (upcoming[0]) {
                router.push(`/cookmode/${upcoming[0].recipeId}`);
              }
            }}
            disabled={!upcoming[0]}
          />
        </Card>

        <Text style={styles.sectionTitle}>Up next</Text>
        <View style={{ gap: KSpacing.md }}>
          {upcoming.map((slot, idx) => {
            const recipe = getRecipe(slot.recipeId);
            if (!recipe) return null;
            return (
              <MealCard
                key={`${slot.day}-${slot.slot}-${idx}`}
                recipe={recipe}
                day={slot.day}
                slot={slot.slot}
                onPress={() => router.push(`/recipe/${recipe.id}`)}
              />
            );
          })}
        </View>

        <View style={{ height: KSpacing.xl }} />
        <Card padded>
          <View style={styles.quickRow}>
            <Feather name="message-circle" size={20} color={KColors.terracotta[400]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.quickTitle}>Tell Kiwi what you need</Text>
              <Text style={styles.quickBody}>
                "Quick weeknight dinners under 30 minutes."
              </Text>
            </View>
          </View>
          <View style={{ height: KSpacing.md }} />
          <Button
            label="Open Tell Kiwi"
            variant="secondary"
            onPress={() => router.push("/tellkiwi")}
          />
        </Card>

        <View style={{ height: KSpacing.md }} />
        <Card padded onPress={() => router.push("/library")}>
          <View style={styles.quickRow}>
            <Feather name="book" size={20} color={KColors.sage[700]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.quickTitle}>Recipe library</Text>
              <Text style={styles.quickBody}>
                Browse all recipes and save the ones you love.
              </Text>
            </View>
            <Feather name="chevron-right" size={20} color={KColors.neutral[600]} />
          </View>
        </Card>
      </Screen>
    </View>
  );
}

function formatWeek(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const styles = StyleSheet.create({
  heroCard: {
    backgroundColor: KColors.sage[700],
    borderColor: KColors.sage[800],
    marginBottom: KSpacing.xl,
  },
  heroRow: { flexDirection: "row" },
  heroLabel: {
    fontSize: KType.size.xs,
    color: "rgba(232,239,226,0.7)",
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
  },
  heroTitle: {
    fontSize: KType.size.xl,
    color: KColors.neutral[100],
    fontWeight: "700",
    marginTop: 4,
    fontFamily: "Inter_700Bold",
  },
  heroMetaRow: {
    flexDirection: "row",
    gap: KSpacing.lg,
    marginTop: KSpacing.sm,
  },
  heroMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  heroMetaText: {
    fontSize: KType.size.sm,
    color: "rgba(232,239,226,0.85)",
    fontFamily: "Inter_400Regular",
  },
  sectionTitle: {
    fontSize: KType.size.lg,
    fontWeight: "600",
    color: KColors.neutral[900],
    marginBottom: KSpacing.md,
    fontFamily: "Inter_600SemiBold",
  },
  quickRow: { flexDirection: "row", gap: KSpacing.md, alignItems: "flex-start" },
  quickTitle: {
    fontSize: KType.size.md,
    fontWeight: "600",
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  quickBody: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    marginTop: 2,
    fontFamily: "Inter_400Regular",
  },
});
