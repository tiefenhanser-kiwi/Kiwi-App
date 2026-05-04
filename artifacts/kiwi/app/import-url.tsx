import React, { useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getDraftMealForUrl } from "@/lib/stubs";

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
  const [phase, setPhase] = useState<Phase>("input");
  const [url, setUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Disable button only on empty input. We let handleImport surface a
  // visible error message for genuinely invalid (non-URL) text — the
  // previous behavior left users with a silently disabled button.
  const importDisabled = url.trim().length === 0;

  const handleImport = () => {
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
    // Stub: simulate WS6 AI parse with 1500ms delay
    setTimeout(() => {
      const draft = getDraftMealForUrl(normalized);
      router.push({
        pathname: "/meal-builder",
        params: {
          draftSource: "url",
          draftJson: JSON.stringify(draft),
        },
      });
      // Reset phase so screen is fresh if user comes back via back nav
      setPhase("input");
    }, 1500);
  };

  if (phase === "loading") {
    return (
      <View style={styles.bg}>
        <Header title="Import from URL" />
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={KColors.sage[700]} />
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
          placeholderTextColor={KColors.neutral[600]}
          style={[styles.urlInput, errorMessage && styles.urlInputInvalid]}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={handleImport}
        />

        {errorMessage && <Text style={styles.errorText}>{errorMessage}</Text>}

        <Text style={styles.helperText}>
          Works with AllRecipes, Food Network, NYT Cooking, Serious Eats, and
          most major recipe sites.
        </Text>

        <View style={styles.buttonWrap}>
          <Button
            label="Import recipe"
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
  urlInput: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.md,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  urlInputInvalid: {
    borderColor: KColors.terracotta[400],
  },
  errorText: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.sm,
  },
  helperText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
    marginTop: KSpacing.sm,
  },
  buttonWrap: {
    marginTop: KSpacing.xl,
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
