// WS7-6 G1 — presentational body for the Mode A "Ask Kiwi" input screen
// (app/ask-kiwi.tsx). Split out as a pure-props component (Block 4
// container/view precedent) so it renders under the node test harness without
// the screen's expo-router / keyboard-controller dependencies — the screen
// wraps this in KeyboardAwareScrollViewCompat + Header.

import React, { useState } from "react";
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Button } from "@/components/Button";
import { Stepper } from "@/components/Stepper";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

export const ASK_KIWI_SERVINGS_MIN = 1;
export const ASK_KIWI_SERVINGS_MAX = 12;
export const ASK_KIWI_SERVINGS_DEFAULT = 4;
const PLACEHOLDER =
  "e.g. Chicken piccata with a side arugula salad and lemon vinaigrette";
const SUBTITLE =
  "Describe the meal in your own words — Kiwi will turn it into a meal with dishes, ingredients, and steps you can review and edit.";
const HELPER =
  "Premium · Kiwi reads your description and drafts a full meal. You can change anything before saving.";

export interface AskKiwiViewProps {
  text: string;
  onChangeText: (v: string) => void;
  servings: number;
  onServingsChange: (n: number) => void;
  submitDisabled: boolean;
  onSubmit: () => void;
  errorMessage: string | null;
  // WS7-6 G2 — optional copy overrides so the dish-side Mode A screen
  // (app/ask-kiwi-dish.tsx) reuses this view with dish-shaped wording.
  // Defaults are the original meal copy, so app/ask-kiwi.tsx is unchanged.
  title?: string;
  subtitle?: string;
  placeholder?: string;
  helperText?: string;
  // D-WS9-017 — the submit CTA carries the item-scoped qualifier ("Ask Kiwi
  // for a meal" / "…for a dish"). Defaults to the meal wording so app/ask-kiwi.tsx
  // is unchanged; app/ask-kiwi-dish.tsx passes the dish variant.
  submitLabel?: string;
}

export function AskKiwiView({
  text,
  onChangeText,
  servings,
  onServingsChange,
  submitDisabled,
  onSubmit,
  errorMessage,
  title = "Ask Kiwi for a meal",
  subtitle = SUBTITLE,
  placeholder = PLACEHOLDER,
  helperText = HELPER,
  submitLabel = "Ask Kiwi for a meal",
}: AskKiwiViewProps) {
  // WS9 3f-4b (§6.1) — the input is `multiline`, so Android renders a newline
  // key rather than a "done" key regardless of returnKeyType. There is no
  // keyboard toolbar (the app uses no KeyboardToolbar), and on the swap sheet a
  // tap outside hits the backdrop and CLOSES the sheet rather than dismissing
  // the keyboard. So the Done affordance is solved IN LAYOUT: a control shown
  // while the field is focused that dismisses the keyboard. Works on both
  // surfaces (this is the shared body) and both platforms; no native dep.
  const [focused, setFocused] = useState(false);
  return (
    <View style={s.body}>
      <Text style={s.title}>{title}</Text>
      <Text style={s.subtitle}>{subtitle}</Text>

      {focused ? (
        <View style={s.doneRow}>
          <Pressable
            onPress={() => Keyboard.dismiss()}
            hitSlop={10}
            accessibilityRole="button"
            testID="ask-kiwi-done"
          >
            <Text style={s.doneText}>Done</Text>
          </Pressable>
        </View>
      ) : null}

      <TextInput
        value={text}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={Colors.neutral[600]}
        style={s.textInput}
        multiline
        numberOfLines={6}
        textAlignVertical="top"
        autoCapitalize="sentences"
        autoCorrect
        testID="ask-kiwi-input"
      />

      <View style={s.servingsRow}>
        <Text style={s.fieldLabel}>Servings</Text>
        <Stepper
          value={servings}
          onChange={onServingsChange}
          min={ASK_KIWI_SERVINGS_MIN}
          max={ASK_KIWI_SERVINGS_MAX}
        />
      </View>

      <View style={s.buttonWrap}>
        <Button
          label={submitLabel}
          variant="primary"
          disabled={submitDisabled}
          onPress={onSubmit}
          testID="ask-kiwi-submit"
        />
      </View>

      {errorMessage && (
        <Text style={s.errorText} testID="ask-kiwi-error">
          {errorMessage}
        </Text>
      )}

      <Text style={s.helperText}>{helperText}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  body: { gap: 0 },
  title: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[2],
  },
  subtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
    marginBottom: Spacing[5],
  },
  doneRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginBottom: Spacing[1],
  },
  doneText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    paddingVertical: Spacing[1],
    paddingHorizontal: Spacing[2],
  },
  textInput: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[3],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    minHeight: 140,
  },
  servingsRow: {
    marginTop: Spacing[4],
    gap: Spacing[2],
  },
  fieldLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  buttonWrap: {
    marginTop: Spacing[5],
  },
  errorText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
    marginTop: Spacing[2],
  },
  helperText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
    marginTop: Spacing[4],
  },
});
