// WS9 L2b — SectionLabel (net-new, §3 · Components.sectionLabel).
// The italic-dash eyebrow, e.g. "— what do you want to eat? —". The em-dashes
// are literal content (mockup .eyebrow). Serif italic, muted, centered.
//
// Type-scale note (FLAG 1): the mockup authors this at 14px, which maps to
// Typography.fontSize.base — but the app renders on the token scale, not the
// mockup's raw px (FLAG 1 preserved the app's live sizes over v4's smaller
// scale). Mockup = composition authority; tokens = value authority.
//
// Font-family note (FLAG 3): Components.sectionLabel.fontFamily is the plain
// serif family; we render via the per-weight italic FACE so Android actually
// italicizes (same pattern as HeroCard's eyebrow).

import React from "react";
import { StyleSheet, Text, TextStyle } from "react-native";

import { Components, Spacing, Typography } from "@/constants/tokens";

const DASH = Components.sectionLabel.dash;

type Props = {
  label: string;
  /** Cook-context tint (terracotta) instead of muted — Components.sectionLabel.cookColor. */
  cook?: boolean;
  /** Tighter top margin for the first label in a scroll (mockup .eyebrow.first). */
  first?: boolean;
  style?: TextStyle;
};

export function SectionLabel({ label, cook, first, style }: Props) {
  return (
    <Text
      style={[
        styles.label,
        cook && { color: Components.sectionLabel.cookColor },
        first && styles.first,
        style,
      ]}
    >
      {`${DASH} ${label} ${DASH}`}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: {
    fontFamily: Typography.face.serifItalic[400],
    fontStyle: Components.sectionLabel.fontStyle,
    fontSize: Typography.fontSize.base,
    color: Components.sectionLabel.color,
    textAlign: "center",
    marginTop: Spacing[4],
    marginHorizontal: 2,
    marginBottom: 10,
  },
  first: {
    // mockup .eyebrow.first { margin-top: 4px } = Spacing[1]
    marginTop: Spacing[1],
  },
});
