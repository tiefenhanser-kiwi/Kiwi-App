import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { defaultPlan, RECIPES } from "@/lib/mockData";
import { newId } from "@/lib/storage";

const SUGGESTIONS = [
  "Quick weeknight dinners under 30 minutes",
  "Mediterranean meals with lots of vegetables",
  "Kid-friendly week, easy on the spice",
  "I have salmon and chickpeas — plan around them",
];

export default function TellKiwi() {
  const router = useRouter();
  const { savePlan } = useApp();
  const [text, setText] = useState("");
  const [building, setBuilding] = useState(false);

  const submit = async (raw?: string) => {
    const prompt = (raw ?? text).trim();
    if (!prompt) return;
    setBuilding(true);
    // When Anthropic key is wired: POST /api/plans/from-prompt { text: prompt }
    const plan = defaultPlan();
    plan.id = newId();
    plan.name = prompt.length > 40 ? prompt.slice(0, 40) + "…" : prompt;
    plan.meals = plan.meals.map((m, i) => ({
      ...m,
      recipeId: RECIPES[i % RECIPES.length].id,
    }));
    await savePlan(plan);
    setBuilding(false);
    router.replace({ pathname: "/plan-results", params: { id: plan.id } });
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Tell Kiwi" subtitle="Describe what you want" showBack />
      <Screen>
        <Text style={s.label}>What's on your mind this week?</Text>
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
              onPress={() => submit(sug)}
              style={({ pressed }) => [s.sug, pressed && { opacity: 0.7 }]}
            >
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
    backgroundColor: KColors.neutral[0],
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    borderRadius: KRadius.lg,
    padding: KSpacing.md,
  },
  sugText: {
    color: KColors.neutral[800],
    fontSize: KType.size.md,
    fontFamily: "Inter_400Regular",
  },
});
