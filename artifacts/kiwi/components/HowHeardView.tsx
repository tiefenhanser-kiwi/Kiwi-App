// CLIENT-3 D (ATTR) — "How did you hear about Kiwi?" (app/how-heard.tsx owns
// the routing and the PATCH; this renders and forwards taps, testable in
// node:test). One tap on an answer is the whole question; "A creator" opens a
// short "who?" box with its own Continue; Skip is always there.

import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  HOW_HEARD_DETAIL_MAX,
  HOW_HEARD_OPTIONS,
  HOW_HEARD_TITLE,
  type HowHeard,
} from "@/lib/howHeard";

export interface HowHeardViewProps {
  onAnswer: (value: HowHeard, detail?: string) => void;
  onSkip: () => void;
}

export function HowHeardView({ onAnswer, onSkip }: HowHeardViewProps) {
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [who, setWho] = useState("");

  return (
    <KeyboardAwareScrollViewCompat
      contentContainerStyle={s.scrollContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <Text style={s.title} accessibilityRole="header">
        {HOW_HEARD_TITLE}
      </Text>
      <View style={s.options}>
        {HOW_HEARD_OPTIONS.map((o) => (
          <Pressable
            key={o.value}
            onPress={() => (o.value === "creator" ? setCreatorOpen(true) : onAnswer(o.value))}
            accessibilityRole="button"
            accessibilityState={o.value === "creator" ? { expanded: creatorOpen } : undefined}
            style={({ pressed }) => [
              s.option,
              o.value === "creator" && creatorOpen && s.optionOpen,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={s.optionText}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
      {creatorOpen && (
        <View style={s.creator}>
          <Text style={s.label}>Who? (optional)</Text>
          <TextInput
            value={who}
            onChangeText={setWho}
            placeholder="Their name or handle"
            placeholderTextColor={Palette.text.placeholder}
            maxLength={HOW_HEARD_DETAIL_MAX}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => onAnswer("creator", who)}
            accessibilityLabel="Which creator"
            style={s.input}
          />
          <Button label="Continue" variant="primary" onPress={() => onAnswer("creator", who)} />
        </View>
      )}
      <View style={s.skip}>
        <Button label="Skip" variant="ghost" onPress={onSkip} />
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[8],
    paddingBottom: Spacing[8] * 2,
    gap: Spacing[3],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  options: { gap: Spacing[2], marginTop: Spacing[1] },
  option: {
    minHeight: 48,
    justifyContent: "center",
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[3],
  },
  optionOpen: { borderColor: Colors.sage[600] },
  optionText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[500],
  },
  creator: { gap: Spacing[2] },
  label: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  skip: { marginTop: Spacing[2] },
});
