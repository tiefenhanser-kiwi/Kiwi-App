// WS9 Block 3a — the first-run teaching arc. Surfaces the five-capability
// sequence and collapses PERMANENTLY once the user commits their first plan
// (Home gates it on firstPlanCreatedAt / D-WS9-026; this component is pure
// presentation).
//
// Mockup .arc: card + italic dash label "— kitchen made easy —" + the flow row
// + a sub-line. The label reuses SectionLabel (the dash treatment is identical);
// the flow row is arc-specific and inline here. Type-scale on the token scale
// per FLAG 1 (role, not raw px).

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { SectionLabel } from "./SectionLabel";
import {
  Colors,
  Components,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";

// WS9-2 2e (D-WS9-160) — ORDER REVERSED: plans now leads.
//
// ⚠️ THIS DELIBERATELY REVERSES A PRIOR LOCK. This file previously documented
// `meals → plans → …` as "Option B, locked". The reversal is ruled: you get a
// PLAN first and the meals arrive inside it, so the old order described the
// product backwards to the exact user who has never seen it work.
//
// ⚠️ Index-aligned with Components.teachingArc.ramp — STEPS[i] is coloured by
// ramp[i]. Reordering here without reordering the ramp silently re-assigns
// colours; a test pins the lengths and the pairing.
export const STEPS = ["plans", "meals", "groceries", "prep", "cook"] as const;

export const ARC_SUBLINE = "One flow, start to finish. It begins below.";

export function TeachingArc() {
  return (
    <View style={styles.card}>
      <SectionLabel label="kitchen made easy" style={styles.label} />
      <View style={styles.flow}>
        {STEPS.map((word, i) => (
          <React.Fragment key={word}>
            {i > 0 ? <Text style={styles.arrow}>→</Text> : null}
            {/* WS9-2 2e (D-WS9-160) — every word now carries its own ramp stop.
                ⚠️ That DESTROYS the arc's previous emphasis mechanism, which was
                purely chromatic: four words sat at 14.30:1 and exactly one (the
                lit first word) at 4.73:1, and that 3× separation WAS the
                emphasis. With all five coloured, nothing is the odd one out.
                Emphasis is therefore re-established by WEIGHT — the first word
                is bold, the rest medium — which is a channel the ramp does not
                compete with. Do not "restore" a colour highlight on top. */}
            <Text
              style={[
                styles.word,
                { color: Components.teachingArc.ramp[i] },
                i === 0 && styles.wordLead,
              ]}
            >
              {word}
            </Text>
          </React.Fragment>
        ))}
      </View>
      {/* D-WS9-160 — the sub-line is PROMOTED. It was 11px at neutral[600],
          measuring 3.73:1 on this card — below AA, and the smallest thing on a
          card whose whole job is explaining the product to a first-run user.
          Now 14px at neutral[800] (the high-emphasis role SectionLabel uses):
          10.27:1. */}
      <Text style={styles.sub}>{ARC_SUBLINE}</Text>
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
  // ⚠️ WS9-2 2c Commit 4 — this override is the one flagged in §4.2: because it
  // sets BOTH margins, SectionLabel's own margin changes are INERT here. That
  // is intentional and stays — these values are tuned to the card's padding,
  // not to the scroll rhythm, so the arc must not inherit the scroll gap.
  //
  // Alignment IS overridden back to centered, explicitly. The primitive went
  // left-aligned for the scroll eyebrows, but this label sits inside a centered
  // card (centered flow row, centered sub-line); inheriting left would leave it
  // as the only off-axis element in the card. This is a per-surface composition
  // choice, which is exactly what the `style` prop is for — NOT a second
  // heading treatment (color, face, size and the dropped dashes all still come
  // from the primitive).
  label: {
    marginTop: 0,
    marginBottom: Spacing[2],
    textAlign: "center",
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
    // NOTE: no `color` here. Every word's colour comes from the ramp, applied
    // per-index at the call site — a default here would silently win for any
    // word whose ramp stop went missing, hiding the bug.
  },
  // The emphasis channel (see the call-site comment). Weight only — the lead
  // word's COLOUR is still just ramp[0].
  wordLead: {
    fontFamily: Typography.face.serif[700],
    fontWeight: Typography.fontWeight.bold,
  },
  arrow: {
    color: Colors.neutral[400],
    fontSize: Typography.fontSize.sm,
  },
  sub: {
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    textAlign: "center",
    marginTop: 9,
  },
});
