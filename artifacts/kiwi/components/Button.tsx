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

// WS9-2 2e Part 4 Item 2 — `tint` is net-new: a primary that carries terracotta
// as a pale surface + full-strength edge + dark ink instead of as a fill. It
// exists as a VARIANT rather than a per-screen override because Button derives
// its label colour from VARIANTS and `style` (a ViewStyle) cannot reach it —
// and because two surfaces need the identical cell (Plan Review's action panel
// and Home's ActivePlanStrip panel). §27.2: extend the primitive, do not
// hand-roll the same Pressable twice.
// WS9 D-WS9-215 (Sept 4) — `creamOnSage` is likewise a VARIANT and not a
// per-screen override, for the same reason `tint` is: the label has to go GREY,
// and Button derives its label colour from VARIANTS, which a ViewStyle `style`
// prop cannot reach. It is the quiet half of the two-CTA pair inside the
// Prep-the-Week lane. §27.2: extend the primitive, do not hand-roll the same
// Pressable a third time. (It REPLACES `outlineOnSage`, which shipped for one
// day and read as sage because a transparent fill over a sage lane IS sage —
// see the token note.)
type Variant = "primary" | "secondary" | "ghost" | "tint" | "creamOnSage";

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
  const variantPalette = VARIANTS[variant];
  const metrics = SIZES[size];

  // WS9 D-WS9-215 — a variant MAY carry a deliberate disabled treatment. When
  // it does, that treatment replaces the blanket `opacity: 0.5` dim below.
  //
  // ⚠️ WHY THE OPT-OUT IS PER-VARIANT AND NOT GLOBAL. The 0.5 dim is fine over
  // the app's paper background — it fades toward the page. It is NOT fine over
  // a coloured lane, where it composites the fill INTO the lane colour and
  // produces a third tone that belongs to neither (cream over sage[600] at 0.5
  // resolves to #ACB5A0). Only variants that define `disabled*` change
  // behaviour; every other button in the app flattens to byte-identical style.
  const isOff = !!(disabled || loading);
  const ownDisabled = isOff && variantPalette.disabledBg !== undefined;
  const palette = ownDisabled
    ? {
        ...variantPalette,
        bg: variantPalette.disabledBg!,
        text: variantPalette.disabledText ?? variantPalette.text,
        border: variantPalette.disabledBorder ?? variantPalette.border,
      }
    : variantPalette;

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
          // A variant with its own disabled palette has already expressed
          // "off" in colour; dimming on top would re-composite it.
          opacity: disabled && !ownDisabled ? 0.5 : pressed ? 0.85 : 1,
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
  {
    bg: string;
    text: string;
    border?: string;
    /** Optional deliberate disabled treatment. Presence also suppresses the
     *  blanket opacity dim — see the note at the top of the component. */
    disabledBg?: string;
    disabledText?: string;
    disabledBorder?: string;
  }
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
  tint: {
    bg: Palette.button.tint.background,
    text: Palette.button.tint.text,
    border: Palette.button.tint.border,
  },
  creamOnSage: {
    bg: Palette.button.creamOnSage.background,
    text: Palette.button.creamOnSage.text,
    // No border: a cream fill on a sage lane IS its own boundary. (The
    // terracotta primary needs its white ring only because its fill separates
    // from that sage by 1.1033:1.)
    disabledBg: Palette.button.creamOnSage.disabledBackground,
    disabledText: Palette.button.creamOnSage.disabledText,
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
