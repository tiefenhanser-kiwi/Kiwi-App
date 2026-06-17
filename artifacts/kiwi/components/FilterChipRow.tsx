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
  chipOn: {
    backgroundColor: Colors.sage[700],
    borderColor: Colors.sage[700],
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
