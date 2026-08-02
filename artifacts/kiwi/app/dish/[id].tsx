import React from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { SectionLabel } from "@/components/SectionLabel";
import { TreatedImage } from "@/components/TreatedImage";
import { Colors, ImageTreatment, Radius, Spacing, Typography } from "@/constants/tokens";
import { useDish } from "@/hooks/useDish";
import { ApiError } from "@/lib/api/errors";
import type { DishDetail } from "@/lib/api/dishes";
import { formatMacro } from "@/lib/format/macros";

// WS7-3 Block C3 c3: dish detail reads GET /dishes/:id via useDish. Adopts
// the Block B gate/body pattern from app/meal/[id].tsx — DishDetailScreen
// handles the read state machine; DishDetailContent renders the loaded body.
//
// D-WS7-050 (RULED 2026-08-02 — ratify the LEAN dish shape): this screen
// intentionally renders NO Main/Side type pill, NO Notes section, and NO
// cuisine in the meta line. The Dish model has no `type`/`notes`/`cuisineType`
// columns and none are being added, so there is nothing to restore — the lean
// shape (description + real `servings`) IS the shape. The prior "field loss"
// framing is retired.
export default function DishDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const dishId = id ?? "";

  const dishQuery = useDish(dishId);

  if (dishQuery.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header title="Dish" showBack />
        <View style={s.gateWrap}>
          <ActivityIndicator color={Colors.sage[700]} />
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
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
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
    // WS7-8b B2 — meal-context "Cook Now" → temporary /cook-session stub (the
    // Hub took over /prep-cook). Block 3 owns the real single-meal Cook session.
    router.push({ pathname: "/cook-session", params: { dishId: dish.id } });
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
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header showBack title={dish.title} />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.hero}>
          {/* Treated image slot (16:10, warm-gradient placeholder default —
              dish photos ship in WS7-10). */}
          <TreatedImage
            source={dish.image ? { uri: dish.image } : null}
            aspectRatio={ImageTreatment.aspect.hero}
            radius={Radius["2xl"]}
            style={s.heroImage}
          />
          <Text style={s.heroTitle}>{dish.title}</Text>
          {dish.description && (
            <Text style={s.heroDescription}>{dish.description}</Text>
          )}
          <Text style={s.heroMeta}>{metaParts.join(" · ")}</Text>
          <Text style={s.heroMacros}>
            {macrosAllZero
              ? "Macros not set"
              : `${formatMacro(dish.calories, "0")} cal · ${formatMacro(dish.protein, "0")}g P · ${formatMacro(dish.carbs, "0")}g C · ${formatMacro(dish.fat, "0")}g F`}
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
          <SectionLabel label="Ingredients" />
          {dish.ingredients.map((ing, i) => (
            <Text key={i} style={s.ingredientLine}>
              {ing.quantity} {ing.unit} {ing.name}
            </Text>
          ))}
        </View>

        {dish.steps.length > 0 && (
          <View style={s.section}>
            <SectionLabel label="Steps" />
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
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: 200,
  },
  gateWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing[5],
    gap: Spacing[3],
  },
  gateText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  gateBtnWrap: {
    minWidth: 160,
  },
  hero: {
    gap: Spacing[2],
  },
  // TreatedImage owns aspect / radius / placeholder / overlay; pin width only.
  heroImage: {
    width: "100%",
  },
  // BUG-035 — bold weight now rides the Fraunces_700Bold face (no synthetic bold).
  heroTitle: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
    marginTop: Spacing[2],
  },
  heroDescription: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    lineHeight: 18,
  },
  heroMeta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  heroMacros: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  primaryActionStack: {
    gap: Spacing[2],
    marginTop: Spacing[4],
  },
  actionRow: {
    flexDirection: "row",
    gap: Spacing[2],
    marginTop: Spacing[2],
  },
  section: {
    marginTop: Spacing[4],
  },
  ingredientLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  stepRow: {
    flexDirection: "row",
    gap: Spacing[3],
    marginBottom: Spacing[3],
    alignItems: "flex-start",
  },
  stepCircle: {
    width: 32,
    height: 32,
    // D-WS9-022 — full radius for a 32px circle (was the ambiguous old-xl 16).
    borderRadius: Radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  stepCircleNormal: {
    backgroundColor: Colors.sage[100],
  },
  stepCircleTiming: {
    backgroundColor: Colors.terracotta[200],
  },
  stepCircleTextNormal: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  stepCircleTextTiming: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  stepText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  stepMeta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
});
