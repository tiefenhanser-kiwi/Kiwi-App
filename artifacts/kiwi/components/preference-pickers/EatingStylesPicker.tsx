import React from "react";
import { View } from "react-native";

import { Chip } from "@/components/Chip";
import { EATING_STYLES } from "@/lib/domain";

import { pickerStyles, toggleInArray } from "./shared";

export interface EatingStylesPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
}

export function EatingStylesPicker({ value, onChange }: EatingStylesPickerProps) {
  return (
    <View style={pickerStyles.chipRow}>
      {EATING_STYLES.map((e) => (
        <Chip
          key={e}
          label={e}
          selected={value.includes(e)}
          onPress={() => onChange(toggleInArray(value, e))}
        />
      ))}
    </View>
  );
}
