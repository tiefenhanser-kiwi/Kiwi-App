// Sept 29 design review, item 14 — what Home renders when GET /home fails.
//
// ⚠️ WHAT IT REPLACES IS NOT THE EMPTY STATE. On a failed load React Query
// reports isLoading false and data undefined, so isFirstRun was false,
// deriveHeroModel collapsed to "empty", hasActivePlan was false, and
// homeSectionOrder returned ["makeLane"] — no lead slot, no arc, no explanation.
// That is strictly emptier than EITHER real state (a genuine first run renders
// the teaching arc), and it silently asserted "you have no plan this week",
// which is a wrong statement rather than a missing one.
//
// ⚠️ IT LIVES IN components/ AND NOT INLINE IN app/(tabs)/index.tsx BECAUSE OF
// THE COPY. app/** is outside the test runner's glob (the IngredientsSectionHeading
// precedent: a deliberate break there stayed green), and the three strings below
// are Hans's, verbatim. Exported as constants so the test pins the words rather
// than a paraphrase of them.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Shadow, Spacing, Typography } from "@/constants/tokens";

/** Hans's copy, verbatim. Do not reword without a ruling. */
export const HOME_ERROR_TITLE = "We couldn't reach Kiwi";
export const HOME_ERROR_BODY = "Check your connection and try again.";
export const HOME_ERROR_RETRY = "Try again";

export function HomeErrorState({
  onRetry,
  retrying,
}: {
  /** Refetches GET /home. The screen owns the query; this owns the words. */
  onRetry: () => void;
  /** A refetch in flight — the button goes busy rather than inert. */
  retrying?: boolean;
}) {
  return (
    <View style={s.card} testID="home-error-state">
      <View style={s.iconWrap}>
        {/* cloud-off, not alert-triangle: this is "we could not reach the
            network", not "something is wrong with your data". The user has done
            nothing wrong and the glyph should not imply they have. */}
        <Feather name="cloud-off" size={24} color={Colors.sage[700]} />
      </View>
      {/* role="alert" so the failure is ANNOUNCED, not merely drawn — the same
          reasoning as the sign-in error (item 7). */}
      <Text style={s.title} accessibilityRole="alert">
        {HOME_ERROR_TITLE}
      </Text>
      <Text style={s.body}>{HOME_ERROR_BODY}</Text>
      <View style={s.action}>
        <Button
          label={HOME_ERROR_RETRY}
          variant="secondary"
          onPress={onRetry}
          loading={retrying}
          // Button's own accessibilityLabel default would be swallowed by the
          // spinner while `loading` — item 5's fix means it still announces.
          testID="home-error-retry"
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // The app's card idiom, not a bespoke panel: white on paper, hairline, soft
  // shadow — the same object as every other card on this screen.
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    marginTop: Spacing[4],
    alignItems: "center",
    ...Shadow.card,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: Radius["2xl"],
    backgroundColor: Colors.sage[100],
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing[3],
  },
  title: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  body: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    marginTop: Spacing[1],
    lineHeight: 18,
  },
  // alignSelf "stretch" is deliberately NOT set: a full-width button inside a
  // centred card reads as the screen's primary action, and this is a recovery
  // affordance on a card.
  action: { marginTop: Spacing[3] },
});
