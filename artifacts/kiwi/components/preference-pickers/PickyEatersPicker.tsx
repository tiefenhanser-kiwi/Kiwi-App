import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { Stepper } from "@/components/Stepper";
import { PICKY_AVOIDANCES } from "@/lib/domain";
import { Colors, Spacing, Typography } from "@/constants/tokens";

import { pickerStyles, toggleInArray } from "./shared";

const PICKY_HARD_MAX = 8;

export interface PickyEatersPickerProps {
  pickyCount: number;
  pickyAvoidances: string[];
  onPickyCountChange: (n: number) => void;
  onPickyAvoidancesChange: (next: string[]) => void;
  /** Optional cap on count from the parent (e.g., householdSize). */
  maxPicky?: number;
}

export function PickyEatersPicker({
  pickyCount,
  pickyAvoidances,
  onPickyCountChange,
  onPickyAvoidancesChange,
  maxPicky,
}: PickyEatersPickerProps) {
  const max = Math.min(PICKY_HARD_MAX, maxPicky ?? PICKY_HARD_MAX);

  // Per spec: when count = 0, avoidances cleared. Clear at the transition,
  // not in a useEffect — so data only resets on user action, never on a
  // re-render of an already-zero state.
  const handleCountChange = (n: number) => {
    const clamped = Math.min(n, max);
    onPickyCountChange(clamped);
    if (clamped === 0 && pickyAvoidances.length > 0) {
      onPickyAvoidancesChange([]);
    }
  };

  return (
    <View>
      <Stepper
        value={pickyCount}
        onChange={handleCountChange}
        min={0}
        max={max}
        suffix={pickyCount === 1 ? "person" : "people"}
      />
      {pickyCount > 0 && (
        <View style={{ marginTop: Spacing[3] }}>
          <Text style={s.subLabel}>What they avoid</Text>
          <View style={pickerStyles.chipRow}>
            {PICKY_AVOIDANCES.map((p) => (
              <Chip
                key={p}
                label={p}
                selected={pickyAvoidances.includes(p)}
                onPress={() =>
                  onPickyAvoidancesChange(toggleInArray(pickyAvoidances, p))
                }
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  subLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[2],
  },
});
