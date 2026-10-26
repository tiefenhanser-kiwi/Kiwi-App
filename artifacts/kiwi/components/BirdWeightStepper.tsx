// THX-4 (D-WS9-324) — "Turkey · [−] 14 lb [+]", beside the meal screen's
// servings stepper. A component, not inline JSX, for IngredientsSectionHeading's
// reason: app/** is outside the test glob (D-WS9-164), so the range, the step and
// the Reset would be unguardable on the screen. The screen owns the state and the
// one Save (lib/meals/birdWeight.ts has the rules); this only draws and reports.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { birdWeightLabel, canStepBird, type BirdWeightRange } from "@/lib/meals/birdWeight";

export const BIRD_WEIGHT_NOTE = "Roast time and thaw day follow the weight.";

export function BirdWeightStepper({
  value,
  range,
  onStep,
  onReset,
}: {
  /** The weight shown (lib/meals/birdWeight.ts shownBirdLb). */
  value: number;
  range: BirdWeightRange;
  onStep: (dir: 1 | -1) => void;
  /** Shown only when a weight is set: back to the default bird. */
  onReset?: () => void;
}) {
  const canDown = canStepBird(value, -1, range);
  const canUp = canStepBird(value, 1, range);
  return (
    <View style={s.wrap} testID="bird-weight">
      <View style={s.row}>
        <Text style={s.label}>Turkey</Text>
        <View style={s.stepperRow}>
          <Pressable
            testID="bird-weight-minus"
            accessibilityRole="button"
            accessibilityLabel="Lighter turkey"
            onPress={() => onStep(-1)}
            disabled={!canDown}
            hitSlop={6}
            style={({ pressed }) => [s.stepperBtn, !canDown && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}
          >
            <Feather name="minus" size={16} color={Colors.sage[700]} />
          </Pressable>
          <Text style={s.value} testID="bird-weight-value">
            {birdWeightLabel(value)}
          </Text>
          <Pressable
            testID="bird-weight-plus"
            accessibilityRole="button"
            accessibilityLabel="Heavier turkey"
            onPress={() => onStep(1)}
            disabled={!canUp}
            hitSlop={6}
            style={({ pressed }) => [s.stepperBtn, !canUp && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}
          >
            <Feather name="plus" size={16} color={Colors.sage[700]} />
          </Pressable>
        </View>
        {onReset && (
          <Pressable
            testID="bird-weight-reset"
            accessibilityRole="button"
            accessibilityLabel="Reset the turkey to the default weight"
            onPress={onReset}
            hitSlop={8}
          >
            <Text style={s.reset}>Reset</Text>
          </Pressable>
        )}
      </View>
      <Text style={s.note}>{BIRD_WEIGHT_NOTE}</Text>
    </View>
  );
}

// The servings stepper's own look (app/meal/[id].tsx servingsAdjuster/stepperRow).
const s = StyleSheet.create({
  wrap: {
    marginBottom: Spacing[3],
    gap: 4,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: Spacing[2],
  },
  label: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  stepperBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  value: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    minWidth: 48,
    textAlign: "center",
  },
  reset: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
    textDecorationLine: "underline",
  },
  note: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
});
