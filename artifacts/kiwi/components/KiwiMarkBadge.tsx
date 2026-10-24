// CLIENT-1 (BUG-500 / BUG-506) — the Kiwi mark on a landing an emailed link
// opens (reset password, email updated). Welcome's hero mark at its compact
// size: the same raster in the same sage[100] rounded square, so a visitor who
// arrives from the mail client knows whose page this is before reading it.
// `align` follows the text under it: centred over a card, at the start over a
// left-set form title.

import React from "react";
import { Image, StyleSheet, View } from "react-native";

import { Colors, Radius, Spacing } from "@/constants/tokens";

export function KiwiMarkBadge({ align = "center" }: { align?: "center" | "start" }) {
  return (
    <View style={[s.circle, { alignSelf: align === "start" ? "flex-start" : "center" }]} testID="kiwi-mark">
      <Image
        source={require("../assets/images/kiwi-mark-256.png")}
        style={s.icon}
        accessibilityLabel="Kiwi"
      />
    </View>
  );
}

const s = StyleSheet.create({
  circle: {
    width: 64,
    height: 64,
    borderRadius: Radius["3xl"],
    backgroundColor: Colors.sage[100],
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginBottom: Spacing[2],
  },
  icon: { width: 64, height: 64 },
});
