import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

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
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    alignItems: "flex-start",
    gap: 6,
    minHeight: 100,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: KColors.sage[50],
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 2,
  },
  label: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  sub: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
});
