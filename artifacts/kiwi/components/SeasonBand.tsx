// BOOK-1C1 (D-WS9-312) — the Cookbook's seasonal band: gold, dashed,
// dismissible, above the chip row. "SEASONAL · UNTIL NOV 30" / "Thanksgiving
// feasts & dishes" / "N recipes · turkeys, sides, pies", an arrow, and an ✕.
//
// A promotion, never a filter (Hans: "we're not a thanksgiving app, we're a
// meal app"): the band opens the season's collection view; it does not touch
// the Cookbook's own filters. Visibility rules are lib/cookbook/seasons.ts's
// (window by the server's clock, count above 0, not dismissed); this component
// only draws a season it is handed.
//
// Colour: Colors.gold.background with neutral[800] text. Not gold.text on that
// fill — it measures 3.76:1, under AA (tokens.ts, Palette.badge.trial). The
// gold ink is used only for the dashed border and the arrow, which are
// non-text.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";
import type { Season } from "@/lib/api/cookbook";
import { seasonEyebrow, seasonSubline } from "@/lib/cookbook/seasons";

export function SeasonBand({
  season,
  onOpen,
  onDismiss,
}: {
  season: Season;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <View style={s.band} testID={`season-band-${season.tag}`}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${season.headline}. ${seasonSubline(season)}`}
        style={({ pressed }) => [s.body, pressed && { opacity: 0.85 }]}
      >
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>{seasonEyebrow(season)}</Text>
          <Text style={s.headline}>{season.headline}</Text>
          <Text style={s.subline}>{seasonSubline(season)}</Text>
        </View>
        <Feather name="arrow-right" size={20} color={Colors.gold.text} />
      </Pressable>
      <Pressable
        onPress={onDismiss}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`Hide ${season.label}`}
        style={s.close}
      >
        <Feather name="x" size={16} color={Colors.neutral[800]} />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  band: {
    backgroundColor: Colors.gold.background,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: Colors.gold.text,
  },
  body: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    paddingVertical: Spacing[3],
    paddingLeft: Spacing[4],
    // Room for the ✕ in the top-right corner.
    paddingRight: Spacing[8],
  },
  eyebrow: {
    fontSize: Typography.fontSize.xxs,
    letterSpacing: 1,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[700],
    fontWeight: Typography.fontWeight.bold,
  },
  headline: {
    marginTop: 2,
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  subline: {
    marginTop: 2,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
  },
  close: {
    position: "absolute",
    top: Spacing[2],
    right: Spacing[2],
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
});
