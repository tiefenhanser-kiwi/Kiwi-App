// WS9 Block 3a — the first-run teaching arc. Surfaces the five-capability
// sequence and collapses PERMANENTLY once the user commits their first plan
// (Home gates it on firstPlanCreatedAt / D-WS9-026; this component is pure
// presentation).
//
// Mockup .arc: card + italic dash label "— kitchen made easy —" + the flow row
// + a sub-line. The label reuses SectionLabel (the dash treatment is identical);
// the flow row is arc-specific and inline here. Type-scale on the token scale
// per FLAG 1 (role, not raw px).
//
// ⚠️ WS9-2 2e Part 4 Item 5 — TREATMENT A. Colour left the words entirely.
//
// 2e Part 2 painted each of the five words with its own ramp stop, which forced
// every stop to double as body-text ink and therefore to clear AA on white. That
// constraint is what produced the muddy interior (a monotonic 4.73 → 8.61 ramp
// through three net-new browns) — the palette was being chosen by a contrast
// floor rather than by how a progression should look.
//
// Now: labels and icons are NEUTRAL, and the colour lives in ONE continuous
// gradient rule beneath them, with a dot at each stop.
//
// ⚠️ A GRADIENT RULE IS NON-TEXT AND HAS NO CONTRAST FLOOR. That is the entire
// reason this treatment was chosen. The middle of the sweep is pale on purpose —
// sage[300] measures 1.89:1 on this card and that is CORRECT for a decorative
// rule. Do not "fix" it; darkening the middle re-imposes the exact constraint
// this design removed and puts the browns back.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

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
// ⚠️ Index-aligned with Components.teachingArc.ramp AND with STEP_ICONS —
// STEPS[i] is dotted by ramp[i] and iconed by STEP_ICONS[i]. Reordering one
// without the others silently re-pairs them; tests pin the lengths and both
// pairings.
export const STEPS = ["plans", "meals", "groceries", "prep", "cook"] as const;

/**
 * Part 4 Item 5 — one glyph per stop, index-aligned with STEPS.
 *
 * Chosen from Feather, which is the app's only icon set, and from the glyphs
 * the app already spends on these concepts: `list` and `shopping-cart` are the
 * grocery pair on both action panels, and `play` is what "Start Cooking" /
 * "Prep and Cook" already wear. `shopping-cart` goes to groceries (buying) so
 * `clipboard` can carry prep (a checklist of things to do before you cook).
 */
export const STEP_ICONS = [
  "calendar", // plans     — a plan is a week
  "book-open", // meals    — recipes
  "shopping-cart", // groceries
  "clipboard", // prep     — the checklist you work through
  "play", // cook          — the app's established start-cooking glyph
] as const satisfies readonly React.ComponentProps<typeof Feather>["name"][];

export const ARC_SUBLINE = "One flow, start to finish. It begins below.";

/**
 * Where each stop's colour lands along the rule, as a 0–1 fraction.
 *
 * ⚠️ DERIVED, NOT WRITTEN DOWN. Each stop occupies one of five equal flex:1
 * cells, so its CENTRE is at (2i+1)/2n — 0.1, 0.3, 0.5, 0.7, 0.9. Hardcoding
 * those numbers would silently mis-register every dot the moment a sixth step
 * is added; deriving them cannot.
 */
export function stopLocations(
  count: number,
): [number, number, ...number[]] {
  const at = (i: number) => (2 * i + 1) / (2 * count);
  // The tuple shape is LinearGradient's requirement (`locations` is typed
  // "at least two"), not a special case in the maths: every entry, including
  // the two named ones, comes from the same `at`.
  return [
    at(0),
    at(1),
    ...Array.from({ length: Math.max(0, count - 2) }, (_, k) => at(k + 2)),
  ];
}

export function TeachingArc() {
  const ramp = Components.teachingArc.ramp;
  const locations = stopLocations(STEPS.length);

  return (
    <View style={styles.card}>
      <SectionLabel label="kitchen made easy" style={styles.label} />

      {/* Icons above labels, one cell per stop. Equal flex:1 cells are what
          registers each label, each icon and each dot on the same centre line —
          the three rows are laid out identically on purpose. */}
      <View style={styles.flow}>
        {STEPS.map((word, i) => (
          <View key={word} style={styles.stop}>
            <Feather
              name={STEP_ICONS[i]}
              size={ICON_SIZE}
              color={Colors.neutral[600]}
              style={styles.icon}
            />
            {/* ⚠️ NO per-word colour. Emphasis on the lead word is WEIGHT and
                only weight — the channel the rule does not compete with. Do not
                reintroduce a colour highlight on top. */}
            <Text style={[styles.word, i === 0 && styles.wordLead]}>{word}</Text>
          </View>
        ))}
      </View>

      {/* ⚠️ ONE gradient across the WHOLE rule, not one per segment. Five
          adjacent two-stop gradients would render as five bands with visible
          seams at the joins; a single sweep with the stops placed at the dot
          centres is what makes it read as one continuous progression. The dots
          sit ON it, punched out by a card-coloured ring so they read as beads
          on a wire rather than as bulges in it. */}
      <View style={styles.rule}>
        <LinearGradient
          colors={ramp}
          locations={locations}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={styles.ruleFill}
        />
        <View style={styles.dotRow}>
          {STEPS.map((word, i) => (
            <View key={word} style={styles.stop}>
              <View style={[styles.dot, { backgroundColor: ramp[i] }]} />
            </View>
          ))}
        </View>
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

const ICON_SIZE = 18;
const RULE_THICKNESS = 3;
const DOT_SIZE = 9;
const DOT_RING = 2;

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
  // ⚠️ NO flexWrap. The old row wrapped because it was words-and-arrows of
  // varying width; these are five equal columns, and wrapping them would break
  // the registration with the rule below.
  flow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  // One column per stop, used by BOTH the icon/label row and the dot row so the
  // two are registered on identical centres by construction.
  stop: {
    flex: 1,
    alignItems: "center",
  },
  icon: {
    marginBottom: 5,
  },
  word: {
    fontFamily: Typography.face.serif[500],
    fontSize: Typography.fontSize.base,
    fontWeight: Typography.fontWeight.medium,
    // Part 4 Item 5 — the words are NEUTRAL now. neutral[800] on this card's
    // white surface is 10.27:1. The ramp no longer touches them; it lives in
    // the rule below, where it is non-text and free of a contrast floor.
    color: Colors.neutral[800],
    textAlign: "center",
  },
  // The emphasis channel. Weight only — there is no colour left to smuggle it
  // back in through.
  wordLead: {
    fontFamily: Typography.face.serif[700],
    fontWeight: Typography.fontWeight.bold,
  },
  // The rule is as tall as its dots; the gradient bar is centred inside it.
  rule: {
    height: DOT_SIZE,
    justifyContent: "center",
    marginTop: 9,
  },
  ruleFill: {
    position: "absolute",
    left: 0,
    right: 0,
    height: RULE_THICKNESS,
    borderRadius: Radius.full,
  },
  dotRow: {
    flexDirection: "row",
  },
  // A card-coloured ring is what separates a dot from the sweep it sits on —
  // without it a dot and the gradient beneath it are the same colour at the
  // same point, and the dot disappears exactly where it is meant to mark.
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    borderWidth: DOT_RING,
    borderColor: Palette.background.card,
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
