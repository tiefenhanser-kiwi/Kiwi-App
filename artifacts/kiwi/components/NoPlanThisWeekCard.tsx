// FIX-3 / BUG-118 — Home's lead when the user HAS plans but none is this week.
//
// Before this, that state showed the make lane and the rail and nothing that
// pointed back at the plans the user already has. Hans's card: "no plans marked
// for this week, go to Plans, check out featured, or have kiwi cook something
// up". The copy is chat-Claude's draft of it.
//
// ⚠️ IN components/ AND NOT INLINE IN app/(tabs)/index.tsx FOR THE SAME REASON AS
// HomeErrorState: app/** is outside the test glob, and the copy is pinned by a
// test against hard-coded literals.
//
// Built from the shared primitives only — Card (the app's card shell), Button
// and SectionLabel — with HomeErrorState's title/body type treatment. No new
// tokens.

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { SectionLabel } from "@/components/SectionLabel";
import { Colors, Spacing, Typography } from "@/constants/tokens";

export const NO_PLAN_TITLE = "No plan for this week yet";
export const NO_PLAN_BODY =
  "Pick one of your plans, try a featured plan, or have Kiwi cook something up.";
export const NO_PLAN_GO_TO_PLANS = "Go to Plans";
export const NO_PLAN_SEE_FEATURED = "See featured";
export const NO_PLAN_COOK_UP = "Cook something up";

export function NoPlanThisWeekCard({
  onGoToPlans,
  onSeeFeatured,
  onCookSomethingUp,
}: {
  onGoToPlans: () => void;
  onSeeFeatured: () => void;
  onCookSomethingUp: () => void;
}) {
  return (
    <View testID="home-no-plan-this-week">
      {/* The same eyebrow the this-week module carries: this card holds that
          slot when there is no plan to fill it. */}
      <SectionLabel label="this week" first />
      <Card>
        <Text style={s.title}>{NO_PLAN_TITLE}</Text>
        <Text style={s.body}>{NO_PLAN_BODY}</Text>
        <View style={s.actions}>
          <Button
            label={NO_PLAN_GO_TO_PLANS}
            onPress={onGoToPlans}
            testID="home-no-plan-go-to-plans"
          />
          <Button
            label={NO_PLAN_SEE_FEATURED}
            variant="secondary"
            onPress={onSeeFeatured}
            testID="home-no-plan-see-featured"
          />
          <Button
            label={NO_PLAN_COOK_UP}
            variant="secondary"
            onPress={onCookSomethingUp}
            testID="home-no-plan-cook-up"
          />
        </View>
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
  actions: { marginTop: Spacing[3], gap: Spacing[2] },
});
