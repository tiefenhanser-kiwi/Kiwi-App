// The refine-or-Tell-Kiwi card — shown when a generate surface has run out of
// options: the Pick screen when the shelf is exhausted (Block 2a/2b, hasMore
// false) and the plan-options screen after the fourth "Get another plan option"
// (D-WS9-191 — Hans: "4 presses = refine or tell kiwi"). Lifted out of
// PickMealsScreen.tsx so both screens render ONE card with ONE pair of exits.
//
// The exits go BACK to the wizard already on the stack (Block 2b Part D ruling,
// 2a CANDIDATE-4: no stack growth). dismissTo pops to the route when it is on
// the stack and pushes it otherwise (e.g. "Tell Kiwi" from a prefs-mode run,
// where /tellkiwi was never mounted). The params reach the mounted screen live;
// `nonce` changes each time so the same "1" re-fires.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

// Copy — verbatim from the locked mockups (the Pick screen's card).
export const EXHAUSTED_TITLE = "Not many meals fit your preferences and restrictions.";
export const EXHAUSTED_BODY = "Refine them for this plan, or tell Kiwi what you're after.";
export const EXHAUSTED_REFINE = "Refine preferences";
export const EXHAUSTED_TELL = "Tell Kiwi";

interface Props {
  /** Defaults to the Pick screen's line; the plan-options screen says "plans". */
  title?: string;
  body?: string;
}

export function ExhaustedCard({ title = EXHAUSTED_TITLE, body = EXHAUSTED_BODY }: Props) {
  const router = useRouter();
  const handleRefine = () =>
    router.dismissTo({
      pathname: "/wizard",
      params: { adjust: "1", nonce: String(Date.now()) },
    });
  const handleTellKiwi = () =>
    router.dismissTo({
      pathname: "/tellkiwi",
      params: { focus: "1", nonce: String(Date.now()) },
    });

  return (
    <View style={s.card}>
      <Text style={s.title}>{title}</Text>
      <Text style={s.body}>{body}</Text>
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Button label={EXHAUSTED_REFINE} variant="ghost" onPress={handleRefine} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label={EXHAUSTED_TELL} variant="ghost" onPress={handleTellKiwi} />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[4],
    gap: Spacing[2],
  },
  title: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  body: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  row: {
    flexDirection: "row",
    gap: Spacing[2],
    marginTop: Spacing[1],
  },
});
