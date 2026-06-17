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
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
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
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
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

          <Text style={[s.subLabel, { marginTop: Spacing[4] }]}>
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

          <Text style={[s.subLabel, { marginTop: Spacing[4] }]}>
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
                false: Colors.neutral[400],
                true: Colors.sage[700],
              }}
              thumbColor={Colors.neutral[0]}
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

          <Text style={[s.subLabel, { marginTop: Spacing[4] }]}>
            Allergies & avoidances
          </Text>
          <AllergiesPicker
            value={form.allergiesAndAvoidances}
            onChange={(next) => update("allergiesAndAvoidances", next)}
          />

          <Text style={[s.subLabel, { marginTop: Spacing[4] }]}>
            Anything else? <Text style={s.optional}>(Optional)</Text>
          </Text>
          <TextInput
            value={form.dietaryNotes}
            onChangeText={(v) => update("dietaryNotes", v)}
            placeholder="e.g., 'no cilantro', 'lower sodium'"
            placeholderTextColor={Colors.neutral[600]}
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
          <Button label="Continue" variant="primary" onPress={handleContinue} />
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
      <View style={{ marginTop: Spacing[3] }}>{children}</View>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: Spacing[8] * 2,
    gap: Spacing[3],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
  },
  cardTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  cardSubtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  subLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginBottom: Spacing[2],
  },
  optional: {
    fontWeight: Typography.fontWeight.regular,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  helpText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[1],
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
  },
  toggleSubtitle: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    textAlignVertical: "top",
  },
  footer: {
    marginTop: Spacing[4],
    gap: Spacing[2],
    alignItems: "center",
  },
  footerHint: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
});
