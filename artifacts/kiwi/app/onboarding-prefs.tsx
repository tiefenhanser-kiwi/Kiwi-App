import React, { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

const DIETS = ["Vegetarian", "Vegan", "Pescatarian", "Keto", "Gluten-free", "Dairy-free"];
const CUISINES = ["Mediterranean", "Asian", "Mexican", "Italian", "American", "Indian", "Middle Eastern"];
const ALLERGY_OPTIONS = ["Peanuts", "Tree nuts", "Shellfish", "Eggs", "Soy", "Wheat"];

export default function OnboardingPrefs() {
  const router = useRouter();
  const { prefs, setPrefs, setOnboardingComplete } = useApp();

  const [household, setHousehold] = useState(String(prefs.household));
  const [diet, setDiet] = useState<string[]>(prefs.diet);
  const [cuisines, setCuisines] = useState<string[]>(prefs.cuisines);
  const [allergies, setAllergies] = useState<string[]>(prefs.allergies);
  const [skill, setSkill] = useState<"beginner" | "intermediate" | "advanced">(
    prefs.cookSkill,
  );

  const toggle = (
    list: string[],
    setter: (v: string[]) => void,
    value: string,
  ) => {
    setter(
      list.includes(value) ? list.filter((x) => x !== value) : [...list, value],
    );
  };

  const handleContinue = async () => {
    await setPrefs({
      ...prefs,
      household: Math.max(1, parseInt(household, 10) || 1),
      diet,
      cuisines,
      allergies,
      cookSkill: skill,
    });
    await setOnboardingComplete(true);
    router.replace("/(tabs)");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Tell Kiwi about you" subtitle="Step 1 of 1" />
      <Screen>
        <Section
          title="How many people are you cooking for?"
          subtitle="We'll scale recipes automatically."
        >
          <TextInput
            style={styles.input}
            keyboardType="number-pad"
            value={household}
            onChangeText={setHousehold}
            maxLength={2}
          />
        </Section>

        <Section title="Any dietary preferences?" subtitle="Optional">
          <View style={styles.chipRow}>
            {DIETS.map((d) => (
              <Chip
                key={d}
                label={d}
                selected={diet.includes(d.toLowerCase())}
                onPress={() => toggle(diet, setDiet, d.toLowerCase())}
              />
            ))}
          </View>
        </Section>

        <Section title="Allergies to avoid?">
          <View style={styles.chipRow}>
            {ALLERGY_OPTIONS.map((a) => (
              <Chip
                key={a}
                label={a}
                selected={allergies.includes(a)}
                onPress={() => toggle(allergies, setAllergies, a)}
              />
            ))}
          </View>
        </Section>

        <Section title="Favorite cuisines">
          <View style={styles.chipRow}>
            {CUISINES.map((c) => (
              <Chip
                key={c}
                label={c}
                selected={cuisines.includes(c)}
                onPress={() => toggle(cuisines, setCuisines, c)}
              />
            ))}
          </View>
        </Section>

        <Section title="How comfortable are you in the kitchen?">
          <View style={styles.chipRow}>
            {(["beginner", "intermediate", "advanced"] as const).map((s) => (
              <Chip
                key={s}
                label={s[0].toUpperCase() + s.slice(1)}
                selected={skill === s}
                onPress={() => setSkill(s)}
              />
            ))}
          </View>
        </Section>

        <View style={{ height: KSpacing.xl }} />
        <Button label="Start cooking" onPress={handleContinue} variant="terra" />
      </Screen>
    </View>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: KSpacing.xxl }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle && <Text style={styles.sectionSub}>{subtitle}</Text>}
      <View style={{ marginTop: KSpacing.md }}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: KType.size.lg,
    fontWeight: "600",
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  sectionSub: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    marginTop: 2,
    fontFamily: "Inter_400Regular",
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  input: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    paddingHorizontal: KSpacing.md,
    paddingVertical: 12,
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    width: 80,
    textAlign: "center",
    fontFamily: "Inter_600SemiBold",
    fontWeight: "600",
  },
});
