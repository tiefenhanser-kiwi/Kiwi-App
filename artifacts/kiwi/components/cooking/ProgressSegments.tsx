// WS7-8b Block 4 (Block 1) — shared progress-segment bar.
//
// Lifted from CookSessionView, parameterized by (segmentCount, currentIndex) so
// it serves N cook steps OR the 4 Week Prep phases. Done = sage, current =
// terracotta, upcoming = neutral. Pure/stateless; keyed by index (the original
// keyed by step.key — equivalent output for a flat row of decorative Views).
//
// BUG-020 (Option B): an OPTIONAL `partialIndices` marks done-position segments
// that were advanced past with unchecked steps ("Done for now"). A partial
// segment renders sage at reduced opacity (never a new color). Back-compat is
// load-bearing: CookSessionView passes nothing → `partialIndices` undefined →
// every done segment is solid sage exactly as before. Only segments already in
// the DONE band (i < currentIndex) can be partial; current/upcoming are unchanged.

import React from "react";
import { StyleSheet, View } from "react-native";

import { Colors, Spacing } from "@/constants/tokens";

export function ProgressSegments({
  segmentCount,
  currentIndex,
  partialIndices,
}: {
  segmentCount: number;
  currentIndex: number;
  /** Done-band indices to render partial (sage @ reduced opacity). Omit → none. */
  partialIndices?: readonly number[];
}) {
  const partial = partialIndices ? new Set(partialIndices) : undefined;
  return (
    <View style={s.segments}>
      {Array.from({ length: segmentCount }).map((_, i) => {
        const isDone = i < currentIndex;
        const isPartial = isDone && !!partial?.has(i);
        return (
          <View
            key={i}
            style={[
              s.segment,
              isDone && !isPartial && s.segmentDone,
              isPartial && s.segmentPartial,
              i === currentIndex && s.segmentCurrent,
              i > currentIndex && s.segmentUpcoming,
            ]}
          />
        );
      })}
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
  // BUG-020: advanced-past-with-unchecked-steps. Same sage token as done, at
  // reduced opacity (~45%) so it reads as "visited but not fully complete" —
  // deliberately NOT a new color (Option C badges were ruled out).
  segmentPartial: { backgroundColor: Colors.sage[600], opacity: 0.45 },
  segmentCurrent: { backgroundColor: Colors.terracotta[400] },
  segmentUpcoming: { backgroundColor: Colors.neutral[300] },
});
