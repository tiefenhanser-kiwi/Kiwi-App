// WS7-8b Block 4 (Block 1) — shared progress-segment bar.
//
// Lifted from CookSessionView, parameterized by (segmentCount, currentIndex) so
// it serves N cook steps OR the 4 Week Prep phases. Done = sage, current =
// terracotta, upcoming = neutral. Pure/stateless; keyed by index (the original
// keyed by step.key — equivalent output for a flat row of decorative Views).

import React from "react";
import { StyleSheet, View } from "react-native";

import { Colors, Spacing } from "@/constants/tokens";

export function ProgressSegments({
  segmentCount,
  currentIndex,
}: {
  segmentCount: number;
  currentIndex: number;
}) {
  return (
    <View style={s.segments}>
      {Array.from({ length: segmentCount }).map((_, i) => (
        <View
          key={i}
          style={[
            s.segment,
            i < currentIndex && s.segmentDone,
            i === currentIndex && s.segmentCurrent,
            i > currentIndex && s.segmentUpcoming,
          ]}
        />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  segments: {
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
  },
  segment: { flex: 1, height: 4, borderRadius: 2 },
  segmentDone: { backgroundColor: Colors.sage[600] },
  segmentCurrent: { backgroundColor: Colors.terracotta[400] },
  segmentUpcoming: { backgroundColor: Colors.neutral[300] },
});
