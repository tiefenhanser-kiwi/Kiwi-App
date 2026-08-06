// WS9 3f-4 (Thread A) — the prop-driven Ask-Kiwi creator.
//
// Extracted from app/ask-kiwi.tsx so the ONE-SHOT Mode-A creator (free text →
// one parsed meal → one draft pushed to the Meal Builder) can mount inline in
// the SwapMealSheet, turning "back out, compost the meal, re-add" into a
// designed in-sheet path. The screen (app/ask-kiwi.tsx) and the sheet both wrap
// this with their own chrome and supply the navigation as callbacks.
//
// ⚠️ ONE-SHOT return contract (RULED). parseMeal → { meal } (singular),
// runAskKiwiSubmit → one draft. There is NO 3–5 candidate list; do not add one.
//
// Router-free by construction: every navigation is an injected callback, so the
// same component serves the standalone route (router-backed props) and the
// sheet (importEntryParams-threaded props that complete a REPLACE swap).

import React, { useState } from "react";
import { ActivityIndicator, Keyboard, StyleSheet, Text, View } from "react-native";

import { AskKiwiView, ASK_KIWI_SERVINGS_DEFAULT } from "@/components/AskKiwiView";
import { Colors, Spacing, Typography } from "@/constants/tokens";
import { parseMeal as realParseMeal } from "@/lib/api/builder";
import {
  runAskKiwiSubmit,
  type AskKiwiSubmitDeps,
} from "@/lib/builder/askKiwiSubmit";

export interface AskKiwiCreatorProps {
  /** Called with the draft JSON on a successful one-shot parse. The host owns
   *  where it lands: the screen pushes /meal-builder with { addToPlanId };
   *  the sheet pushes /meal-builder with the REPLACE params (importEntryParams)
   *  so a save completes the swap (§8.4.2). */
  navigateToDraft: (draftJson: string) => void;
  /** Called on a 402 upgrade-required. */
  routeToUpgrade: () => void;
  /** Injectable for tests; defaults to the real parse-meal API call. */
  parseMeal?: AskKiwiSubmitDeps["parseMeal"];
}

type Phase = "input" | "loading";

export function AskKiwiCreator({
  navigateToDraft,
  routeToUpgrade,
  parseMeal = realParseMeal,
}: AskKiwiCreatorProps) {
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
      { parseMeal, navigateToDraft, routeToUpgrade },
    );

    // Drop back to input regardless: on success the navigation already fired,
    // on upgrade the modal is up, on error we surface the message (text intact).
    setPhase("input");
    if (outcome.status === "error") {
      setErrorMessage(outcome.message);
    }
  };

  if (phase === "loading") {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="large" color={Colors.sage[700]} />
        <Text style={styles.loadingTitle}>Building your meal...</Text>
        <Text style={styles.loadingSubtitle}>
          Kiwi is turning your description into dishes, ingredients, and steps.
        </Text>
      </View>
    );
  }

  return (
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
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: Spacing[8],
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
