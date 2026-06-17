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

import { Palette, Radius, Spacing, Typography } from "@/constants/tokens";

type Variant = "primary" | "secondary" | "ghost";

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

// v4 (A1): primary CTA is now terracotta (was sage). The old `terra`
// variant — identical to the new primary — was removed; no callers used it.
const VARIANTS: Record<
  Variant,
  { bg: string; text: string; border?: string }
> = {
  primary: {
    bg: Palette.button.primary.background,
    text: Palette.button.primary.text,
  },
  secondary: {
    bg: Palette.button.secondary.background,
    text: Palette.button.secondary.text,
    border: Palette.button.secondary.border,
  },
  ghost: {
    bg: Palette.button.ghost.background,
    text: Palette.button.ghost.text,
    border: Palette.button.ghost.border,
  },
};

const styles = StyleSheet.create({
  base: {
    paddingVertical: 14,
    paddingHorizontal: Spacing[4],
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  text: {
    fontSize: Typography.fontSize.lg,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
