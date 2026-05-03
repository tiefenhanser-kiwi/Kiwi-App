import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

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
}

export function PlanReviewMealRow({ row }: Props) {
  const onRowTap = () => {
    console.log("[meal-row] row tapped (→ Meal Detail)", {
      planItemId: row.planItemId,
      mealId: row.mealId,
    });
  };

  return (
    <View style={styles.card}>
      {/* Top section: thumbnail + text column.
          Wrapping only this region in the Pressable keeps day-pill and
          action-button taps from bubbling up to the row-tap handler. */}
      <Pressable
        onPress={onRowTap}
        style={({ pressed }) => [styles.topRow, pressed && { opacity: 0.85 }]}
      >
        {row.thumbnailUrl ? (
          <Image source={{ uri: row.thumbnailUrl }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]} />
        )}
        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
            {row.title}
          </Text>
          <Text style={styles.metaLine}>{row.metaLine}</Text>
          {row.caloriesPerServing !== undefined && (
            <Text style={styles.calories}>
              {row.caloriesPerServing} cal/serving
            </Text>
          )}
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
  topRow: {
    flexDirection: "row",
    gap: KSpacing.md,
    alignItems: "center",
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
  calories: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
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
