import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";

import { Palette, Radius, Spacing, Typography } from "@/constants/tokens";

interface Props {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}

export function Chip({ label, selected, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: selected
            ? Palette.chip.selected.background
            : Palette.chip.default.background,
          borderColor: selected
            ? Palette.chip.selected.border
            : Palette.chip.default.border,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.label,
          {
            color: selected
              ? Palette.chip.selected.text
              : Palette.chip.default.text,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  label: {
    fontSize: Typography.fontSize.sm,
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
});
