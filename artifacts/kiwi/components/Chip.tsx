import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";

import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

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
            ? KColors.sage[700]
            : KColors.neutral[100],
          borderColor: selected ? KColors.sage[700] : KColors.neutral[400],
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.label,
          {
            color: selected ? KColors.neutral[100] : KColors.sage[600],
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
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    borderRadius: KRadius.pill,
    borderWidth: 1,
  },
  label: {
    fontSize: KType.size.sm,
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
});
