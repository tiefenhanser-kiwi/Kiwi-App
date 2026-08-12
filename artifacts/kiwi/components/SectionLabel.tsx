// WS9 L2b — SectionLabel (net-new, §3 · Components.sectionLabel).
// The section eyebrow, e.g. "what do you want to eat?". Serif italic.
//
// WS9-2 2c Commit 4 — RESTYLED. Was: centered, muted (neutral[600]), and
// wrapped in literal em-dashes ("— label —", mockup .eyebrow). Now:
// left-aligned, high-emphasis (neutral[800]), undecorated.
//
// ⚠️ THIS PRIMITIVE IS SHARED — 11 renders across 5 files, only 3 of them on
// Home (the other 8 are dish detail, meal detail, and meal-builder). A
// "Home-only" variant was considered and rejected: it would have needed a new
// prop, and a second heading treatment is the last thing this codebase needs —
// it already carries ~30 parallel local `subSectionLabel` styles that were
// never converted. 2c edits the shared primitive and accepts the 8 off-Home
// reflows. Device-test all 11, not just Home's three.
//
// Type-scale note (FLAG 1): the mockup authors this at 14px, which maps to
// Typography.fontSize.base — but the app renders on the token scale, not the
// mockup's raw px (FLAG 1 preserved the app's live sizes over v4's smaller
// scale). Mockup = composition authority; tokens = value authority.
//
// Font-family note (FLAG 3): Components.sectionLabel.fontFamily is the plain
// serif family; we render via the per-weight italic FACE so Android actually
// italicizes.

import React from "react";
import { StyleSheet, Text, TextStyle } from "react-native";

import { Components, Spacing, Typography } from "@/constants/tokens";

type Props = {
  label: string;
  /** Cook-context tint (terracotta) instead of the default — Components.sectionLabel.cookColor. */
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
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: {
    fontFamily: Typography.face.serifItalic[400],
    fontStyle: Components.sectionLabel.fontStyle,
    fontSize: Typography.fontSize.base,
    color: Components.sectionLabel.color,
    textAlign: "left",
    // ⚠️ SINGLE OWNER of the inter-section gap (WS9-2 2c Commit 4, §4.3).
    // Every section below the lead opens with a SectionLabel, so this margin
    // and the lead blocks' own marginBottom were BOTH contributing: 12 + 16 =
    // 28px of dead space mid-screen, which is the measured problem 4.3 names.
    // The block wrappers in app/(tabs)/index.tsx now contribute 0 and this owns
    // the gap outright. Do not re-add a marginBottom to those wrappers.
    marginTop: Spacing[4],
    marginBottom: 10,
    // marginHorizontal dropped with the centering — a left-aligned eyebrow
    // must sit flush with the cards below it, not inset by 2px.
  },
  first: {
    // mockup .eyebrow.first { margin-top: 4px } = Spacing[1]
    marginTop: Spacing[1],
  },
});
