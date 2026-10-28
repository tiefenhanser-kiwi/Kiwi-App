// CLIENT-5 D (BUG-570) — "Send list" on the web without navigator.share: copy
// the list, or email it. The text is lib/groceryShare.ts groceryShareText; the
// phone never opens this (React Native's Share sheet is the phone's own).

import React, { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { groceryMailtoHref } from "@/lib/groceryShare";
import { sheetHandleShown, webSheet } from "@/lib/webLayout";

export interface GroceryShareSheetProps {
  /** The list's text, or null when closed. */
  text: string | null;
  /** The email's subject (the text's title line). */
  subject: string;
  onClose: () => void;
}

type CopyState = "idle" | "copied" | "failed";

export function GroceryShareSheet({ text, subject, onClose }: GroceryShareSheetProps) {
  const insets = useSafeAreaInsets();
  const [copy, setCopy] = useState<CopyState>("idle");
  useEffect(() => setCopy("idle"), [text]);

  const onCopy = async () => {
    if (text === null) return;
    try {
      const clip = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator?.clipboard;
      if (!clip?.writeText) throw new Error("no clipboard");
      await clip.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  const onEmail = () => {
    if (text === null) return;
    const loc = (globalThis as { location?: { href: string } }).location;
    if (loc) loc.href = groceryMailtoHref(text, subject);
  };

  return (
    <Modal visible={text !== null} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={webSheet([s.sheet, { paddingBottom: insets.bottom + Spacing[3] }])}>
        {sheetHandleShown() && <View style={s.handle} />}
        <View style={s.header}>
          <Text style={s.title}>Send your list</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Feather name="x" size={22} color={Colors.neutral[700]} />
          </Pressable>
        </View>
        <Text style={s.intro}>
          Your grocery list, complete and sorted by aisle. Copy it into a text, or email it.
        </Text>
        <ScrollView style={s.preview} contentContainerStyle={s.previewBody}>
          <Text selectable style={s.previewText} testID="grocery-share-text">
            {text}
          </Text>
        </ScrollView>
        <View style={s.actions}>
          <Button
            label={copy === "copied" ? "Copied" : "Copy list"}
            variant="primary"
            onPress={() => void onCopy()}
            iconLeft={<Feather name={copy === "copied" ? "check" : "copy"} size={16} color={Colors.neutral[0]} />}
            testID="grocery-share-copy"
          />
          <Button
            label="Email it"
            variant="secondary"
            onPress={onEmail}
            iconLeft={<Feather name="mail" size={16} color={Colors.sage[700]} />}
            testID="grocery-share-email"
          />
        </View>
        {copy === "copied" && <Text style={s.note}>Copied. Paste it into a text or an email.</Text>}
        {copy === "failed" && (
          <Text style={s.note}>This browser wouldn't copy it. Select the list above and copy it yourself.</Text>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "88%",
    backgroundColor: Palette.background.card,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[2],
    gap: Spacing[3],
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.neutral[300],
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[3],
  },
  title: {
    flex: 1,
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  intro: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
  preview: {
    maxHeight: 240,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    borderRadius: Radius.md,
    backgroundColor: Colors.neutral[100],
  },
  previewBody: {
    padding: Spacing[3],
  },
  previewText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  actions: {
    gap: Spacing[2],
  },
  note: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    lineHeight: 18,
  },
});
