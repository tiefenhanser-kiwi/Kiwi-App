import React from "react";
import { View } from "react-native";

import { Chip } from "@/components/Chip";
import { COOKING_SKILL_LEVELS } from "@/lib/domain";

import { pickerStyles } from "./shared";

export type SkillValue = (typeof COOKING_SKILL_LEVELS)[number];

export interface SkillLevelPickerProps {
  value: SkillValue;
  onChange: (next: SkillValue) => void;
}

export function SkillLevelPicker({ value, onChange }: SkillLevelPickerProps) {
  return (
    <View style={pickerStyles.chipRow}>
      {COOKING_SKILL_LEVELS.map((skill) => (
        <Chip
          key={skill}
          label={skill}
          selected={value === skill}
          onPress={() => onChange(skill)}
        />
      ))}
    </View>
  );
}
