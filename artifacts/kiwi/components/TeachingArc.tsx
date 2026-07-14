// WS9 Block 3a — the first-run teaching arc (net-new; Option B, locked). Surfaces
// the five-capability sequence — meals → plans → groceries → prep → cook — and
// collapses PERMANENTLY once the user commits their first plan (the Home screen
// gates it on firstPlanCreatedAt / D-WS9-026; this component is pure presentation).
//
// Mockup .arc: card + italic dash label "— kitchen made easy —" + the flow row
// (first word lit terracotta) + a sub-line. The label reuses SectionLabel (the
// dash treatment is identical); the flow row is arc-specific and inline here.
// Type-scale on the token scale per FLAG 1 (role, not raw px).

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { SectionLabel } from "./SectionLabel";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

// The five-capability flow; the first word is lit (terracotta) — the sequence
// "begins below" with the make lane.
const STEPS = ["meals", "plans", "groceries", "prep", "cook"] as const;

export function TeachingArc() {
  return (
    <View style={styles.card}>
      <SectionLabel label="kitchen made easy" style={styles.label} />
      <View style={styles.flow}>
        {STEPS.map((word, i) => (
          <React.Fragment key={word}>
            {i > 0 ? <Text style={styles.arrow}>→</Text> : null}
            <Text style={[styles.word, i === 0 && styles.wordLit]}>{word}</Text>
          </React.Fragment>
        ))}
      </View>
      <Text style={styles.sub}>One flow, start to finish. It begins below.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.background.card,
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Radius.xl,
    paddingHorizontal: 15,
    paddingTop: 13,
    paddingBottom: 12,
  },
  // Override SectionLabel's scroll-eyebrow margins for in-card use.
  label: {
    marginTop: 0,
    marginBottom: Spacing[2],
  },
  flow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  word: {
    fontFamily: Typography.face.serif[500],
    fontSize: Typography.fontSize.base,
    fontWeight: Typography.fontWeight.medium,
    color: Colors.neutral[900],
  },
  wordLit: {
    color: Colors.terracotta[400],
  },
  arrow: {
    color: Colors.neutral[400],
    fontSize: Typography.fontSize.sm,
  },
  sub: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    marginTop: 7,
  },
});
