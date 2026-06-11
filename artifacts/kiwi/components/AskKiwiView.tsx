// WS7-6 G1 — presentational body for the Mode A "Ask Kiwi" input screen
// (app/ask-kiwi.tsx). Split out as a pure-props component (Block 4
// container/view precedent) so it renders under the node test harness without
// the screen's expo-router / keyboard-controller dependencies — the screen
// wraps this in KeyboardAwareScrollViewCompat + Header.

import React from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { Button } from "@/components/Button";
import { Stepper } from "@/components/Stepper";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";

export const ASK_KIWI_SERVINGS_MIN = 1;
export const ASK_KIWI_SERVINGS_MAX = 12;
export const ASK_KIWI_SERVINGS_DEFAULT = 4;
const PLACEHOLDER =
  "e.g. Chicken piccata with a side arugula salad and lemon vinaigrette";

export interface AskKiwiViewProps {
  text: string;
  onChangeText: (v: string) => void;
  servings: number;
  onServingsChange: (n: number) => void;
  submitDisabled: boolean;
  onSubmit: () => void;
  errorMessage: string | null;
}

export function AskKiwiView({
  text,
  onChangeText,
  servings,
  onServingsChange,
  submitDisabled,
  onSubmit,
  errorMessage,
}: AskKiwiViewProps) {
  return (
    <View style={s.body}>
      <Text style={s.title}>Tell Kiwi what you want</Text>
      <Text style={s.subtitle}>
        Describe the meal in your own words — Kiwi will turn it into a meal with
        dishes, ingredients, and steps you can review and edit.
      </Text>

      <TextInput
        value={text}
        onChangeText={onChangeText}
        placeholder={PLACEHOLDER}
        placeholderTextColor={KColors.neutral[600]}
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
          label="Ask Kiwi"
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

      <Text style={s.helperText}>
        Premium · Kiwi reads your description and drafts a full meal. You can
        change anything before saving.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  body: { gap: 0 },
  title: {
    fontSize: KType.size.xl,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
  },
  subtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
    marginBottom: KSpacing.xl,
  },
  textInput: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.md,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    minHeight: 140,
  },
  servingsRow: {
    marginTop: KSpacing.lg,
    gap: KSpacing.sm,
  },
  fieldLabel: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  buttonWrap: {
    marginTop: KSpacing.xl,
  },
  errorText: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
    marginTop: KSpacing.sm,
  },
  helperText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
    marginTop: KSpacing.lg,
  },
});
