import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

// WS5-5R — Stub destination for "Cook Now" / "Start Prep & Cook"
// surfaces. Pattern mirrors app/upgrade.tsx exactly so the two
// coming-soon stubs feel like a single design system. The Prep &
// Cook Hub workstream (post-WS6 AI orchestration) will replace this
// page with the real step-sequencing UI.
export default function PrepCook() {
  const router = useRouter();

  return (
    <View style={s.bg}>
      <Header showBack title="Prep & Cook" />
      <Screen>
        <View style={s.card}>
          <View style={s.iconWrap}>
            <Feather name="zap" size={32} color={Colors.sage[700]} />
          </View>
          <Text style={s.heading}>
            <Text style={s.headingItalic}>Coming with Prep & Cook Hub</Text>
            {" "}— step-by-step cooking
          </Text>
          <Text style={s.body}>
            Step-by-step cooking guidance with parallel-task sequencing
            lands in a dedicated workstream.
          </Text>
          <Text style={s.bodyMuted}>
            For now, your meal recipes are saved and ready to cook from —
            open any meal or dish to see ingredients and steps.
          </Text>
          <View style={s.actions}>
            <Button label="Back" variant="ghost" onPress={() => router.back()} />
          </View>
        </View>
      </Screen>
    </View>
  );
}

const s = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: Colors.neutral[100],
  },
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
  },
  body: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    textAlign: "center",
    lineHeight: 22,
    fontFamily: Typography.face.sans[400],
    paddingHorizontal: Spacing[2],
  },
  bodyMuted: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    textAlign: "center",
    lineHeight: 20,
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    paddingHorizontal: Spacing[2],
    marginTop: Spacing[1],
  },
  actions: {
    width: "100%",
    marginTop: Spacing[4],
  },
});
