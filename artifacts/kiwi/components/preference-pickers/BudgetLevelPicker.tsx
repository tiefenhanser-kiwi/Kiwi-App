import React from "react";
import { View } from "react-native";

import { Chip } from "@/components/Chip";
import { BUDGET_LEVEL_LABELS, BUDGET_LEVELS } from "@/lib/domain";

import { pickerStyles } from "./shared";

export type BudgetValue = (typeof BUDGET_LEVELS)[number];

export interface BudgetLevelPickerProps {
  value: BudgetValue;
  onChange: (next: BudgetValue) => void;
}

export function BudgetLevelPicker({ value, onChange }: BudgetLevelPickerProps) {
  return (
    <View style={pickerStyles.chipRow}>
      {BUDGET_LEVELS.map((b) => (
        <Chip
          key={b}
          label={BUDGET_LEVEL_LABELS[b]}
          selected={value === b}
          onPress={() => onChange(b)}
        />
      ))}
    </View>
  );
}
