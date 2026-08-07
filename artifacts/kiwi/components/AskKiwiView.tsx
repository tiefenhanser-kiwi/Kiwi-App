// WS7-6 G1 — presentational body for the Mode A "Ask Kiwi" input screen
// (app/ask-kiwi.tsx). Split out as a pure-props component (Block 4
// container/view precedent) so it renders under the node test harness without
// the screen's expo-router / keyboard-controller dependencies — the screen
// wraps this in KeyboardAwareScrollViewCompat + Header.

import React from "react";
import { Keyboard, StyleSheet, Text, TextInput, View } from "react-native";

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
  // WS9 3f-4c (BUG-063) — the 3f-4b claim that a `multiline` input cannot show
  // an Android "done"/checkmark key was WRONG: the Preferences Wizard notes
  // field is multiline and shows it, via `returnKeyType="done" + blurOnSubmit +
  // onSubmitEditing`. Matching that config here gives the same keyboard-level
  // Done — which both dismisses AND retains the text (confirmation) — on Android
  // and iOS. The in-layout Done control from 3f-4b is removed as redundant. (The
  // trade, same as the wizard: return dismisses instead of inserting a newline —
  // fine for a one-line-ish meal description.)
  return (
    <View style={s.body}>
      <Text style={s.title}>{title}</Text>
      <Text style={s.subtitle}>{subtitle}</Text>

      <TextInput
        value={text}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Colors.neutral[600]}
        style={s.textInput}
        multiline
        numberOfLines={6}
        returnKeyType="done"
        blurOnSubmit
        onSubmitEditing={Keyboard.dismiss}
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
