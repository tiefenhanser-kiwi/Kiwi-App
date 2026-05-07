import React from "react";
import { View } from "react-native";

import { Chip } from "@/components/Chip";
import { COOKING_EQUIPMENT } from "@/lib/domain";

import { pickerStyles, toggleInArray } from "./shared";

export interface EquipmentPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
}

export function EquipmentPicker({ value, onChange }: EquipmentPickerProps) {
  return (
    <View style={pickerStyles.chipRow}>
      {COOKING_EQUIPMENT.map((eq) => (
        <Chip
          key={eq}
          label={eq}
          selected={value.includes(eq)}
          onPress={() => onChange(toggleInArray(value, eq))}
        />
      ))}
    </View>
  );
}
