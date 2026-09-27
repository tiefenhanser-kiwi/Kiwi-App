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
  /**
   * Row 13 "Test Kitchen" · Block 2 Part D (R6) — THE THIN SHELF, this card's
   * third consumer. When the catalog cannot fill every slot of a guest's chosen
   * plan the server refuses before any AI call (`catalog_only_gap`) and the
   * refusal IS the door: Hans's copy, and a SIGN-UP exit instead of the
   * Refine / Tell Kiwi pair.
   *
   * ⚠️ The two default exits are wrong for a guest twice over, which is why this
   * is a replacement and not an addition: "Tell Kiwi" opens /tellkiwi, whose
   * POST /wizard/build-from-text is member-only AND is the AI-invention surface
   * ruled off for guests; "Refine preferences" dismissTo's /wizard, which is not
   * on a guest's stack and whose generate a guest has already spent.
   */
  guestExit?: { label: string; onPress: () => void };
}

export function ExhaustedCard({
  title = EXHAUSTED_TITLE,
  body = EXHAUSTED_BODY,
  guestExit,
}: Props) {
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
      {body ? <Text style={s.body}>{body}</Text> : null}
      {guestExit ? (
        <View style={{ marginTop: Spacing[1] }}>
          <Button
            label={guestExit.label}
            variant="primary"
            onPress={guestExit.onPress}
            testID="exhausted-guest-exit"
          />
        </View>
      ) : (
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Button label={EXHAUSTED_REFINE} variant="ghost" onPress={handleRefine} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={EXHAUSTED_TELL} variant="ghost" onPress={handleTellKiwi} />
          </View>
        </View>
      )}
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
