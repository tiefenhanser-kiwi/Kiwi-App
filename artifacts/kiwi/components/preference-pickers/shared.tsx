import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Spacing, Typography } from "@/constants/tokens";

export const pickerStyles = StyleSheet.create({
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  expandLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: Spacing[2],
    alignSelf: "flex-start",
  },
  expandLinkText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});

export function ExpandLink({
  expanded,
  label,
  onPress,
}: {
  expanded: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [pickerStyles.expandLink, pressed && { opacity: 0.6 }]}
    >
      <Text style={pickerStyles.expandLinkText}>{label}</Text>
      <Feather
        name={expanded ? "chevron-up" : "chevron-down"}
        size={14}
        color={Colors.sage[700]}
      />
    </Pressable>
  );
}

export function toggleInArray<T>(arr: readonly T[], item: T): T[] {
  return arr.includes(item) ? arr.filter((i) => i !== item) : [...arr, item];
}
