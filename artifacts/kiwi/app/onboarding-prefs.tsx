import React, { useState } from "react";
import { Keyboard, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { AllergiesPicker } from "@/components/preference-pickers/AllergiesPicker";
import { CuisinePicker } from "@/components/preference-pickers/CuisinePicker";
import { EatingStylesPicker } from "@/components/preference-pickers/EatingStylesPicker";
import { RecurringItemsPicker } from "@/components/preference-pickers/RecurringItemsPicker";
import { SkillLevelPicker } from "@/components/preference-pickers/SkillLevelPicker";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

type Step2FormState = {
  cuisines: string[];
  eatingStyles: string[];
  allergiesAndAvoidances: string[];
  cookingSkill: "Beginner" | "Intermediate" | "Advanced";
  recurringGroceryItems: string[];
};

export default function OnboardingPrefs() {
  const router = useRouter();

  const [form, setForm] = useState<Step2FormState>({
    cuisines: [],
    eatingStyles: [],
    allergiesAndAvoidances: [],
    cookingSkill: "Intermediate",
    recurringGroceryItems: [],
  });

  const update = <K extends keyof Step2FormState>(
    key: K,
    value: Step2FormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleContinue = () => {
    Keyboard.dismiss();
    // Per WS5 plan: partial save is log-only; full persistence at step 3.
    // Inter-screen state is not threaded through — see WS5-fix-firstrun-2
    // notes for the WS7 follow-up.
    console.log("[onboarding-step-2] save", form);
    router.push("/onboarding-tellkiwi");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header showBack title="Set your preferences" subtitle="Step 2 of 3" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Section
          title="Cuisines you'd like"
          subtitle="Pick a few — Kiwi mixes from these"
        >
          <CuisinePicker
            value={form.cuisines}
            onChange={(next) => update("cuisines", next)}
          />
        </Section>

        <Section title="Dietary preferences">
          <Text style={s.subLabel}>Eating styles</Text>
          <EatingStylesPicker
            value={form.eatingStyles}
            onChange={(next) => update("eatingStyles", next)}
          />

          <Text style={[s.subLabel, { marginTop: KSpacing.lg }]}>
            Allergies & avoidances
          </Text>
          <AllergiesPicker
            value={form.allergiesAndAvoidances}
            onChange={(next) => update("allergiesAndAvoidances", next)}
          />
        </Section>

        <Section
          title="Cooking skill"
          subtitle="Helps Kiwi suggest recipes at the right level"
        >
          <SkillLevelPicker
            value={form.cookingSkill}
            onChange={(next) => update("cookingSkill", next)}
          />
        </Section>

        <Section
          title="Recurring grocery items"
          subtitle="Things you always need from the store"
        >
          <RecurringItemsPicker
            value={form.recurringGroceryItems}
            onChange={(next) => update("recurringGroceryItems", next)}
            commonItemsLabel="Anything you always need from the store?"
          />
        </Section>

        <View style={s.footer}>
          <Button label="Continue" variant="terra" onPress={handleContinue} />
          <Text style={s.footerHint}>
            Saves your preferences and continues to step 3
          </Text>
        </View>
      </KeyboardAwareScrollViewCompat>
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
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      {subtitle && <Text style={s.cardSubtitle}>{subtitle}</Text>}
      <View style={{ marginTop: KSpacing.md }}>{children}</View>
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
  card: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
  },
  cardTitle: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  cardSubtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  subLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
  },
  footer: {
    marginTop: KSpacing.lg,
    gap: KSpacing.sm,
    alignItems: "center",
  },
  footerHint: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
});
