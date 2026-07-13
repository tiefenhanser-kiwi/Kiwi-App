import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

type Props = {
  icon: React.ReactNode;
  label: string;
  subLabel: string;
  onPress: () => void;
};

export function HomeActionButton({ icon, label, subLabel, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.iconWrap}>{icon}</View>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.sub}>{subLabel}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flex: 1,
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    padding: Spacing[3],
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    alignItems: "flex-start",
    gap: 6,
    minHeight: 100,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: Radius.sm,
    backgroundColor: Colors.sage[50],
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 2,
  },
  label: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  sub: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
});
