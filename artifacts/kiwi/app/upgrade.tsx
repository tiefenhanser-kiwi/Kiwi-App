import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";

export default function Upgrade() {
  const router = useRouter();

  return (
    <View style={s.bg}>
      <Header showBack title="Upgrade to Premium" />
      <Screen>
        <View style={s.card}>
          <View style={s.iconWrap}>
            <Feather name="credit-card" size={32} color={KColors.sage[700]} />
          </View>
          <Text style={s.heading}>
            <Text style={s.headingItalic}>Coming in WS6</Text> — Stripe
            integration
          </Text>
          <Text style={s.body}>
            Subscription management requires the Stripe Customer Portal. We're
            wiring this up in our next development workstream.
          </Text>
          <Text style={s.bodyMuted}>
            For now, you have full access to all premium features during your
            trial.
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
