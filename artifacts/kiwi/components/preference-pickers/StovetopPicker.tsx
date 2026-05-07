import React from "react";
import { View } from "react-native";

import { Chip } from "@/components/Chip";
import { STOVETOP_TYPES } from "@/lib/domain";

import { pickerStyles } from "./shared";

export type StovetopValue = (typeof STOVETOP_TYPES)[number];

export interface StovetopPickerProps {
  value?: StovetopValue;
  onChange: (next: StovetopValue | undefined) => void;
}

export function StovetopPicker({ value, onChange }: StovetopPickerProps) {
  return (
    <View style={pickerStyles.chipRow}>
      {STOVETOP_TYPES.map((t) => (
        <Chip
          key={t}
          label={t}
          selected={value === t}
          onPress={() => onChange(value === t ? undefined : t)}
        />
      ))}
    </View>
  );
}
