import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { patchProfile } from "@/lib/api/me";
import type { User } from "@/lib/types";

// WS7-2 Block C (D-WS7-020): the one-time three-choice screen shown once,
// after onboarding completes, before the user reaches home. Each choice
// flips firstRunChoiceMade → true (so the routing state machine advances)
// then navigates. There is intentionally no back/cancel — the screen is
// mandatory exactly once; the routing state machine (index.tsx) re-surfaces
// it on next launch only if firstRunChoiceMade never persisted.

type Destination = "/tellkiwi" | "/wizard" | "/(tabs)";

interface Choice {
  id: string;
  title: string;
  body: string;
  destination: Destination;
  icon: keyof typeof Feather.glyphMap;
}

const CHOICES: Choice[] = [
  {
    id: "tell-kiwi",
    title: "Tell Kiwi what you want",
    body: "Describe what you'd like to cook in your own words.",
    destination: "/tellkiwi",
    icon: "message-circle",
  },
  {
    id: "get-plans",
    title: "Get plan options",
    body: "Answer a few quick questions and Kiwi will build your week.",
    destination: "/wizard",
    icon: "sliders",
  },
  {
    id: "skip",
    title: "Skip for now",
    body: "Take a look around first. You can come back to this anytime.",
    destination: "/(tabs)",
    icon: "compass",
  },
];

export default function FirstRunDestination() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const choose = async (choice: Choice) => {
    if (busy) return;
    setBusy(true);
    try {
      const { user } = await patchProfile({ firstRunChoiceMade: true });
      queryClient.setQueryData<User | null>(["auth", "me"], (prev) =>
        prev ? { ...prev, ...user } : prev,
      );
    } catch (err) {
      // Never trap the user here — log and navigate anyway. If the flag
      // didn't persist, the routing state machine simply shows this screen
      // again on the next cold start.
      console.warn(
        "[first-run-destination] firstRunChoiceMade PATCH failed:",
        err,
      );
    }
    router.replace(choice.destination);
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="You're all set" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.introCard}>
          <Text style={s.introHeading}>Where would you like to start?</Text>
          <Text style={s.introBody}>
            Pick one to get going — you can always do the others later.
          </Text>
        </View>

        {CHOICES.map((choice) => (
          <Pressable
            key={choice.id}
            onPress={() => choose(choice)}
            disabled={busy}
            style={({ pressed }) => [
              s.choiceCard,
              pressed && { opacity: 0.85 },
              busy && { opacity: 0.6 },
            ]}
          >
            <View style={s.choiceIcon}>
              <Feather
                name={choice.icon}
                size={20}
                color={KColors.sage[700]}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.choiceTitle}>{choice.title}</Text>
              <Text style={s.choiceBody}>{choice.body}</Text>
            </View>
            <Feather
              name="chevron-right"
              size={18}
              color={KColors.neutral[600]}
            />
          </Pressable>
        ))}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl * 2,
    gap: KSpacing.md,
  },
  introCard: {
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.lg,
  },
  introHeading: {
    fontSize: KType.size.lg,
    color: KColors.sage[800],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
  },
  introBody: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontFamily: "Inter_400Regular",
    marginTop: 4,
    lineHeight: 18,
  },
  choiceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
  },
  choiceIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: KColors.sage[100],
    alignItems: "center",
    justifyContent: "center",
  },
  choiceTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
  },
  choiceBody: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
    lineHeight: 18,
  },
});
