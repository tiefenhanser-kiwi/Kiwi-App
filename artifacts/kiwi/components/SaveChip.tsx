// BOOK-1C2 — the Save chip: "Save" on light sage, "Saved" on dark sage. It
// replaced the heart on the Cookbook card and on meal detail (the heart read as
// a "like"). Presentational: the host passes the state and the tap, and the
// tap is AppContext.setSaved in both hosts, as the heart's was.
//
// The Pressable is the 44 × 44 pt floor (SAVE_CHIP_MIN_HIT) and the pill sits
// inside it, so the target is never smaller than the finger whatever the pill
// measures. hitSlop is not used for that: react-native-web ignores it. A host
// keeps the chip a SIBLING of anything that opens the meal — nested Pressables
// bubble on web, and a save must never also open the card.
//
// State reaches assistive tech twice: the label flips ("Save to My Meals" /
// "Saved to My Meals") and aria-selected carries the state (RN maps it to the
// native selected state; react-native-web emits the attribute).

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Radius, Typography } from "@/constants/tokens";
import { SAVE_CHIP_MIN_HIT, saveChipView } from "@/lib/cookbook/saveChip";

export interface SaveChipProps {
  saved: boolean;
  onToggle: () => void;
  testID?: string;
}

export function SaveChip({ saved, onToggle, testID }: SaveChipProps) {
  const v = saveChipView(saved);
  const dark = v.tone === "dark";
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={v.accessibilityLabel}
      accessibilityHint={v.accessibilityHint}
      aria-selected={saved}
      testID={testID}
      style={({ pressed }) => [s.hit, pressed && { opacity: 0.7 }]}
    >
      <View style={[s.pill, dark ? s.pillDark : s.pillLight]}>
        <Feather name={v.icon} size={14} color={dark ? Colors.neutral[0] : Colors.sage[700]} />
        <Text style={[s.text, dark ? s.textDark : s.textLight]}>{v.label}</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  hit: {
    minWidth: SAVE_CHIP_MIN_HIT,
    minHeight: SAVE_CHIP_MIN_HIT,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    height: 32,
    // Wide enough for "Saved", so the chip does not change width on a tap.
    minWidth: 84,
    paddingHorizontal: 12,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  // sage[700] text on sage[100]: 6.92:1.
  pillLight: { backgroundColor: Colors.sage[100], borderColor: Colors.sage[200] },
  // White on sage[700]: 8.61:1.
  pillDark: { backgroundColor: Colors.sage[700], borderColor: Colors.sage[700] },
  text: {
    fontSize: Typography.fontSize.sm,
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  textLight: { color: Colors.sage[700] },
  textDark: { color: Colors.neutral[0] },
});
