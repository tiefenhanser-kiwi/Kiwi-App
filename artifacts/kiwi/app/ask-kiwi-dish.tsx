// WS7-6 G2 — Dish Mode A "Ask Kiwi" input screen (the dish twin of
// app/ask-kiwi.tsx). PRD §10.5.8: dishes work the same way as meals, including
// type-in-text. The user describes a single dish in free text; Kiwi parses it
// into a structured dish, which the user reviews + edits in the Dish Builder
// before saving.
//
// Landing pattern mirrors app/ask-kiwi.tsx: input screen → AI parse call →
// router.push("/dish-builder", { draftJson }) with the parsed result encoded
// as a DraftDish. The whole screen swaps to a loading state during the parse.
//
// Reached two ways: (1) directly as a route, or (2) from the Meal Builder's
// "Add a dish" sheet Ask-Kiwi card, which seeds the `prompt` param. The submit
// logic lives in lib/builder/askKiwiDishSubmit; the presentational body reuses
// components/AskKiwiView with dish-shaped copy.

import React, { useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import {
  AskKiwiView,
  ASK_KIWI_SERVINGS_DEFAULT,
} from "@/components/AskKiwiView";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { KColors, KSpacing, KType } from "@/constants/tokens";
import { parseDish } from "@/lib/api/builder";
import { runAskKiwiDishSubmit } from "@/lib/builder/askKiwiDishSubmit";
import { deliverDishToBuilder } from "@/lib/builder/dishHandoff";
import type { DraftDish } from "@/lib/builder/parsedDishToDraft";

type Phase = "input" | "loading";

export default function AskKiwiDishScreen() {
  const router = useRouter();
  // `prompt` is an optional seed (unused now the sheet card carries no text).
  // `returnToMeal` is set when the Meal Builder launched this flow: on success
  // the parsed dish is handed back to that builder and we pop, rather than
  // pushing the standalone Dish Builder.
  const { prompt, returnToMeal } = useLocalSearchParams<{
    prompt?: string;
    returnToMeal?: string;
  }>();
  const [text, setText] = useState(prompt ?? "");
  const [servings, setServings] = useState(ASK_KIWI_SERVINGS_DEFAULT);
  const [phase, setPhase] = useState<Phase>("input");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const submitDisabled = text.trim().length === 0;

  const handleSubmit = async () => {
    if (submitDisabled) return;
    Keyboard.dismiss();
    setErrorMessage(null);
    setPhase("loading");

    const outcome = await runAskKiwiDishSubmit(
      { freeText: text, servings },
      {
        parseDish,
        navigateToDraft: (draftJson) => {
          // WS7-6 G3-fix — Meal Builder context: hand the parsed dish back to
          // the builder (still mounted beneath this screen) and pop, so the
          // dish lands ON the meal under construction. Fall back to the
          // standalone Dish Builder if the handoff was cleared or the json is
          // malformed, so the user's draft is never lost.
          if (returnToMeal) {
            try {
              const draft = JSON.parse(draftJson) as DraftDish;
              if (deliverDishToBuilder(draft)) {
                router.back();
                return;
              }
            } catch {
              // fall through to the standalone builder
            }
          }
          router.push({
            pathname: "/dish-builder",
            params: { draftJson },
          });
        },
        routeToUpgrade: () => router.push("/upgrade"),
      },
    );

    // Whatever the outcome, drop back to the input phase so the user's typed
    // text stays editable. On success the dish-builder push already happened.
    setPhase("input");
    if (outcome.status === "error") {
      setErrorMessage(outcome.message);
    }
  };

  if (phase === "loading") {
    return (
      <View style={styles.bg}>
        <Header title="Tell Kiwi about your dish" />
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={KColors.sage[700]} />
          <Text style={styles.loadingTitle}>Building your dish...</Text>
          <Text style={styles.loadingSubtitle}>
            Kiwi is turning your description into ingredients and steps.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.bg}>
      <Header showBack title="Tell Kiwi about your dish" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <AskKiwiView
          text={text}
          onChangeText={(v) => {
            setText(v);
            if (errorMessage) setErrorMessage(null);
          }}
          servings={servings}
          onServingsChange={setServings}
          submitDisabled={submitDisabled}
          onSubmit={handleSubmit}
          errorMessage={errorMessage}
          title="Tell Kiwi about your dish"
          subtitle="Describe one dish in your own words — Kiwi will turn it into ingredients and steps you can review and edit."
          placeholder="e.g. Roasted broccoli with garlic and lemon"
          helperText="Premium · Kiwi reads your description and drafts a single dish. You can change anything before saving."
        />
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
