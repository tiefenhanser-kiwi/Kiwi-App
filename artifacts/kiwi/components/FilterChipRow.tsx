import React from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";

import type { PlanFilterKey } from "@/lib/api/plans";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

export type FilterChipOption<K extends string> = {
  key: K;
  label: string;
};

// PRD §4.2.5 + §9.2.2 — same four-key set used by Home Plan Discovery
// and the Plans tab. Exported so call sites don't redeclare.
export const PLAN_DISCOVERY_FILTER_OPTIONS: FilterChipOption<PlanFilterKey>[] = [
  { key: "my_plans", label: "My Plans" },
  { key: "featured", label: "Featured" },
  { key: "top_rated", label: "Top Rated" },
  { key: "hosting_events", label: "Hosting & Events" },
];

type Props<K extends string> = {
  options: FilterChipOption<K>[];
  selected: K[];
  onToggle: (key: K) => void;
};

// Single-select semantics (4H-2): tapping a chip selects only that chip;
// tapping the already-selected chip is a no-op (the component
// short-circuits so consumers don't fire spurious onToggle / persistence
// calls). The array-based `selected` prop is preserved for back-compat
// with persisted arrays — by convention always length 1+ now.
export function FilterChipRow<K extends string>({
  options,
  selected,
  onToggle,
}: Props<K>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {options.map((opt) => {
        const isOn = selected.includes(opt.key);
        return (
          <Pressable
            key={opt.key}
            onPress={() => {
              if (isOn) return;
              onToggle(opt.key);
            }}
            style={({ pressed }) => [
              styles.chip,
              isOn ? styles.chipOn : styles.chipOff,
              pressed && !isOn && { opacity: 0.7 },
            ]}
          >
            <Text style={isOn ? styles.textOn : styles.textOff}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: Spacing[2],
    paddingVertical: Spacing[1],
  },
  chip: {
    paddingHorizontal: Spacing[3],
    paddingVertical: 6,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  // WS9 D-WS9-208 (Sept 4, Hans: "I like the other sage used in onboarding and
  // preferences better") — sage[700] #3a5235 comes DOWN to sage[600] #5C7350,
  // the value Palette.chip.selected already carries. A selected filter chip and
  // a selected preference chip are the same object at two sizes; they were two
  // greens.
  //
  // ⚠️ HARMONISED DOWNWARD, WHICH IS THE DIRECTION HANS PICKED. The white label
  // goes 8.6128:1 -> 5.2197:1 against the new fill: still clear of the 4.5:1 AA
  // floor for this 12px semibold label, and the same measurement Palette.chip
  // already documents for its own selected state.
  //
  // NOT switched to <Chip>: that primitive is a different control — larger
  // padding (Spacing[2] vs 6), fontSize.sm vs .xs, and a horizontal ScrollView
  // is not its layout. This row shares the chip COLOUR, not the chip component.
  chipOn: {
    backgroundColor: Colors.sage[600],
    borderColor: Colors.sage[600],
  },
  chipOff: {
    backgroundColor: Palette.background.card,
    borderColor: Colors.neutral[300],
  },
  textOn: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  textOff: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
});
