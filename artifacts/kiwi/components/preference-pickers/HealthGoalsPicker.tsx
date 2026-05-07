import React from "react";
import { View } from "react-native";

import { Chip } from "@/components/Chip";
import { HEALTH_GOALS } from "@/lib/domain";

import { pickerStyles, toggleInArray } from "./shared";

export interface HealthGoalsPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
}

export function HealthGoalsPicker({ value, onChange }: HealthGoalsPickerProps) {
  return (
    <View style={pickerStyles.chipRow}>
      {HEALTH_GOALS.map((g) => (
        <Chip
          key={g}
          label={g}
          selected={value.includes(g)}
          onPress={() => onChange(toggleInArray(value, g))}
        />
      ))}
    </View>
  );
}
