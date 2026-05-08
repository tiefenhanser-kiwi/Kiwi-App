import React, { useMemo } from "react";
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  getFeaturedDishes,
  getSavedDishes,
  getTopRatedDishes,
} from "@/lib/stubs";
import type { SavedDish } from "@/lib/types";

function findDishById(id: string): SavedDish | null {
  const all: SavedDish[] = [
    ...getSavedDishes(),
    ...getFeaturedDishes(),
    ...getTopRatedDishes(),
  ];
  return all.find((d) => d.id === id) ?? null;
}

export default function DishDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const dishId = id ?? "";

  const dish = useMemo(() => findDishById(dishId), [dishId]);

  if (!dish) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header title="Dish" showBack />
        <View style={s.notFoundWrap}>
          <Text style={s.notFoundText}>Dish not found.</Text>
          <Pressable
            onPress={() => router.back()}
            hitSlop={6}
            style={({ pressed }) => [
              s.notFoundLink,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={s.notFoundLinkText}>Go back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const onCookNow = () => {
    console.log("[dish-detail] cook-now tapped", { dishId: dish.id });
    router.push("/prep-cook");
  };

  const onEdit = () => {
    console.log("[dish-detail] edit tapped", { dishId: dish.id });
    router.push({
      pathname: "/dish-builder",
      params: { dishId: dish.id },
    });
  };

  const onCompost = () => {
    console.log("[dish-detail] compost tapped", { dishId: dish.id });
    Alert.alert(
      "Compost dish",
      `Compost ${dish.name}? It'll be removed from your dishes and any meals using it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Compost",
          style: "destructive",
          onPress: () => {
            // Same double-alert pattern as Meal Detail (5M deviation 4):
            // confirmation flow only in WS5; real soft-delete + meal-link
            // cleanup requires the API client (WS7).
            console.log("[dish-detail] compost confirmed", { dishId: dish.id });
            Alert.alert(
              "Coming in WS7",
              "Soft-deleting dishes requires the API client. The action will fully wire in WS7.",
              [{ text: "OK", onPress: () => router.back() }],
            );
          },
        },
      ],
    );
  };

  const macrosAllZero =
    dish.caloriesPerServing === 0 &&
    dish.proteinGPerServing === 0 &&
    dish.carbsGPerServing === 0 &&
    dish.fatGPerServing === 0;

  const metaParts = [
    dish.cuisineType,
    dish.estimatedTimeMinutes !== undefined
      ? `${dish.estimatedTimeMinutes} min`
      : null,
    "serves 4",
  ].filter(Boolean) as string[];

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header showBack title={dish.name} />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={s.hero}>
          {dish.imageUrl ? (
            <Image source={{ uri: dish.imageUrl }} style={s.heroImage} />
          ) : (
            <View style={[s.heroImage, s.heroFallback]} />
          )}
          <Text style={s.heroTitle}>{dish.name}</Text>
          <View style={s.metaRow}>
            <Text style={s.heroMeta}>{metaParts.join(" · ")}</Text>
            <View
              style={[
                s.typePill,
                dish.type === "main" ? s.typePillMain : s.typePillSide,
              ]}
            >
              <Text
                style={[
                  s.typePillText,
                  dish.type === "main"
                    ? s.typePillTextMain
                    : s.typePillTextSide,
                ]}
              >
                {dish.type === "main" ? "Main" : "Side"}
              </Text>
            </View>
          </View>
          <Text style={s.heroMacros}>
            {macrosAllZero
              ? "Macros not set"
              : `${dish.caloriesPerServing} cal · ${dish.proteinGPerServing}g P · ${dish.carbsGPerServing}g C · ${dish.fatGPerServing}g F`}
          </Text>
        </View>

        {/* Primary action */}
        <View style={s.primaryActionStack}>
          <Button label="Cook Now" variant="primary" onPress={onCookNow} />
        </View>

        {/* Secondary actions */}
        <View style={s.actionRow}>
          <View style={{ flex: 1 }}>
            <Button label="Edit" variant="ghost" onPress={onEdit} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Compost" variant="ghost" onPress={onCompost} />
          </View>
        </View>

        {/* Ingredients */}
        <View style={s.section}>
          <Text style={s.sectionHeader}>Ingredients</Text>
          {dish.ingredients.map((ing, i) => (
            <Text key={i} style={s.ingredientLine}>
              {ing.quantity} {ing.unit} {ing.name}
            </Text>
          ))}
        </View>

        {/* Steps (only if present) */}
        {dish.steps && dish.steps.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionHeader}>Steps</Text>
            {dish.steps.map((step) => (
              <View key={step.stepNumber} style={s.stepRow}>
                <View
                  style={[
                    s.stepCircle,
                    step.isTimingSensitive
                      ? s.stepCircleTiming
                      : s.stepCircleNormal,
                  ]}
                >
                  <Text
                    style={
                      step.isTimingSensitive
                        ? s.stepCircleTextTiming
                        : s.stepCircleTextNormal
                    }
                  >
                    {step.stepNumber}
                  </Text>
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={s.stepText}>{step.text}</Text>
                  {step.estimatedMinutes !== undefined && (
                    <Text style={s.stepMeta}>{step.estimatedMinutes} min</Text>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Notes (only if present) */}
        {dish.notes && (
          <View style={s.section}>
            <Text style={s.sectionHeader}>Notes</Text>
            <Text style={s.notesText}>{dish.notes}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.md,
    paddingBottom: 200,
  },
  notFoundWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: KSpacing.xl,
    gap: KSpacing.md,
  },
  notFoundText: {
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  notFoundLink: {
    paddingVertical: KSpacing.sm,
    paddingHorizontal: KSpacing.md,
  },
  notFoundLinkText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  hero: {
    gap: KSpacing.sm,
  },
  heroImage: {
    width: "100%",
    height: 200,
    borderRadius: KRadius.lg,
    backgroundColor: KColors.neutral[200],
  },
  heroFallback: {
    backgroundColor: KColors.sage[100],
  },
  heroTitle: {
    fontSize: KType.size.xl,
    color: KColors.neutral[900],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
    marginTop: KSpacing.sm,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  heroMeta: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  typePill: {
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 3,
    borderRadius: KRadius.pill,
    borderWidth: 1,
  },
  typePillSide: {
    backgroundColor: KColors.sage[50],
    borderColor: KColors.sage[300],
  },
  typePillMain: {
    backgroundColor: KColors.terracotta[50],
    borderColor: KColors.terracotta[300],
  },
  typePillText: {
    fontSize: KType.size.xs,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  typePillTextSide: {
    color: KColors.sage[700],
  },
  typePillTextMain: {
    color: KColors.terracotta[700],
  },
  heroMacros: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  primaryActionStack: {
    gap: KSpacing.sm,
    marginTop: KSpacing.lg,
  },
  actionRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    marginTop: KSpacing.sm,
  },
  section: {
    marginTop: KSpacing.lg,
  },
  sectionHeader: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.md,
  },
  ingredientLine: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  stepRow: {
    flexDirection: "row",
    gap: KSpacing.md,
    marginBottom: KSpacing.md,
    alignItems: "flex-start",
  },
  stepCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  stepCircleNormal: {
    backgroundColor: KColors.sage[100],
  },
  stepCircleTiming: {
    backgroundColor: KColors.terracotta[200],
  },
  stepCircleTextNormal: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  stepCircleTextTiming: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  stepText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  stepMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  notesText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
});
