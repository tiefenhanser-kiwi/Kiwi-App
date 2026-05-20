import React from "react";
import { View } from "react-native";

import { Chip } from "@/components/Chip";
import { SPICE_TOLERANCE_LABELS, SPICE_TOLERANCE_OPTIONS } from "@/lib/domain";

import { pickerStyles } from "./shared";

export type SpiceValue = (typeof SPICE_TOLERANCE_OPTIONS)[number];

export interface SpicePickerProps {
  value: SpiceValue;
  onChange: (next: SpiceValue) => void;
}

export function SpicePicker({ value, onChange }: SpicePickerProps) {
  return (
    <View style={pickerStyles.chipRow}>
      {SPICE_TOLERANCE_OPTIONS.map((tol) => (
        <Chip
          key={tol}
          label={SPICE_TOLERANCE_LABELS[tol]}
          selected={value === tol}
          onPress={() => onChange(tol)}
        />
      ))}
    </View>
  );
}
