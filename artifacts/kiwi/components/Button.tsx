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

// WS9-2 2e (D-WS9-157) — size scale. The plan-review action panel needs one
// cell (Compost) rendered visually SMALLER than its four peers, and the ruling
// is explicit that this extends the shared primitive rather than hand-rolling a
// per-screen Pressable — a per-surface re-implementation is the failure that
// forced a rebuild in an earlier block.
//
// ⚠️ `md` REPRODUCES TODAY'S VALUES EXACTLY (paddingVertical 14 /
// paddingHorizontal Spacing[4] / fontSize.lg). It is the default, so every
// pre-2e consumer flattens to the identical style it had before this prop
// existed. Do not "tidy" these numbers onto the token scale — that would move
// pixels on ~every button in the app under cover of a refactor.
type Size = "md" | "sm";

interface Props {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  /** Visual weight. `md` (default) is the app-wide button; `sm` is the quieter
   *  peer used where a cell must read as subordinate to its neighbours. */
  size?: Size;
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
  size = "md",
  disabled,
  loading,
  fullWidth = true,
  style,
  iconLeft,
  testID,
}: Props) {
  const palette = VARIANTS[variant];
  const metrics = SIZES[size];

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
          paddingVertical: metrics.paddingVertical,
          paddingHorizontal: metrics.paddingHorizontal,
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
          <Text
            style={[styles.text, { fontSize: metrics.fontSize, color: palette.text }]}
          >
            {label}
          </Text>
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

// Only the metrics that differ by size live here; everything else (radius,
// weight, face, alignment) is shared, so a small button is unmistakably the
// same object at a lower volume rather than a second button design.
const SIZES: Record<
  Size,
  { paddingVertical: number; paddingHorizontal: number; fontSize: number }
> = {
  md: {
    paddingVertical: 14,
    paddingHorizontal: Spacing[4],
    fontSize: Typography.fontSize.lg,
  },
  sm: {
    paddingVertical: 9,
    paddingHorizontal: Spacing[3],
    fontSize: Typography.fontSize.base,
  },
};

const styles = StyleSheet.create({
  // paddingVertical / paddingHorizontal moved to SIZES (applied inline above);
  // the flattened result for the default `md` is byte-identical to the values
  // that used to sit here.
  base: {
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  // fontSize likewise moved to SIZES.
  text: {
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
