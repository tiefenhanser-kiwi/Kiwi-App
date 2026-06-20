import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import {
  Colors,
  Copy,
  Palette,
  Radius,
  Shadow,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { formatMacroLine } from "@/lib/format/macros";
import {
  DAY_SHORT,
  type DayOfWeek,
  type ReviewPlanMealRow,
} from "@/lib/types";

interface Props {
  row: ReviewPlanMealRow;
  planId: string;
  /** Fired when the row's "Change Meal" action button is tapped — the
   *  parent screen owns the sheet + optimistic update (PRD §8.4.2). */
  onChangeMeal?: (planItemId: string, currentMealId: string) => void;
  /** Fired when the row's "Find Similar" action is tapped — parent
   *  screen owns the sheet + optimistic update (PRD §8.4.x WS5 amend.). */
  onFindSimilar?: (
    planItemId: string,
    sourceMealId: string,
    title: string,
  ) => void;
  /** Fired when a day pill is tapped (PRD §8.3.6). null = unassign. */
  onAssignDay?: (planItemId: string, day: DayOfWeek | null) => void;
  /** Fired when the row's "Compost" action is tapped — parent owns
   *  the confirmation alert + optimistic remove (PRD §8.4.5). */
  onCompost?: (planItemId: string, title: string) => void;
}

export function PlanReviewMealRow({
  row,
  planId,
  onChangeMeal,
  onFindSimilar,
  onAssignDay,
  onCompost,
}: Props) {
  const router = useRouter();

  const navigateToDetail = () => {
    router.push({
      pathname: "/meal/[id]",
      params: {
        id: row.mealId,
        planId,
        planItemId: row.planItemId,
        // WS7-7-A B5 — seed the servings stepper from the plan's override so it
        // shows the plan's value (not the meal default) on open.
        ...(row.servingsOverride != null
          ? { servingsOverride: String(row.servingsOverride) }
          : {}),
      },
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
    // WS7-8b B3 — Cook Mode launch WITH plan context: planId + planItemId let
    // the cook screen read this item's isPrepped (via usePlan) and drive the
    // prep gate without asking the user.
    router.push({
      pathname: "/cook-session",
      params: { mealId: row.mealId, planId, planItemId: row.planItemId },
    });
  };

  // Macros line — only render when at least caloriesPerServing exists.
  // Missing individual macros render as 0 to keep the line shape consistent.
  const macrosLine =
    row.caloriesPerServing !== undefined
      ? formatMacroLine(
          row.caloriesPerServing,
          row.proteinGPerServing,
          row.carbsGPerServing,
          row.fatGPerServing,
        )
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
              const currentlyAssigned = row.dayStrip.find((d) => d.isAssigned);
              const next: DayOfWeek | null =
                currentlyAssigned?.day === entry.day ? null : entry.day;
              onAssignDay?.(row.planItemId, next);
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
            onChangeMeal?.(row.planItemId, row.mealId);
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
            router.push({
              pathname: "/meal-builder",
              params: {
                mealId: row.mealId,
                planId,
                planItemId: row.planItemId,
                source: "change-recipe",
              },
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
            onFindSimilar?.(row.planItemId, row.mealId, row.title);
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
            onCompost?.(row.planItemId, row.title);
          }}
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.actionText}>{Copy.delete}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    padding: Spacing[3],
    marginBottom: Spacing[2],
    ...Shadow.card,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  titlePressable: {
    flex: 1,
  },
  bodyRow: {
    flexDirection: "row",
    gap: Spacing[3],
    alignItems: "center",
    marginTop: Spacing[2],
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: Radius.md,
    backgroundColor: Colors.neutral[200],
  },
  thumbFallback: {
    backgroundColor: Colors.sage[100],
  },
  textCol: {
    flex: 1,
    gap: Spacing[1],
  },
  title: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  metaLine: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  macros: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  cookNowBtn: {
    backgroundColor: Colors.sage[700],
    paddingHorizontal: Spacing[2],
    paddingVertical: Spacing[1],
    borderRadius: Radius.md,
  },
  cookNowText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  dayStrip: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: Spacing[2],
  },
  dayPill: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  dayPillOn: {
    backgroundColor: Colors.sage[700],
  },
  dayPillOff: {
    backgroundColor: Colors.neutral[100],
  },
  dayPillTextOn: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  dayPillTextOff: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing[1],
    marginTop: Spacing[2],
  },
  actionBtn: {
    paddingHorizontal: Spacing[2],
    paddingVertical: Spacing[1],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    backgroundColor: Palette.background.card,
  },
  actionText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
});
