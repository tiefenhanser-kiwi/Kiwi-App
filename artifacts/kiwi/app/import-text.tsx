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
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { importRecipeFromText } from "@/lib/api/recipeImport";

type Phase = "input" | "loading";

const MIN_CHARS = 50;
const MAX_CHARS = 40_000;

export default function ImportTextScreen() {
  const router = useRouter();
  const { addToPlanId } = useLocalSearchParams<{ addToPlanId?: string }>();
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
          <ActivityIndicator size="large" color={KColors.sage[700]} />
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
          placeholderTextColor={KColors.neutral[600]}
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
  bg: { flex: 1, backgroundColor: KColors.neutral[100] },
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.xl,
    paddingBottom: KSpacing.xxxl,
  },
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
    minHeight: 220,
  },
  textInputInvalid: {
    borderColor: KColors.terracotta[400],
  },
  counter: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "right",
    marginTop: KSpacing.xs,
    marginBottom: KSpacing.md,
  },
  counterOver: {
    color: KColors.terracotta[700],
  },
  buttonWrap: {
    marginTop: KSpacing.md,
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
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: KSpacing.xl,
    gap: KSpacing.md,
  },
  loadingTitle: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginTop: KSpacing.md,
  },
  loadingSubtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: KSpacing.md,
  },
});
