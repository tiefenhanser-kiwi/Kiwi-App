import React, { useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { importRecipeFromText } from "@/lib/api/recipeImport";

type Phase = "input" | "loading";

const MIN_CHARS = 50;
const MAX_CHARS = 40_000;

export default function ImportTextScreen() {
  const router = useRouter();
  // WS9 3f-3 (D-WS9-005) — planId + planItemId thread the SWAP (replace) context
  // through to the builder's CREATE branch; addToPlanId threads the APPEND
  // context. They are mutually exclusive in practice (different entry points).
  const { addToPlanId, planId, planItemId } = useLocalSearchParams<{
    addToPlanId?: string;
    planId?: string;
    planItemId?: string;
  }>();
  const [text, setText] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("input");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const len = text.length;
  const overMax = len > MAX_CHARS;
  const underMin = len < MIN_CHARS;
  const importDisabled = underMin || overMax;

  const handleImport = async () => {
    if (importDisabled) return;
    Keyboard.dismiss();
    setErrorMessage(null);
    setPhase("loading");
    try {
      const result = await importRecipeFromText({ rawText: text });
      if (!result.success) {
        setErrorMessage(result.userFacingMessage);
        setPhase("input");
        return;
      }
      router.push({
        pathname: "/meal-builder",
        params: {
          draftSource: "text",
          draftJson: JSON.stringify(result.draft),
          ...(addToPlanId ? { addToPlanId } : {}),
          ...(planId ? { planId } : {}),
          ...(planItemId ? { planItemId } : {}),
        },
      });
      setPhase("input");
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Kiwi couldn't read this recipe. Try Import from Image instead.",
      );
      setPhase("input");
    }
  };

  if (phase === "loading") {
    return (
      <View style={styles.bg}>
        <Header title="Import from text" />
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={Colors.sage[700]} />
          <Text style={styles.loadingTitle}>Reading your recipe...</Text>
          <Text style={styles.loadingSubtitle}>
            Kiwi is parsing the text into structured ingredients and steps.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.bg}>
      <Header showBack title="Import from text" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Paste your recipe</Text>
        <Text style={styles.subtitle}>
          Copy a recipe from anywhere and paste it below — Kiwi will parse it
          into ingredients and steps.
        </Text>

        <TextInput
          value={text}
          onChangeText={(v) => {
            setText(v);
            if (errorMessage) setErrorMessage(null);
          }}
          placeholder="Paste recipe text here..."
          placeholderTextColor={Colors.neutral[600]}
          style={[styles.textInput, overMax && styles.textInputInvalid]}
          multiline
          numberOfLines={10}
          textAlignVertical="top"
          autoCapitalize="sentences"
          autoCorrect={false}
        />

        <Text style={[styles.counter, overMax && styles.counterOver]}>
          {len.toLocaleString()} / {MAX_CHARS.toLocaleString()} characters
        </Text>

        <View style={styles.buttonWrap}>
          <Button
            label="Import Recipe"
            variant="primary"
            disabled={importDisabled}
            onPress={handleImport}
          />
        </View>

        {errorMessage && <Text style={styles.errorText}>{errorMessage}</Text>}

        <Text style={styles.helperText}>
          Paste from anywhere — just grab the recipe from an email, text, or
          your favorite recipe pages.
        </Text>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.neutral[100] },
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[5],
    paddingBottom: Spacing[8],
  },
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
    minHeight: 220,
  },
  textInputInvalid: {
    borderColor: Colors.terracotta[400],
  },
  counter: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "right",
    marginTop: Spacing[1],
    marginBottom: Spacing[3],
  },
  counterOver: {
    color: Colors.terracotta[700],
  },
  buttonWrap: {
    marginTop: Spacing[3],
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
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing[5],
    gap: Spacing[3],
  },
  loadingTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginTop: Spacing[3],
  },
  loadingSubtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: Spacing[3],
  },
});
