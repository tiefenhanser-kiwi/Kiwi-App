import React, { useState } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

import { Chip } from "@/components/Chip";
import { ALLERGIES_AND_AVOIDANCES } from "@/lib/domain";
import { Spacing } from "@/constants/tokens";

import { ExpandLink, pickerStyles, toggleInArray } from "./shared";

export interface AllergiesPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** WS9 BUG-196 — the section spacing that used to live on the deleted
   *  <SubLabel> above this picker. */
  style?: StyleProp<ViewStyle>;
}

export function AllergiesPicker({ value, onChange, style }: AllergiesPickerProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={style}>
      {/* WS9 BUG-196 — the expander carries the REAL label. It used to read
          "More" under a separate <SubLabel>Allergies & avoidances</SubLabel> in
          preferences.tsx: the label and the control that opened the content were
          two different elements, so the section read as a stray heading followed
          by an unexplained "More ⌄". The SubLabel is deleted; this is now the
          section.
          ⚠️ NOT a shared pattern, checked before changing it. CuisinePicker's
          "More cuisines" is a genuine OVERFLOW affordance — tier-1 chips render
          above it and it reveals tier-2. This picker renders NOTHING above the
          link, so it was never an overflow control; it is the section's
          disclosure control, and it was simply mislabelled. CuisinePicker is
          deliberately left alone. */}
      <ExpandLink
        expanded={expanded}
        label="Allergies & avoidances"
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
