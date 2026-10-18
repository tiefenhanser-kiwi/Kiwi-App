// FIX-3 / BUG-118 — Home's lead when the user HAS plans but none is this week.
//
// Before this, that state showed the make lane and the rail and nothing that
// pointed back at the plans the user already has. Hans's card: "no plans marked
// for this week, go to Plans, check out featured, or have kiwi cook something
// up".
//
// FIX-5 — A MESSAGE, NOT A MENU. Hans on the Pixel: "it should be more of a CTA
// and less click-action. like a user can do the kiwi green box in the home
// screen, they can see the featured in the home screen, they can click to see
// plans from the home screen." The three buttons are gone: every path the body
// names is already on Home right below the card (the make lane, the featured
// rail, the Plans tab). The copy is Hans's.
//
// ⚠️ IN components/ AND NOT INLINE IN app/(tabs)/index.tsx FOR THE SAME REASON AS
// HomeErrorState: app/** is outside the test glob, and the copy is pinned by a
// test against hard-coded literals.
//
// Built from the shared primitives only — Card (the app's card shell) and
// SectionLabel — with HomeErrorState's title/body type treatment. No new
// tokens.

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { SectionLabel } from "@/components/SectionLabel";
import { Colors, Spacing, Typography } from "@/constants/tokens";

export const NO_PLAN_TITLE = "No plan set for this week yet";
export const NO_PLAN_BODY =
  "Get a plan in seconds with Kiwi, choose a Featured Plan, or use one of your saved plans.";

export function NoPlanThisWeekCard() {
  return (
    <View testID="home-no-plan-this-week">
      {/* The same eyebrow the this-week module carries: this card holds that
          slot when there is no plan to fill it. */}
      <SectionLabel label="this week" first />
      <Card>
        <Text style={s.title}>{NO_PLAN_TITLE}</Text>
        <Text style={s.body}>{NO_PLAN_BODY}</Text>
      </Card>
    </View>
  );
}

const s = StyleSheet.create({
  // HomeErrorState's title and body, left-aligned like the this-week card.
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
    marginTop: Spacing[1],
    lineHeight: 18,
  },
});
