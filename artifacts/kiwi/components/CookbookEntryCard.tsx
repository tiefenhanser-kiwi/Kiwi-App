// BOOK-1C1 (D-WS9-312) — the Recipes tab's way into the Cookbook: a sage card
// at the top, "Browse the Kiwi Cookbook" / "1,325 meals · search, filter, plan
// a week", with the arrow → /cookbook.
//
// The N is live: the Cookbook's own eligible count for this user (their
// allergies applied), the same number the Cookbook header shows, so the card
// never promises meals the screen will not list. Until it lands the line reads
// without a number rather than with a guessed one.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Colors, Components, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useCookbookCount } from "@/hooks/useCookbook";
import { mealCountLabel } from "@/lib/cookbook/query";

export function CookbookEntryCard() {
  const router = useRouter();
  const eligible = useCookbookCount({}, true);
  const subline =
    eligible.data === undefined
      ? "Search, filter, plan a week"
      : `${mealCountLabel(eligible.data)} · search, filter, plan a week`;

  return (
    <Pressable
      onPress={() => router.push("/cookbook")}
      accessibilityRole="button"
      accessibilityLabel={`Browse the Kiwi Cookbook. ${subline}`}
      style={({ pressed }) => [s.card, pressed && { opacity: 0.9 }]}
      testID="recipes-cookbook-card"
    >
      <View style={{ flex: 1 }}>
        <Text style={s.title}>Browse the Kiwi Cookbook</Text>
        <Text style={s.subline}>{subline}</Text>
      </View>
      <View style={s.arrow}>
        <Feather name="arrow-right" size={18} color={Components.tellKiwi.sendGlyph} />
      </View>
    </Pressable>
  );
}

const ARROW = 34;

const s = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Components.tellKiwi.surface,
    borderRadius: Radius.xl,
    paddingVertical: Spacing[4],
    paddingHorizontal: Spacing[4],
    marginTop: Spacing[3],
  },
  title: {
    fontFamily: Typography.face.serifItalic[600],
    fontStyle: "italic",
    fontSize: Typography.fontSize.lg,
    color: Palette.text.onSage,
  },
  subline: {
    marginTop: 2,
    fontFamily: Typography.face.sans[500],
    fontSize: Typography.fontSize.sm,
    color: Components.tellKiwi.connector,
  },
  arrow: {
    width: ARROW,
    height: ARROW,
    borderRadius: ARROW / 2,
    backgroundColor: Components.tellKiwi.sendFill,
    alignItems: "center",
    justifyContent: "center",
  },
});
