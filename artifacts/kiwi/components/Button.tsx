import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";

import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

type Variant = "primary" | "secondary" | "terra" | "ghost";

interface Props {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  style?: ViewStyle;
  iconLeft?: React.ReactNode;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  loading,
  fullWidth = true,
  style,
  iconLeft,
  testID,
}: Props) {
  const palette = VARIANTS[variant];

  return (
    <Pressable
      testID={testID}
      onPress={() => {
        if (disabled || loading) return;
        Haptics.selectionAsync().catch(() => {});
        onPress?.();
      }}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          borderWidth: palette.border ? 1 : 0,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
          alignSelf: fullWidth ? "stretch" : "flex-start",
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.text} />
      ) : (
        <View style={styles.row}>
          {iconLeft}
          <Text style={[styles.text, { color: palette.text }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

const VARIANTS: Record<
  Variant,
  { bg: string; text: string; border?: string }
> = {
  primary: { bg: KColors.sage[700], text: KColors.neutral[100] },
  secondary: {
    bg: KColors.neutral[100],
    text: KColors.sage[700],
    border: KColors.sage[300],
  },
  terra: { bg: KColors.terracotta[400], text: "#ffffff" },
  ghost: {
    bg: KColors.neutral[0],
    text: KColors.sage[700],
    border: KColors.neutral[400],
  },
};

const styles = StyleSheet.create({
  base: {
    paddingVertical: 14,
    paddingHorizontal: KSpacing.lg,
    borderRadius: KRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  text: {
    fontSize: KType.size.lg,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
});
