import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

// WS7-8b Block 2 — TEMPORARY stub for the single-meal Cook session.
//
// The Prep & Cook Hub (app/prep-cook.tsx) took over the old /prep-cook stub
// route, so the meal-context "Cook Now" surfaces and the Hub's own meal-row
// taps need a destination that ISN'T the week Hub. This is that placeholder.
//
// Block 3 (D-WS7 Cook session) REPLACES this file with the real step-sequencing
// UI. It already receives `mealId` / `planItemId` (and `mode=prep-week` from the
// Hub's "Prep the Week" lane, which Block 4 reroutes to real Week Prep) so the
// param contract is forward-compatible. Do not build real cooking logic here.
export default function CookSession() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    mealId?: string;
    planItemId?: string;
    dishId?: string;
    mode?: string;
  }>();

  const isPrepWeek = params.mode === "prep-week";
  const title = isPrepWeek ? "Prep the Week" : "Cook";
  const heading = isPrepWeek
    ? "Week Prep is coming next"
    : "Step-by-step cooking is coming next";
  const body = isPrepWeek
    ? "The guided Week Prep flow — combined chopping, marinades and make-ahead steps — lands in an upcoming step."
    : "The single-meal Cook session with parallel-task sequencing lands in the next step. Your recipe and steps are saved and ready in the meantime.";

  return (
    <View style={s.bg}>
      <Header showBack title={title} />
      <Screen>
        <View style={s.card}>
          <View style={s.iconWrap}>
            <Feather
              name={isPrepWeek ? "check-square" : "zap"}
              size={32}
              color={Colors.sage[700]}
            />
          </View>
          <Text style={s.heading}>
            <Text style={s.headingItalic}>Coming in the next step</Text>
          </Text>
          <Text style={s.subheading}>{heading}</Text>
          <Text style={s.body}>{body}</Text>
          <View style={s.actions}>
            <Button label="Back" variant="ghost" onPress={() => router.back()} />
          </View>
        </View>
      </Screen>
    </View>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.neutral[100] },
  card: {
    marginTop: Spacing[5],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Palette.border.default,
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[6],
    alignItems: "center",
    gap: Spacing[3],
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.sage[50],
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing[2],
  },
  heading: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  headingItalic: {
    fontStyle: "italic",
    color: Colors.terracotta[400],
    fontFamily: Typography.face.serifItalic[600],
  },
  subheading: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    textAlign: "center",
    fontFamily: Typography.face.sans[600],
  },
  body: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    textAlign: "center",
    lineHeight: 22,
    fontFamily: Typography.face.sans[400],
    paddingHorizontal: Spacing[2],
  },
  actions: { width: "100%", marginTop: Spacing[4] },
});
