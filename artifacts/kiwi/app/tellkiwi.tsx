import React, { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getMondayISO, MealPlan } from "@/lib/mockData";
import { newId } from "@/lib/storage";
import { generatePlan } from "@/lib/api";

const SUGGESTIONS = [
  "Quick weeknight dinners under 30 minutes",
  "Mediterranean meals with lots of vegetables",
  "Kid-friendly week, easy on the spice",
  "Use what's already in my pantry",
];

export default function TellKiwi() {
  const router = useRouter();
  const { savePlan, prefs, pantry } = useApp();
  const [text, setText] = useState("");
  const [building, setBuilding] = useState(false);

  const submit = async (raw?: string) => {
    const prompt = (raw ?? text).trim();
    if (!prompt) return;
    setBuilding(true);
    try {
      const result = await generatePlan({
        prompt,
        nights: 5,
        prefs,
        pantry,
      });
      const plan: MealPlan = {
        id: newId(),
        name:
          result.name ||
          (prompt.length > 40 ? prompt.slice(0, 40) + "…" : prompt),
        notes: result.notes,
        createdAt: Date.now(),
        weekStart: getMondayISO(),
        meals: result.meals,
      };
      await savePlan(plan);
      router.replace({ pathname: "/plan-results", params: { id: plan.id } });
    } catch (err: any) {
      Alert.alert(
        "Couldn't reach Kiwi",
        err?.message || "Try again in a moment.",
      );
    } finally {
      setBuilding(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Tell Kiwi" subtitle="Describe what you want" showBack />
      <Screen>
        <View style={s.intro}>
          <Feather name="message-circle" size={20} color={KColors.terracotta[400]} />
          <Text style={s.introText}>
            Just type what's on your mind — Kiwi reads your preferences and
            pantry, then builds a plan that fits.
          </Text>
        </View>

        <Text style={s.label}>What's this week looking like?</Text>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="e.g. Plan me 4 quick dinners that use what's already in my fridge…"
          placeholderTextColor={KColors.neutral[600]}
          multiline
          style={s.input}
        />

        <Text style={s.subLabel}>Need a starting point?</Text>
        <View style={{ gap: KSpacing.sm }}>
          {SUGGESTIONS.map((sug) => (
            <Pressable
              key={sug}
              onPress={() => {
                setText(sug);
              }}
              style={({ pressed }) => [s.sug, pressed && { opacity: 0.7 }]}
            >
              <Feather
                name="arrow-up-left"
                size={14}
                color={KColors.sage[600]}
              />
              <Text style={s.sugText}>{sug}</Text>
            </Pressable>
          ))}
        </View>

        <View style={{ height: KSpacing.xl }} />
        <Button
          label={building ? "Kiwi is thinking…" : "Cook up a plan"}
          variant="terra"
          onPress={() => submit()}
          loading={building}
          disabled={text.trim().length === 0}
        />
      </Screen>
    </View>
  );
}

const s = StyleSheet.create({
  intro: {
    flexDirection: "row",
    gap: KSpacing.sm,
    backgroundColor: KColors.terracotta[50],
    borderColor: KColors.terracotta[200],
    borderWidth: 1,
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    marginBottom: KSpacing.xl,
  },
  introText: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    lineHeight: 20,
    fontFamily: "Inter_400Regular",
  },
  label: {
    fontSize: KType.size.lg,
    fontWeight: "600",
    color: KColors.neutral[900],
    marginBottom: KSpacing.sm,
    fontFamily: "Inter_600SemiBold",
  },
  subLabel: {
    fontSize: KType.size.sm,
    fontWeight: "600",
    color: KColors.sage[600],
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginTop: KSpacing.xl,
    marginBottom: KSpacing.sm,
    fontFamily: "Inter_600SemiBold",
  },
  input: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    minHeight: 120,
    textAlignVertical: "top",
    fontFamily: "Inter_400Regular",
  },
  sug: {
    flexDirection: "row",
    gap: KSpacing.sm,
    alignItems: "center",
    backgroundColor: KColors.neutral[0],
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
  },
  sugText: {
    flex: 1,
    color: KColors.neutral[800],
    fontSize: KType.size.md,
    fontFamily: "Inter_400Regular",
  },
});
