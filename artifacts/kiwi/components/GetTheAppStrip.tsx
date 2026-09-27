// Row 13 "Test Kitchen" · Block 2 Part F (R10) — the "get the app" strip.
//
// A slim persistent strip for signed-in WEB users. Two gates, both of which
// currently close it, and that is the shipped state:
//   · Platform.OS === "web" — a native user already has the app;
//   · at least one store link exists — constants/storeLinks.ts holds null for
//     both until release, and the ruling is "render nothing while null".
//
// So this renders nothing today. It is written now rather than later because the
// alternative is a link hard-coded into a screen when the URLs arrive, and R10
// asked for one constant.

import React from "react";
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";
import { STORE_LINKS, anyStoreLink } from "@/constants/storeLinks";

export const GET_THE_APP_LINE = "Kiwi is better in the app — cook with it in the kitchen.";
export const GET_THE_APP_CTA = "Get the app";

export function GetTheAppStrip() {
  if (Platform.OS !== "web") return null;
  if (!anyStoreLink()) return null;

  const open = () => {
    // Either link will do from a browser; both store pages redirect a visitor on
    // the other platform. iOS first only because that is the order R10 names.
    const url = STORE_LINKS.ios ?? STORE_LINKS.android;
    if (!url) return;
    void Linking.openURL(url).catch(() => {
      // A blocked pop-up is not worth an alert over a promotional strip.
    });
  };

  return (
    <Pressable
      onPress={open}
      style={({ pressed }) => [s.strip, pressed && { opacity: 0.8 }]}
      testID="get-the-app-strip"
    >
      <Feather name="smartphone" size={16} color={Colors.sage[700]} />
      <View style={{ flex: 1 }}>
        <Text style={s.line} numberOfLines={2}>
          {GET_THE_APP_LINE}
        </Text>
      </View>
      <Text style={s.cta}>{GET_THE_APP_CTA}</Text>
      <Feather name="chevron-right" size={16} color={Colors.sage[700]} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    backgroundColor: Colors.sage[50],
    borderBottomWidth: 1,
    borderBottomColor: Colors.sage[300],
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[2],
  },
  line: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
  },
  cta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
    borderRadius: Radius.sm,
  },
});
