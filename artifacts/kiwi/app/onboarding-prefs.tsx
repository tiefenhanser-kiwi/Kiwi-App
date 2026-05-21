import React, { useState } from "react";
import {
  Keyboard,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { AllergiesPicker } from "@/components/preference-pickers/AllergiesPicker";
import { CuisinePicker } from "@/components/preference-pickers/CuisinePicker";
import { EatingStylesPicker } from "@/components/preference-pickers/EatingStylesPicker";
import { RecurringItemsPicker } from "@/components/preference-pickers/RecurringItemsPicker";
import { SkillLevelPicker } from "@/components/preference-pickers/SkillLevelPicker";
import { useApp } from "@/contexts/AppContext";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { PLAN_DURATION_PRESETS } from "@/lib/domain";

const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 30;

type Step2FormState = {
  householdSize: number;
  wantsLeftovers: boolean;
  planLengthDefault: number;
  cuisines: string[];
  eatingStyles: string[];
  allergiesAndAvoidances: string[];
  cookingSkill: "beginner" | "intermediate" | "advanced";
  recurringGroceryItems: string[];
  dietaryNotes: string;
};

export default function OnboardingPrefs() {
  const router = useRouter();
  const { onboardingStep2Draft, setOnboardingStep2Draft } = useApp();

  const [form, setForm] = useState<Step2FormState>(() => {
    if (onboardingStep2Draft) {
      return {
        householdSize: onboardingStep2Draft.householdSize,
        wantsLeftovers: onboardingStep2Draft.wantsLeftovers,
        planLengthDefault: onboardingStep2Draft.planLengthDefault,
        cuisines: onboardingStep2Draft.cuisines,
        eatingStyles: onboardingStep2Draft.eatingStyles,
        allergiesAndAvoidances: onboardingStep2Draft.allergiesAndAvoidances,
        cookingSkill: onboardingStep2Draft.cookingSkill,
        recurringGroceryItems: onboardingStep2Draft.recurringGroceryItems,
        dietaryNotes: onboardingStep2Draft.dietaryNotes,
      };
    }
    return {
      householdSize: 4,
      wantsLeftovers: false,
      planLengthDefault: 5,
      cuisines: [],
      eatingStyles: [],
      allergiesAndAvoidances: [],
      cookingSkill: "intermediate",
      recurringGroceryItems: [],
      dietaryNotes: "",
    };
  });

  const update = <K extends keyof Step2FormState>(
    key: K,
    value: Step2FormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleContinue = () => {
    Keyboard.dismiss();
    setOnboardingStep2Draft({
      householdSize: form.householdSize,
      wantsLeftovers: form.wantsLeftovers,
      planLengthDefault: form.planLengthDefault,
      cuisines: form.cuisines,
      eatingStyles: form.eatingStyles,
      allergiesAndAvoidances: form.allergiesAndAvoidances,
      cookingSkill: form.cookingSkill,
      recurringGroceryItems: form.recurringGroceryItems,
      dietaryNotes: form.dietaryNotes,
    });
    console.log("[onboarding-step-2] save", form);
    router.push("/onboarding-step-3");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Set your preferences" subtitle="Step 2 of 3" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Section title="Household">
          <Text style={s.subLabel}>Household size</Text>
          <Stepper
            value={form.householdSize}
            onChange={(n) => update("householdSize", n)}
            min={HOUSEHOLD_MIN}
            max={HOUSEHOLD_MAX}
            suffix={form.householdSize === 1 ? "person" : "people"}
          />

          <Text style={[s.subLabel, { marginTop: KSpacing.lg }]}>
            Plan length default
          </Text>
          <View style={s.chipRow}>
            {PLAN_DURATION_PRESETS.map((n) => (
              <Chip
                key={n}
                label={n === 1 ? "1 day" : `${n} days`}
                selected={form.planLengthDefault === n}
                onPress={() => update("planLengthDefault", n)}
              />
            ))}
          </View>
          <Text style={s.helpText}>days per plan</Text>

          <Text style={[s.subLabel, { marginTop: KSpacing.lg }]}>
            Wants leftovers
          </Text>
          <View style={s.toggleRow}>
            <Text style={s.toggleSubtitle}>
              Kiwi sizes portions to leave planned extras
            </Text>
            <Switch
              value={form.wantsLeftovers}
              onValueChange={(v) => update("wantsLeftovers", v)}
              trackColor={{
                false: KColors.neutral[400],
                true: KColors.sage[700],
              }}
              thumbColor={KColors.neutral[0]}
            />
          </View>
        </Section>

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

          <Text style={[s.subLabel, { marginTop: KSpacing.lg }]}>
            Anything else? <Text style={s.optional}>(Optional)</Text>
          </Text>
          <TextInput
            value={form.dietaryNotes}
            onChangeText={(v) => update("dietaryNotes", v)}
            placeholder="e.g., 'no cilantro', 'lower sodium'"
            placeholderTextColor={KColors.neutral[600]}
            returnKeyType="done"
            blurOnSubmit
            onSubmitEditing={Keyboard.dismiss}
            style={s.input}
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
    backgroundColor: KPalette.bg.card,
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
  optional: {
    fontWeight: KType.weight.regular,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  helpText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.xs,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
  },
  toggleSubtitle: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  input: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    textAlignVertical: "top",
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
