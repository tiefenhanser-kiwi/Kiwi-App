import React, { useState } from "react";
import { View } from "react-native";

import { Chip } from "@/components/Chip";
import { CUISINES_TIER_1, CUISINES_TIER_2 } from "@/lib/domain";
import { KSpacing } from "@/constants/tokens";

import { ExpandLink, pickerStyles, toggleInArray } from "./shared";

export interface CuisinePickerProps {
  value: string[];
  onChange: (next: string[]) => void;
}

export function CuisinePicker({ value, onChange }: CuisinePickerProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View>
      <View style={pickerStyles.chipRow}>
        {CUISINES_TIER_1.map((c) => (
          <Chip
            key={c}
            label={c}
            selected={value.includes(c)}
            onPress={() => onChange(toggleInArray(value, c))}
          />
        ))}
      </View>
      <ExpandLink
        expanded={expanded}
        label="More cuisines"
        onPress={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <View style={[pickerStyles.chipRow, { marginTop: KSpacing.sm }]}>
          {CUISINES_TIER_2.map((c) => (
            <Chip
              key={c}
              label={c}
              selected={value.includes(c)}
              onPress={() => onChange(toggleInArray(value, c))}
            />
          ))}
        </View>
      )}
    </View>
  );
}
