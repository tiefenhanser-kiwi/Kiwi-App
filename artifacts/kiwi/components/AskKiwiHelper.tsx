// BOOK-1C1 (D-WS9-312) — the Ask Kiwi helper at the end of every Cookbook
// result list, and in place of an empty result.
//
// A sage card: "Not finding what you want?" / "Ask Kiwi for a meal and we'll
// make it just how you like it.", then the Tell Kiwi look — a paper pill input
// with the terracotta round arrow (the Components.tellKiwi tokens, so the two
// read as one family). The pill starts with the search text; the arrow (or the
// keyboard's go) opens the existing Ask Kiwi meal maker, or the subscribe sheet
// on a lapsed account (lib/cookbook/askKiwi.ts says why that is a shortcut and
// not the gate).

import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Colors, Components, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useBilling } from "@/contexts/BillingContext";
import { askKiwiAction } from "@/lib/cookbook/askKiwi";

export const ASK_KIWI_HELPER_TITLE = "Not finding what you want?";
export const ASK_KIWI_HELPER_BODY = "Ask Kiwi for a meal and we'll make it just how you like it.";

const ARROW = 34;
const INPUT_HEIGHT = 44;

export function AskKiwiHelper({ searchText }: { searchText: string }) {
  const router = useRouter();
  const { subscription, openSheet } = useBilling();
  const [text, setText] = useState(searchText);
  // Follow the search box until the user edits here.
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) setText(searchText);
  }, [searchText, edited]);

  const go = () => {
    const action = askKiwiAction(subscription, text);
    if (action.kind === "paywall") {
      openSheet("lapsed");
      return;
    }
    router.push({
      pathname: "/ask-kiwi",
      params: action.prompt ? { prompt: action.prompt } : {},
    });
  };

  return (
    <View style={s.card} testID="cookbook-ask-kiwi">
      <Text style={s.title}>{ASK_KIWI_HELPER_TITLE}</Text>
      <Text style={s.body}>{ASK_KIWI_HELPER_BODY}</Text>
      <View style={s.inputWrap}>
        <TextInput
          style={s.input}
          value={text}
          onChangeText={(v) => {
            setEdited(true);
            setText(v);
          }}
          onSubmitEditing={go}
          placeholder="Describe a meal…"
          placeholderTextColor={Components.tellKiwi.inputPlaceholder}
          returnKeyType="go"
          accessibilityLabel="Describe a meal for Kiwi"
        />
        <Pressable
          onPress={go}
          accessibilityRole="button"
          accessibilityLabel="Ask Kiwi"
          hitSlop={8}
          style={({ pressed }) => [s.arrow, pressed && { opacity: 0.85 }]}
        >
          <Feather name="arrow-right" size={18} color={Components.tellKiwi.sendGlyph} />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: Components.tellKiwi.surface,
    borderRadius: Radius.xl,
    padding: Spacing[4],
    gap: 6,
  },
  title: {
    fontFamily: Typography.face.serifItalic[600],
    fontStyle: "italic",
    fontSize: Typography.fontSize.lg,
    color: Palette.text.onSage,
  },
  body: {
    fontFamily: Typography.face.sans[500],
    fontSize: Typography.fontSize.sm,
    // The Tell Kiwi card's connector tone: 4.62:1 on this surface.
    color: Components.tellKiwi.connector,
    marginBottom: 6,
  },
  inputWrap: {
    height: INPUT_HEIGHT,
    justifyContent: "center",
    backgroundColor: Components.tellKiwi.inputBackground,
    borderRadius: Components.tellKiwi.inputRadius,
    paddingLeft: 17,
    paddingRight: ARROW + 12,
  },
  input: {
    fontFamily: Typography.face.serifItalic[400],
    fontStyle: "italic",
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[900],
    padding: 0,
  },
  arrow: {
    position: "absolute",
    right: 5,
    width: ARROW,
    height: ARROW,
    borderRadius: ARROW / 2,
    backgroundColor: Components.tellKiwi.sendFill,
    alignItems: "center",
    justifyContent: "center",
  },
});
