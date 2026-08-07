// WS7-8 #1 — the Home Hero card, extracted from app/(tabs)/index.tsx so the
// three-branch routing contract is render-testable in node:test (the same
// presentational seam CookNowCtaCard / PlanDiscoveryCard already use). Pure:
// takes a derived HeroModel + branch-specific navigation callbacks and renders.
//
// Routing contract (#1): the TODAY branch opens Meal Detail with full plan-item
// context (planId + planItemId), while the ACTIVE-PLAN branch opens Plan Detail.
// The two must stay distinct — onPressToday vs onPressPlan — so a today card
// never lands on the plan and vice-versa.

import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { DisplayTitle } from "@/components/DisplayTitle";
import { formatMacro } from "@/lib/format/macros";
import type { HeroModel } from "@/lib/home/heroState";
import {
  Colors,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";

export type HeroCardProps = {
  model: HeroModel;
  onPressPlan: (planId: string) => void;
  /** Today branch only → Meal Detail with full plan-item context (#1). The
   *  active-plan branch stays on onPressPlan → Plan Detail. */
  onPressToday: (planId: string, planItemId: string, mealId: string) => void;
  onPressEmpty: () => void;
};

export function HeroCard({
  model,
  onPressPlan,
  onPressToday,
  onPressEmpty,
}: HeroCardProps) {
  if (model.kind === "today") {
    const { meal } = model;
    // MealListItem (GET /home embed) carries minutes + calories; the
    // list shape has no per-meal difficulty, so the meta line is shorter
    // than the WS5 stub's "min · cal · difficulty".
    const metaParts: string[] = [];
    if (meal.minutes) metaParts.push(`${meal.minutes} min`);
    if (meal.calories) metaParts.push(`${formatMacro(meal.calories, "0")} cal`);
    return (
      <Pressable
        onPress={() => onPressToday(model.planId, model.planItemId, meal.id)}
        style={({ pressed }) => [styles.heroCard, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.heroThumbWrap}>
          {meal.image ? (
            <Image
              source={{ uri: meal.image }}
              style={styles.heroThumbImage}
            />
          ) : (
            <View style={[styles.heroThumbImage, styles.heroThumbPlaceholder]} />
          )}
        </View>
        <View style={styles.heroTextCol}>
          <Text style={styles.heroEyebrow}>tonight</Text>
          <DisplayTitle source={meal} variant="row" style={styles.heroTitle} />
          {metaParts.length > 0 && (
            <Text style={styles.heroMeta} numberOfLines={1}>
              {metaParts.join(" · ")}
            </Text>
          )}
        </View>
      </Pressable>
    );
  }

  if (model.kind === "plan") {
    const metaParts: string[] = [];
    if (model.durationDays) metaParts.push(`${model.durationDays} days`);
    return (
      <Pressable
        onPress={() => onPressPlan(model.planId)}
        style={({ pressed }) => [styles.heroCard, pressed && { opacity: 0.85 }]}
      >
        <View style={styles.heroThumbWrap}>
          <View style={[styles.heroThumbImage, styles.heroThumbPlaceholder]} />
        </View>
        <View style={styles.heroTextCol}>
          <Text style={styles.heroEyebrow}>this week</Text>
          <DisplayTitle source={model} variant="row" style={styles.heroTitle} />
          {metaParts.length > 0 && (
            <Text style={styles.heroMeta} numberOfLines={1}>
              {metaParts.join(" · ")}
            </Text>
          )}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPressEmpty}
      style={({ pressed }) => [styles.heroCard, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.heroThumbWrap}>
        <View style={[styles.heroThumbImage, styles.heroThumbEmptyPlaceholder]} />
      </View>
      <View style={styles.heroTextCol}>
        <Text style={styles.heroEmptyTitle}>
          No meals or plans for this week yet
        </Text>
        <Text style={styles.heroEmptyCta}>Create one to get started →</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  heroCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Radius.lg,
    padding: Spacing[3],
    minHeight: 100,
  },
  heroThumbWrap: {
    width: 80,
    height: 80,
    borderRadius: Radius.md,
    overflow: "hidden",
    backgroundColor: Colors.sage[100],
  },
  heroThumbImage: {
    width: 80,
    height: 80,
  },
  heroThumbPlaceholder: {
    backgroundColor: Colors.sage[200],
  },
  heroThumbEmptyPlaceholder: {
    backgroundColor: Colors.sage[100],
  },
  heroTextCol: {
    flex: 1,
    justifyContent: "center",
    gap: 2,
  },
  heroEyebrow: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontStyle: "italic",
    fontFamily: Typography.face.serifItalic[400],
  },
  heroTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  heroMeta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  heroEmptyTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
  heroEmptyCta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[400],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    marginTop: 4,
  },
});
