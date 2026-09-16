// /pick-meals — "Pick your meals" (WS9 Redesign Arc Block 2a Part D, D-WS9-237).
//
// Route name follows the kebab-case sibling screens (wizard-results,
// meal-builder, prep-cook). Fed by the merged wizard's path A: the shelf
// response and the request body travel as JSON route params (the same idiom
// wizard-results uses for tellKiwiResult). The screen is
// components/PickMealsScreen.tsx so the test glob reaches it; this file parses
// the params and mounts it. Unparseable params → a recoverable error, never a
// dead screen.

import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { PickMealsScreen, PlaylistPickScreen } from "@/components/PickMealsScreen";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  parsePickMealsParams,
  type PickMealsRouteParams,
} from "@/lib/wizard/pickMeals";

export default function PickMeals() {
  const router = useRouter();
  const raw = useLocalSearchParams<PickMealsRouteParams & { source?: string }>();
  const parsed = useMemo(() => parsePickMealsParams(raw), [raw]);

  // WS9 Redesign Arc Block 2b — the Playlist tab's "Plan a week from these"
  // arrives with only `source=playlist`; the loader fetches its own shelf.
  if (raw.source === "playlist") {
    return <PlaylistPickScreen />;
  }

  if (!parsed) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title="Pick your meals" />
        <View style={s.statusBox}>
          <Text style={s.errorTitle}>Kiwi got distracted. Try again?</Text>
          <Text style={s.errorBody}>
            The meal list wasn&apos;t passed through. Head back to the wizard
            and resubmit.
          </Text>
          <View style={{ marginTop: Spacing[3] }}>
            <Button label="Back to wizard" variant="primary" onPress={() => router.back()} />
          </View>
        </View>
      </View>
    );
  }

  return <PickMealsScreen {...parsed} />;
}

const s = StyleSheet.create({
  statusBox: {
    margin: Spacing[4],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[2],
  },
  errorTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  errorBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
});
