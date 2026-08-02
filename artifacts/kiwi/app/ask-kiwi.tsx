// WS7-6 G1 — Mode A "Ask Kiwi" / "Tell Kiwi what you want" input screen.
//
// PRD §10.5.1: the user describes a meal in free text ("Chicken piccata with a
// side arugula salad and lemon vinaigrette"); Kiwi parses it into a structured
// meal, which the user then reviews + edits in the Meal Builder before saving.
//
// Landing pattern MIRRORS Import-from-Text (PRD §10.4b, the shipped sibling):
// input screen → AI parse call → router.push("/meal-builder", { draftJson })
// with the parsed result encoded as a DraftMeal. The whole screen swaps to a
// loading state during the parse (a real multi-second AI call), same as
// import-text.
//
// The submit logic lives in lib/builder/askKiwiSubmit and the presentational
// body in components/AskKiwiView — both unit-testable without expo-router or
// the apiClient (Block 4 container/view precedent).

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
import { Colors, Spacing, Typography } from "@/constants/tokens";
import { parseMeal } from "@/lib/api/builder";
import { runAskKiwiSubmit } from "@/lib/builder/askKiwiSubmit";

type Phase = "input" | "loading";

export default function AskKiwiScreen() {
  const router = useRouter();
  const { addToPlanId } = useLocalSearchParams<{ addToPlanId?: string }>();
  const [text, setText] = useState("");
  const [servings, setServings] = useState(ASK_KIWI_SERVINGS_DEFAULT);
  const [phase, setPhase] = useState<Phase>("input");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const submitDisabled = text.trim().length === 0;

  const handleSubmit = async () => {
    if (submitDisabled) return;
    Keyboard.dismiss();
    setErrorMessage(null);
    setPhase("loading");

    const outcome = await runAskKiwiSubmit(
      { freeText: text, servings },
      {
        parseMeal,
        navigateToDraft: (draftJson) => {
          router.push({
            pathname: "/meal-builder",
            params: {
              draftSource: "text",
              draftJson,
              ...(addToPlanId ? { addToPlanId } : {}),
            },
          });
        },
        routeToUpgrade: () => router.push("/upgrade"),
      },
    );

    // Whatever the outcome, drop back to the input phase so the user's typed
    // text stays editable. On success the meal-builder push already happened;
    // on upgrade the modal is up; on error we surface the message (input
    // intact — we never clear `text`).
    setPhase("input");
    if (outcome.status === "error") {
      setErrorMessage(outcome.message);
    }
  };

  if (phase === "loading") {
    return (
      <View style={styles.bg}>
        <Header title="Ask Kiwi for a meal" />
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={Colors.sage[700]} />
          <Text style={styles.loadingTitle}>Building your meal...</Text>
          <Text style={styles.loadingSubtitle}>
            Kiwi is turning your description into dishes, ingredients, and steps.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.bg}>
      <Header showBack title="Ask Kiwi for a meal" />
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
        />
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
