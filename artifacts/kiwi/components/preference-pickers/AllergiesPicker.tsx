import React, { useState } from "react";
import { View } from "react-native";

import { Chip } from "@/components/Chip";
import { ALLERGIES_AND_AVOIDANCES } from "@/lib/domain";
import { Spacing } from "@/constants/tokens";

import { ExpandLink, pickerStyles, toggleInArray } from "./shared";

export interface AllergiesPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
}

export function AllergiesPicker({ value, onChange }: AllergiesPickerProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View>
      <ExpandLink
        expanded={expanded}
        label="More"
        onPress={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <View style={[pickerStyles.chipRow, { marginTop: Spacing[2] }]}>
          {ALLERGIES_AND_AVOIDANCES.map((a) => (
            <Chip
              key={a}
              label={a}
              selected={value.includes(a)}
              onPress={() => onChange(toggleInArray(value, a))}
            />
          ))}
        </View>
      )}
    </View>
  );
}
