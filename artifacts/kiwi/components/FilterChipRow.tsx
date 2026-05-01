import React from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";

import type { PlanDiscoveryFilter } from "@/lib/stubs";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

export type FilterChipOption<K extends string> = {
  key: K;
  label: string;
};

// PRD §4.2.5 + §9.2.2 — same four-key set used by Home Plan Discovery
// and the Plans tab. Exported so call sites don't redeclare.
export const PLAN_DISCOVERY_FILTER_OPTIONS: FilterChipOption<PlanDiscoveryFilter>[] = [
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
            onPress={() => onToggle(opt.key)}
            style={({ pressed }) => [
              styles.chip,
              isOn ? styles.chipOn : styles.chipOff,
              pressed && { opacity: 0.7 },
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
    gap: KSpacing.sm,
    paddingVertical: KSpacing.xs,
  },
  chip: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: 6,
    borderRadius: KRadius.pill,
    borderWidth: 1,
  },
  chipOn: {
    backgroundColor: KColors.sage[700],
    borderColor: KColors.sage[700],
  },
  chipOff: {
    backgroundColor: KColors.neutral[0],
    borderColor: KColors.neutral[300],
  },
  textOn: {
    fontSize: KType.size.xs,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  textOff: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
});
