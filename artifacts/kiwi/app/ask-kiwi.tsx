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

import React from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { AskKiwiCreator } from "@/components/AskKiwiCreator";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Colors, Spacing } from "@/constants/tokens";

// WS9 3f-4 (Thread A) — thin router-backed wrapper over the shared, prop-driven
// AskKiwiCreator. The standalone /ask-kiwi route is unchanged in behavior:
// success pushes /meal-builder with { draftSource, draftJson, addToPlanId? }
// (the APPEND context), exactly as before the extraction. The loading state now
// renders inside the creator (below this screen's Header) instead of replacing
// the whole body — a deliberate, minor cosmetic change.
export default function AskKiwiScreen() {
  const router = useRouter();
  const { addToPlanId } = useLocalSearchParams<{ addToPlanId?: string }>();

  return (
    <View style={styles.bg}>
      <Header showBack title="Ask Kiwi for a meal" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <AskKiwiCreator
          navigateToDraft={(draftJson) => {
            router.push({
              pathname: "/meal-builder",
              params: {
                draftSource: "text",
                draftJson,
                ...(addToPlanId ? { addToPlanId } : {}),
              },
            });
          }}
          routeToUpgrade={() => router.push("/upgrade")}
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
});
