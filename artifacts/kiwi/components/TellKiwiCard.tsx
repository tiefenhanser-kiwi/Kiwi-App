// WS9 L2b — Tell Kiwi card (net-new, R1-AMENDED · §3 · Components.tellKiwi).
// ONE sage card: serif-italic headline + sub, a single-line PILL free-text field
// (paper, serif italic — mockup .tell .input border-radius:99px, NOT multiline),
// and two on-sage chips: "✦ Surprise me" · "Use my preferences".
//
// Presentational + dumb: the input is controlled (value/onChangeText/onSubmit) and
// the chips take handlers as PROPS. Chip routing is 3a's spec, NOT this card's
// (§5.1: Surprise → surprise-me gen; Use my preferences → wizard prefilled). The
// same card is reused on tellkiwi.tsx (§7.1) — hence controlled input, not a
// tap-to-navigate stub.
//
// Card radius = Radius["2xl"] (18px) — deliberately rounder than the 14px card
// family; it is the hero of the make lane (do not harmonize to 14). Chips use
// Palette.chip.onSage. Type-scale on the token scale per FLAG 1.

import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  Colors,
  Components,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";

const DEFAULT_TITLE = "Tell Kiwi";
const DEFAULT_SUBTITLE = "Say it in your words — a mood, a cuisine, a whole week.";
const DEFAULT_PLACEHOLDER = "something cozy for a rainy week…";

type Props = {
  value?: string;
  onChangeText?: (text: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  editable?: boolean;
  title?: string;
  subtitle?: string;
  /** ✦ Surprise me — 3a wires the surprise-me generation path. */
  onSurprise?: () => void;
  /** Use my preferences — 3a wires the prefilled wizard. */
  onUsePreferences?: () => void;
};

function Chip({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed && { opacity: 0.75 }]}
    >
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
}

export function TellKiwiCard({
  value,
  onChangeText,
  onSubmit,
  placeholder = DEFAULT_PLACEHOLDER,
  editable = true,
  title = DEFAULT_TITLE,
  subtitle = DEFAULT_SUBTITLE,
  onSurprise,
  onUsePreferences,
}: Props) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        placeholder={placeholder}
        placeholderTextColor={Components.tellKiwi.inputPlaceholder}
        editable={editable}
        returnKeyType="go"
      />
      <View style={styles.chips}>
        <Chip label="✦ Surprise me" onPress={onSurprise} />
        <Chip label="Use my preferences" onPress={onUsePreferences} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Components.tellKiwi.surface,
    borderRadius: Radius["2xl"],
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: 14,
  },
  title: {
    fontFamily: Typography.face.serifItalic[500],
    fontStyle: "italic",
    fontSize: Typography.fontSize.xl,
    color: Palette.text.onSage,
    marginBottom: 3,
  },
  subtitle: {
    fontSize: Typography.fontSize.sm,
    color: Palette.text.onSageSub,
    fontFamily: Typography.face.sans[400],
    marginBottom: 11,
  },
  input: {
    backgroundColor: Components.tellKiwi.inputBackground,
    borderRadius: Components.tellKiwi.inputRadius,
    paddingVertical: 12,
    paddingHorizontal: 17,
    fontFamily: Typography.face.serifItalic[400],
    fontStyle: "italic",
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[900],
  },
  chips: {
    flexDirection: "row",
    gap: Spacing[1] * 2,
    marginTop: Spacing[2] + 2,
  },
  chip: {
    borderWidth: 1.2,
    borderColor: Palette.chip.onSage.border,
    borderRadius: Radius.full,
    paddingHorizontal: 13,
    paddingVertical: 6,
  },
  chipText: {
    color: Palette.chip.onSage.text,
    fontSize: Typography.fontSize.sm,
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
});
