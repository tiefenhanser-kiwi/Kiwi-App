import React from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { useDish } from "@/hooks/useDish";
import { ApiError } from "@/lib/api/errors";
import type { DishDetail } from "@/lib/api/dishes";

// WS7-3 Block C3 c3: dish detail reads GET /dishes/:id via useDish. Adopts
// the Block B gate/body pattern from app/meal/[id].tsx — DishDetailScreen
// handles the read state machine; DishDetailContent renders the loaded body.
//
// Field loss vs the C3 stub (D-WS7-050): no Main/Side type pill, no Notes
// section, no cuisine in the meta line — DishDetail's server shape omits
// `type`, `notes`, `cuisine`. Gains: description (replacing implied prose),
// real `servings` (replacing the hardcoded "serves 4").
export default function DishDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const dishId = id ?? "";

  const dishQuery = useDish(dishId);

  if (dishQuery.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header title="Dish" showBack />
        <View style={s.gateWrap}>
          <ActivityIndicator color={KColors.sage[700]} />
        </View>
      </View>
    );
  }

  const dish = dishQuery.data;
  if (!dish) {
    const err = dishQuery.error;
    const isNotFound =
      dishId === "" || (err instanceof ApiError && err.status === 404);
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header title="Dish" showBack />
        <View style={s.gateWrap}>
          <Text style={s.gateText}>
            {isNotFound
              ? "Dish not found."
              : "Couldn't load this dish. Please try again."}
          </Text>
          <View style={s.gateBtnWrap}>
            {isNotFound ? (
              <Button
                label="Go back"
                variant="ghost"
                onPress={() => router.back()}
              />
            ) : (
              <Button
                label="Try again"
                variant="primary"
                onPress={() => dishQuery.refetch()}
              />
            )}
          </View>
        </View>
      </View>
    );
  }

  return <DishDetailContent dish={dish} />;
}

function DishDetailContent({ dish }: { dish: DishDetail }) {
  const router = useRouter();

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
      `Compost ${dish.title}? It'll be removed from your dishes and any meals using it.`,
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
    dish.calories === 0 &&
    dish.protein === 0 &&
    dish.carbs === 0 &&
    dish.fat === 0;

  const metaParts = [
    dish.minutes > 0 ? `${dish.minutes} min` : null,
    `serves ${dish.servings}`,
  ].filter(Boolean) as string[];

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header showBack title={dish.title} />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.hero}>
          {dish.image ? (
            <Image source={{ uri: dish.image }} style={s.heroImage} />
          ) : (
            <View style={[s.heroImage, s.heroFallback]} />
          )}
          <Text style={s.heroTitle}>{dish.title}</Text>
          {dish.description && (
            <Text style={s.heroDescription}>{dish.description}</Text>
          )}
          <Text style={s.heroMeta}>{metaParts.join(" · ")}</Text>
          <Text style={s.heroMacros}>
            {macrosAllZero
              ? "Macros not set"
              : `${dish.calories} cal · ${dish.protein}g P · ${dish.carbs}g C · ${dish.fat}g F`}
          </Text>
        </View>

        <View style={s.primaryActionStack}>
          <Button label="Cook Now" variant="primary" onPress={onCookNow} />
        </View>

        <View style={s.actionRow}>
          <View style={{ flex: 1 }}>
            <Button label="Edit" variant="ghost" onPress={onEdit} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Compost" variant="ghost" onPress={onCompost} />
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionHeader}>Ingredients</Text>
          {dish.ingredients.map((ing, i) => (
            <Text key={i} style={s.ingredientLine}>
              {ing.quantity} {ing.unit} {ing.name}
            </Text>
          ))}
        </View>

        {dish.steps.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionHeader}>Steps</Text>
            {dish.steps.map((step, i) => (
              <View key={i} style={s.stepRow}>
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
                    {i + 1}
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
  gateWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: KSpacing.xl,
    gap: KSpacing.md,
  },
  gateText: {
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  gateBtnWrap: {
    minWidth: 160,
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
  heroDescription: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    lineHeight: 18,
  },
  heroMeta: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
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
});
