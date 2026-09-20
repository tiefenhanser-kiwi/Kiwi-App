import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";

import { Typography } from "@/constants/tokens";

// Row 8 Block 2 — the Instacart CTA. THIS IS A COMPLIANCE ARTIFACT, NOT A
// DESIGN DECISION: every number and colour below is Instacart's own CTA-design
// page (read September 19, 2026), Dark theme, verbatim. The production-key
// review checks it. It is deliberately NOT a `Button` variant — Button's height
// is padding-derived and its label colour is reachable only through VARIANTS
// (components/Button.tsx L14-18), and neither can be pinned to an external
// spec without contorting the shared primitive.
//
//   height 46 · logo 22 · padding horizontal 18 · round (pill)
//   Dark theme: background #003D29 · label #FAF1E5 · logo #FF7009 / #0AAD0A
//   text: exactly "Shop on Instacart" (or "Shop ingredients"; nothing else)
//
// The spec also lists paddingVertical 16. With a FIXED 46 px height and a
// 22 px logo, 16 px on each side cannot fit (16 + 22 + 16 = 54), so the
// height wins and the row centres its content — the numbers the review
// measures are the height and the logo, not the vertical inset.
//
// Pill: borderRadius 23 = half the 46 px height, which is what "round" means
// for a fixed-height button. (The July scope doc's 29.5 also renders as a
// pill on a 46 px box — any radius ≥ 23 does — but 23 is the one that stays
// exactly a pill if the height ever changes, and it is what a reviewer with
// a ruler expects.)
//
// The logo is the OFFICIAL asset Hans supplies from the Instacart developer
// portal at assets/instacart/instacart-logo.svg — it is never drawn, traced
// or approximated here (trademark). expo-image renders SVG natively, so no
// transformer and no new dependency. The require() is static: if the file is
// absent the Metro bundle fails to resolve it (loud, at build time), and
// components/__tests__/InstacartButton.test.ts pins that the required path
// exists in the repo. Until the official file lands, the path holds a valid
// EMPTY svg (a blank 22 px slot — never a substitute mark).
//
// Light and White theme values were not captured and are NOT guessed; only
// the Dark theme exists here.
//
// No Kiwi mark beside it, no "powered by", no wrapper implying a joint
// offering. The optional external-link icon is omitted.

export const INSTACART_CTA_LABEL = "Shop on Instacart";

export const INSTACART_CTA = {
  height: 46,
  logo: 22,
  paddingHorizontal: 18,
  radius: 23,
  background: "#003D29",
  label: "#FAF1E5",
} as const;

interface Props {
  onPress?: () => void;
  disabled?: boolean;
  /** The link call measured 439–925 ms; the label yields to a spinner. */
  loading?: boolean;
  testID?: string;
}

export function InstacartButton({ onPress, disabled, loading, testID }: Props) {
  const inert = disabled || loading;
  return (
    <Pressable
      onPress={inert ? undefined : onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={INSTACART_CTA_LABEL}
      accessibilityState={{ disabled: !!inert, busy: !!loading }}
      testID={testID}
      style={({ pressed }) => [
        s.button,
        disabled && s.disabled,
        pressed && !inert && s.pressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={INSTACART_CTA.label} />
      ) : (
        <View style={s.content}>
          <Image
            source={require("../assets/instacart/instacart-logo.svg")}
            style={s.logo}
            contentFit="contain"
            accessible={false}
          />
          <Text style={s.label} numberOfLines={1}>
            {INSTACART_CTA_LABEL}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  button: {
    height: INSTACART_CTA.height,
    // Width is "dynamic based on text": the pill hugs its content and the
    // caller's row decides where it sits.
    alignSelf: "flex-start",
    paddingHorizontal: INSTACART_CTA.paddingHorizontal,
    borderRadius: INSTACART_CTA.radius,
    backgroundColor: INSTACART_CTA.background,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  logo: {
    width: INSTACART_CTA.logo,
    height: INSTACART_CTA.logo,
  },
  label: {
    fontFamily: Typography.face.sans[600],
    fontSize: 16,
    color: INSTACART_CTA.label,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.85,
  },
});
