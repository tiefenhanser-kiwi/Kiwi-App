// WS9 Block 3a — AvatarChip (net-new). The circular initials chip in the Home
// header's top-right. After G7 drops Profile from the tab bar, THIS is the sole
// profile entry point (spec §5.1, OPEN-1) — so it must always be tappable.
//
// Presentational + dumb: initials + onPress come from the parent (HomeHeader
// computes initials from the auth user and owns the route). No data access here.

import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";

import { Colors, Palette, Radius, Typography } from "@/constants/tokens";

type Props = {
  initials: string;
  onPress: () => void;
  /** Accessibility label, e.g. "Open profile". */
  accessibilityLabel?: string;
};

export function AvatarChip({
  initials,
  onPress,
  accessibilityLabel = "Open profile",
}: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      style={({ pressed }) => [styles.chip, pressed && { opacity: 0.8 }]}
    >
      <Text style={styles.text} numberOfLines={1}>
        {initials}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.sage[600],
    borderWidth: 1,
    borderColor: Palette.border.default,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    color: Palette.text.onSage,
    fontSize: Typography.fontSize.sm,
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.sans[700],
    letterSpacing: 0.3,
  },
});
