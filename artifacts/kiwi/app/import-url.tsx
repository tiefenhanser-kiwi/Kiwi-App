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
import { importRecipeFromUrl } from "@/lib/api/recipeImport";

type Phase = "input" | "loading";

/**
 * Normalize common URL shapes:
 *   "https://example.com/r" → "https://example.com/r" (unchanged)
 *   "http://example.com/r"  → "http://example.com/r"  (unchanged)
 *   "www.example.com/r"     → "https://www.example.com/r"
 *   "example.com/r"         → "https://example.com/r"
 * Returns null if the input doesn't look like a URL at all.
 */
function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Looks like a domain: contains a dot, has a non-empty token on each side,
  // and no whitespace anywhere.
  if (/^[^\s]+\.[^\s]+/.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return null;
}

export default function ImportUrlScreen() {
  const router = useRouter();
  // WS9 3f-3 (D-WS9-005) — planId + planItemId thread the SWAP (replace) context
  // through to the builder's CREATE branch; addToPlanId threads the APPEND
  // context. They are mutually exclusive in practice (different entry points).
  const { addToPlanId, planId, planItemId } = useLocalSearchParams<{
    addToPlanId?: string;
    planId?: string;
    planItemId?: string;
  }>();
  const [phase, setPhase] = useState<Phase>("input");
  const [url, setUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Disable button only on empty input. We let handleImport surface a
  // visible error message for genuinely invalid (non-URL) text — the
  // previous behavior left users with a silently disabled button.
  const importDisabled = url.trim().length === 0;

  const handleImport = async () => {
    Keyboard.dismiss();
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setErrorMessage(
        "That doesn't look like a URL. Try something like recipesite.com/your-recipe.",
      );
      return;
    }
    setErrorMessage(null);
    setPhase("loading");
    try {
      const result = await importRecipeFromUrl({ url: normalized });
      if (!result.success) {
        setErrorMessage(result.userFacingMessage);
        setPhase("input");
        return;
      }
      router.push({
        pathname: "/meal-builder",
        params: {
          draftSource: "url",
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
        <Header title="Import from URL" />
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={Colors.sage[700]} />
          <Text style={styles.loadingTitle}>Reading your recipe...</Text>
          <Text style={styles.loadingSubtitle}>
            Kiwi is parsing the page into structured ingredients and steps.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.bg}>
      <Header showBack title="Import from URL" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Paste a recipe URL</Text>
        <Text style={styles.subtitle}>
          Kiwi can parse any public recipe into ingredients and steps for you.
        </Text>

        <TextInput
          value={url}
          onChangeText={(v) => {
            setUrl(v);
            if (errorMessage) setErrorMessage(null);
          }}
          placeholder="https://www.allrecipes.com/recipe/..."
          placeholderTextColor={Palette.text.placeholder}
          style={[styles.urlInput, errorMessage && styles.urlInputInvalid]}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={handleImport}
        />

        {errorMessage && <Text style={styles.errorText}>{errorMessage}</Text>}

        <Text style={styles.helperText}>
          Works with AllRecipes, Serious Eats, and most major recipe sites.
        </Text>

        <View style={styles.buttonWrap}>
          <Button
            label="Import Recipe"
            variant="primary"
            disabled={importDisabled}
            onPress={handleImport}
          />
        </View>
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
  urlInput: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[3],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  urlInputInvalid: {
    borderColor: Colors.terracotta[400],
  },
  errorText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[2],
  },
  helperText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
    marginTop: Spacing[2],
  },
  buttonWrap: {
    marginTop: Spacing[5],
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
