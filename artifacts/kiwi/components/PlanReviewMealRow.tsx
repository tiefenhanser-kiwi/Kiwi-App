import React from "react";
import { Alert, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import {
  KColors,
  KCopy,
  KRadius,
  KShadow,
  KSpacing,
  KType,
} from "@/constants/tokens";
import { DAY_SHORT, type ReviewPlanMealRow } from "@/lib/types";

interface Props {
  row: ReviewPlanMealRow;
  planId: string;
}

export function PlanReviewMealRow({ row, planId }: Props) {
  const router = useRouter();

  const navigateToDetail = () => {
    router.push({
      pathname: "/meal/[id]",
      params: { id: row.mealId, planId, planItemId: row.planItemId },
    });
  };

  const onRowTap = () => {
    console.log("[meal-row] row tapped (→ Meal Detail)", {
      planItemId: row.planItemId,
      mealId: row.mealId,
    });
    navigateToDetail();
  };

  const onCookNow = () => {
    console.log("[meal-row] cook-now tapped", {
      planItemId: row.planItemId,
      mealId: row.mealId,
    });
    Alert.alert(
      "Coming with Prep & Cook Hub",
      "Cook Now lands when the Prep & Cook Hub workstream ships (post-WS6 AI orchestration). For now, view the meal details to see ingredients and steps.",
    );
  };

  // Macros line — only render when at least caloriesPerServing exists.
  // Missing individual macros render as 0 to keep the line shape consistent.
  const macrosLine =
    row.caloriesPerServing !== undefined
      ? `${row.caloriesPerServing} cal · ${row.proteinGPerServing ?? 0}g P · ${row.carbsGPerServing ?? 0}g C · ${row.fatGPerServing ?? 0}g F`
      : null;

  return (
    <View style={styles.card}>
      {/* Header row: title + Cook Now button.
          Title-tap also navigates to detail; Cook Now is its own action. */}
      <View style={styles.headerRow}>
        <Pressable
          onPress={onRowTap}
          style={({ pressed }) => [
            styles.titlePressable,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
            {row.title}
          </Text>
        </Pressable>
        <Pressable
          onPress={onCookNow}
          style={({ pressed }) => [
            styles.cookNowBtn,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.cookNowText}>Cook Now</Text>
        </Pressable>
      </View>

      {/* Body row: thumbnail + meta + macros. Tapping body also navigates. */}
      <Pressable
        onPress={onRowTap}
        style={({ pressed }) => [styles.bodyRow, pressed && { opacity: 0.85 }]}
      >
        {row.thumbnailUrl ? (
          <Image source={{ uri: row.thumbnailUrl }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]} />
        )}
        <View style={styles.textCol}>
          <Text style={styles.metaLine}>{row.metaLine}</Text>
          {macrosLine && <Text style={styles.macros}>{macrosLine}</Text>}
        </View>
      </Pressable>

      {/* Day strip — Sun-Sat, single tap assigns; tap of currently-assigned unassigns. */}
      <View style={styles.dayStrip}>
        {row.dayStrip.map((entry) => (
          <Pressable
            key={entry.day}
            onPress={() => {
              console.log("[meal-row] day-pill tapped", {
                planItemId: row.planItemId,
                day: entry.day,
              });
            }}
            hitSlop={6}
            style={({ pressed }) => [
              styles.dayPill,
              entry.isAssigned ? styles.dayPillOn : styles.dayPillOff,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={
                entry.isAssigned ? styles.dayPillTextOn : styles.dayPillTextOff
              }
            >
              {DAY_SHORT[entry.day]}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Action buttons — 5 inline actions per PRD §8.4.1 (5-action amendment). */}
      <View style={styles.actionRow}>
        <Pressable
          onPress={() => {
            console.log("[meal-row] view tapped", {
              planItemId: row.planItemId,
              mealId: row.mealId,
            });
            navigateToDetail();
          }}
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.actionText}>View</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            console.log("[meal-row] change-meal tapped", {
              planItemId: row.planItemId,
            });
          }}
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.actionText}>Change Meal</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            console.log("[meal-row] change-recipe tapped", {
              planItemId: row.planItemId,
            });
          }}
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.actionText}>Change Recipe</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            console.log("[meal-row] find-similar tapped", {
              planItemId: row.planItemId,
              mealId: row.mealId,
            });
          }}
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.actionText}>Find Similar</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            console.log("[meal-row] compost tapped", {
              planItemId: row.planItemId,
            });
          }}
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.actionText}>{KCopy.delete}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    padding: KSpacing.md,
    marginBottom: KSpacing.sm,
    ...KShadow.card,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  titlePressable: {
    flex: 1,
  },
  bodyRow: {
    flexDirection: "row",
    gap: KSpacing.md,
    alignItems: "center",
    marginTop: KSpacing.sm,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: KRadius.md,
    backgroundColor: KColors.neutral[200],
  },
  thumbFallback: {
    backgroundColor: KColors.sage[100],
  },
  textCol: {
    flex: 1,
    gap: KSpacing.xs,
  },
  title: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  metaLine: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  macros: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  cookNowBtn: {
    backgroundColor: KColors.sage[700],
    paddingHorizontal: KSpacing.sm,
    paddingVertical: KSpacing.xs,
    borderRadius: KRadius.md,
  },
  cookNowText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  dayStrip: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: KSpacing.sm,
  },
  dayPill: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  dayPillOn: {
    backgroundColor: KColors.sage[700],
  },
  dayPillOff: {
    backgroundColor: KColors.neutral[100],
  },
  dayPillTextOn: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  dayPillTextOff: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: KSpacing.xs,
    marginTop: KSpacing.sm,
  },
  actionBtn: {
    paddingHorizontal: KSpacing.sm,
    paddingVertical: KSpacing.xs,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    backgroundColor: KColors.neutral[0],
  },
  actionText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[800],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
});
