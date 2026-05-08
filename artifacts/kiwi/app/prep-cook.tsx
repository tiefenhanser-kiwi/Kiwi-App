import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";

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
            <Feather name="zap" size={32} color={KColors.sage[700]} />
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
    backgroundColor: KColors.neutral[100],
  },
  card: {
    marginTop: KSpacing.xl,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.xl,
    borderWidth: 1,
    borderColor: KPalette.border.default,
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.xxl,
    alignItems: "center",
    gap: KSpacing.md,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: KColors.sage[50],
    alignItems: "center",
    justifyContent: "center",
    marginBottom: KSpacing.sm,
  },
  heading: {
    fontSize: KType.size.xl,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  headingItalic: {
    fontStyle: "italic",
    color: KColors.terracotta[400],
  },
  body: {
    fontSize: KType.size.md,
    color: KColors.neutral[800],
    textAlign: "center",
    lineHeight: 22,
    fontFamily: "Inter_400Regular",
    paddingHorizontal: KSpacing.sm,
  },
  bodyMuted: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    textAlign: "center",
    lineHeight: 20,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    paddingHorizontal: KSpacing.sm,
    marginTop: KSpacing.xs,
  },
  actions: {
    width: "100%",
    marginTop: KSpacing.lg,
  },
});
