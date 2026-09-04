import React, { useState } from "react";
import { Keyboard, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { CuisinePicker } from "@/components/preference-pickers/CuisinePicker";
import { DietarySection } from "@/components/preference-pickers/DietarySection";
import { RecurringItemsPicker } from "@/components/preference-pickers/RecurringItemsPicker";
import { SkillLevelPicker } from "@/components/preference-pickers/SkillLevelPicker";
import { useApp } from "@/contexts/AppContext";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  COOK_TIME_CAP_OPTIONS,
  COOK_TIME_COVERAGE_OPTIONS,
  DISCOVERY_MEALS_OPTIONS,
  PLAN_DURATION_PRESETS,
  SAUCE_PREFERENCE_OPTIONS,
} from "@/lib/domain";

const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 30;

type Step2FormState = {
  householdSize: number;
  planLengthDefault: number;
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: "all" | "most";
  // Cookbook Phase B Block 5 — step 2 now carries all four Phase-B fields.
  discoveryMealsPerWeek: number;
  saucePreference: "store_bought" | "balanced" | "homemade";
  cuisines: string[];
  eatingStyles: string[];
  allergiesAndAvoidances: string[];
  cookingSkill: "beginner" | "intermediate" | "advanced";
  recurringGroceryItems: string[];
  dietaryNotes: string;
  // WS9 D-WS9-206 — the new other-allergies terms. Collected here and PATCHed
  // by step 3 alongside the rest of the step-2 draft.
  otherAllergies: string[];
};

export default function OnboardingPrefs() {
  const router = useRouter();
  const { onboardingStep2Draft, setOnboardingStep2Draft } = useApp();

  const [form, setForm] = useState<Step2FormState>(() => {
    if (onboardingStep2Draft) {
      return {
        householdSize: onboardingStep2Draft.householdSize,
        planLengthDefault: onboardingStep2Draft.planLengthDefault,
        maxCookTimeMinutes: onboardingStep2Draft.maxCookTimeMinutes,
        maxCookTimeCoverage: onboardingStep2Draft.maxCookTimeCoverage,
        discoveryMealsPerWeek: onboardingStep2Draft.discoveryMealsPerWeek,
        saucePreference: onboardingStep2Draft.saucePreference,
        cuisines: onboardingStep2Draft.cuisines,
        eatingStyles: onboardingStep2Draft.eatingStyles,
        allergiesAndAvoidances: onboardingStep2Draft.allergiesAndAvoidances,
        cookingSkill: onboardingStep2Draft.cookingSkill,
        recurringGroceryItems: onboardingStep2Draft.recurringGroceryItems,
        dietaryNotes: onboardingStep2Draft.dietaryNotes,
        otherAllergies: onboardingStep2Draft.otherAllergies,
      };
    }
    return {
      householdSize: 4,
      planLengthDefault: 5,
      maxCookTimeMinutes: null,
      maxCookTimeCoverage: "most",
      discoveryMealsPerWeek: 0,
      saucePreference: "balanced",
      cuisines: [],
      eatingStyles: [],
      allergiesAndAvoidances: [],
      cookingSkill: "intermediate",
      recurringGroceryItems: [],
      dietaryNotes: "",
      otherAllergies: [],
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
      planLengthDefault: form.planLengthDefault,
      maxCookTimeMinutes: form.maxCookTimeMinutes,
      maxCookTimeCoverage: form.maxCookTimeCoverage,
      discoveryMealsPerWeek: form.discoveryMealsPerWeek,
      saucePreference: form.saucePreference,
      cuisines: form.cuisines,
      eatingStyles: form.eatingStyles,
      allergiesAndAvoidances: form.allergiesAndAvoidances,
      cookingSkill: form.cookingSkill,
      recurringGroceryItems: form.recurringGroceryItems,
      dietaryNotes: form.dietaryNotes,
      otherAllergies: form.otherAllergies,
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
            Max cook time
          </Text>
          <View style={s.chipRow}>
            {COOK_TIME_CAP_OPTIONS.map((opt) => (
              <Chip
                key={opt.label}
                label={opt.label}
                selected={form.maxCookTimeMinutes === opt.value}
                onPress={() => update("maxCookTimeMinutes", opt.value)}
              />
            ))}
          </View>
          <Text style={s.helpText}>Cap on how long a dinner should take</Text>

          {form.maxCookTimeMinutes !== null && (
            <>
              <Text style={[s.subLabel, { marginTop: Spacing[4] }]}>
                Apply the cap to
              </Text>
              <View style={s.chipRow}>
                {COOK_TIME_COVERAGE_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.value}
                    label={opt.label}
                    selected={form.maxCookTimeCoverage === opt.value}
                    onPress={() => update("maxCookTimeCoverage", opt.value)}
                  />
                ))}
              </View>
            </>
          )}

          <Text style={[s.subLabel, { marginTop: Spacing[4] }]}>
            Discovery meals
          </Text>
          <View style={s.chipRow}>
            {DISCOVERY_MEALS_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                selected={form.discoveryMealsPerWeek === opt.value}
                onPress={() => update("discoveryMealsPerWeek", opt.value)}
              />
            ))}
          </View>
          <Text style={s.helpText}>Add 1-2 novel meals to each plan</Text>
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

        {/* WS9 D-WS9-206/207 — shared <DietarySection>.
            ⚠️ THE "Allergies & avoidances" <Text> HEADING IS DELETED HERE. It
            was a BUG-196 regression: that fix moved the heading into
            AllergiesPicker's own expander and deleted the orphan label in
            preferences.tsx only, so this screen has been printing the heading
            twice ever since — once as a stray <Text>, once as the "Allergies &
            avoidances ⌄" control immediately below it.
            The "(Optional)" badge goes too — see the note in DietarySection. */}
        <Section title="Dietary preferences">
          <DietarySection
            eatingStyles={form.eatingStyles}
            onEatingStylesChange={(next) => update("eatingStyles", next)}
            allergies={form.allergiesAndAvoidances}
            onAllergiesChange={(next) => update("allergiesAndAvoidances", next)}
            otherAllergies={form.otherAllergies}
            onOtherAllergiesChange={(next) => update("otherAllergies", next)}
            dietaryNotes={form.dietaryNotes}
            onDietaryNotesChange={(v) => update("dietaryNotes", v)}
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

          <Text style={[s.subLabel, { marginTop: Spacing[4] }]}>
            Sauces and Spice Mixes Preference
          </Text>
          <View style={s.chipRow}>
            {SAUCE_PREFERENCE_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                selected={form.saucePreference === opt.value}
                onPress={() => update("saucePreference", opt.value)}
              />
            ))}
          </View>
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
  // WS9 D-WS9-206 — `optional` and `input` are DELETED with the dietary block
  // they styled. `optional` was the "(Optional)" badge, which existed on THIS
  // screen and nowhere else; `input` was the "Anything else?" TextInput, now
  // inside <DietarySection> at byte-identical values.
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  helpText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[1],
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
